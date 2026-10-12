"""Review operations share one transaction boundary and one source projection."""
import copy
import json
import re
from bisect import bisect_left
from collections import OrderedDict
import secrets
import subprocess
from datetime import datetime, timezone
from .application import apply_record, write_file_edit, is_applied, repository_lock, digest
from .comparison import compare, enrich_snapshot, make_patch, validate_decisions, build_snapshot, read_blob, stable_id, git
from .editing import selected_content, project_source
from .file_editing import file_replacements, replace_ranges
from .anchors import SourceSpan, SourceMap
from .feedback import feedback_report, feedback_record, validate_comments
from .history import add_explanations, add_responses, build_history, round_id, attach
from .previews import Previews, preview_assets
from .storage import ReviewStore, read_json, FileLock, atomic_json, StaleReview
from .versions import source_version, selected_version
from .documents import document_file, manuscript_files, source_point, saved_source, review_payload
from .render_latex import RENDER_VERSION
from .workspace import edit_checkout, working_directory, same_repository
from .merging import merge_text
from .source_editing import saved_edits


def local_edit_label(label, version):
    label = re.sub(r'(?: \+ local edits)? \([a-f0-9]{7,40}\)$', '', label)
    return f'{label} + local edits ({version[:7]})'


class ReviewSession:
    def __init__(self, directory, library_url=None, review_context=None, *, store=None):
        self.store = store if store is not None else ReviewStore(directory)
        self.directory = self.store.directory
        self.library_url = library_url
        self.review_context = review_context
        self.previews = Previews(self)
        self.cumulative = None
        self.cumulative_history = None
        self.status_cache = None
        self.note_sources = OrderedDict()
        self.note_versions = OrderedDict()
        self.editor_files = OrderedDict()
        self.comparison_lock = FileLock(self.directory / '.comparison.lock')
        with self.store.transaction():
            self.store.read(lambda record: None)

    @property
    def snapshot(self):
        return self.store.read()['snapshot']

    def report(self, thread=None):
        with self.store.transaction():
            r = self.store.read()
            report = {**feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history'], r['metadata']['id'], r['resolved']),
                      'revision': r['revision'], 'baseline': r['baseline'], 'result': r['result'],
                      'previous': r['metadata'].get('previous'), 'workspace': str(working_directory(r)),
                      'drafts': r['drafts'], 'comparison': 'round'}
            if thread:
                notes = [*report['comments'], *report['history']]
                selected = next((note for note in notes if thread in (note['id'], note.get('discussion_id'), note['thread_id'])), None)
                if selected is None:
                    raise ValueError('Choose a saved discussion thread.')
                for key in ('comments', 'history'):
                    report[key] = [note for note in report[key] if note['thread_id'] == selected['thread_id']]
                report['edits'] = [edit for edit in report['edits'] if edit['file'] == selected['file']]
                report['drafts'] = {key: value for key, value in report['drafts'].items() if key == selected['file']}
            return report

    def agent_request(self, request):
        from .dispatch import comment_task
        with self.store.transaction():
            record = self.store.read(feedback_record)
            self.check_revision(request, record)
            return comment_task(record, self.directory, request['id'], skill=request.get('skill'),
                                launcher=request.get('launcher'))

    def dispatch_task(self, request):
        """Prepare authoring and the canonical discussion in one checked transaction."""
        from .dispatch import comment_note
        with self.store.transaction():
            if request.get('authoring'):
                record = self.store.read(feedback_record)
                self.check_revision(request, record)
                note = comment_note(record, request['id'])
                revision, _ = self._enter_authoring(request)
                request = {**request, 'revision': revision, 'id': note.get('discussion_id', note['id'])}
            return self.agent_request(request)

    def selected_patch(self, scope='round'):
        with self.store.transaction():
            r = self.store.read()
            return make_patch(self.comparison(r, scope), {} if scope == 'baseline' else r['decisions'])

    def comparison(self, record, scope):
        if scope in ('round', 'manuscript'):
            return record['snapshot']
        with self.comparison_lock:
            if self.cumulative is None or self.cumulative[0] != record['result']:
                current = record['snapshot']
                cache = self.directory / 'comparisons' / (record['baseline'] + '-' + record['result'] + '.json')
                snapshot = read_json(cache, {})
                if (snapshot.get('base'), snapshot.get('proposed'), snapshot.get('repo')) != (record['baseline'], record['result'], current['repo']):
                    if (record['baseline'], record['result']) == (current['base'], current['proposed']):
                        snapshot = copy.deepcopy(current)
                    else:
                        snapshot = build_snapshot(current['repo'], record['baseline'], record['result'], text_only=True)
                    atomic_json(cache, snapshot)
                snapshot.update(source_head=current['source_head'], entry=current['entry'], token=current['token'])
                self.cumulative = (record['result'], snapshot)
            return copy.deepcopy(self.cumulative[1])

    def view(self, scope='round', file=None, *, interactive=False):
        if scope not in ('round', 'baseline', 'manuscript'):
            raise ValueError('Choose this round or since baseline.')
        with self.store.transaction():
            if interactive and scope == 'round':
                r, applied = self.store.read(lambda record: ({**record, 'snapshot': review_payload(
                    {**record['snapshot'], 'comments': record['comments']}, file)}, is_applied(record)))
            else:
                r = self.store.read()
                applied = is_applied(r)
        snapshot = self.comparison(r, scope)
        if scope == 'manuscript':
            snapshot['files'] = manuscript_files(r)
        history, decisions, comments = r['history'], r['decisions'], r['comments']
        if scope == 'baseline':
            with self.comparison_lock:
                key = (r['revision'], r['result'])
                if self.cumulative_history is None or self.cumulative_history[0] != key:
                    report = feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history'], r['metadata']['id'])
                    entries = build_history(r['snapshot'], snapshot, r, report, r['history'], self.directory)
                    self.cumulative_history = (key, entries)
                history = copy.deepcopy(self.cumulative_history[1])
            decisions = {g['id']: 'accept' for f in snapshot['files'] for g in f['edits']}
            comments = {}
        manifest = read_json(self.directory / ('renders' if scope != 'baseline' else 'baseline-renders') / 'manifest.json', {})
        valid = (manifest.get('base'), manifest.get('proposed'), manifest.get('renderer')) == (snapshot['base'], snapshot['proposed'], RENDER_VERSION)
        passages = manifest.get('passages', {}) if valid else {}
        status_key = 'preview_status' if scope != 'baseline' else 'baseline_preview_status'
        error_key = 'preview_error' if scope != 'baseline' else 'baseline_preview_error'
        preview_status = r['metadata'].get(status_key, 'queued' if snapshot['entry'] else 'none')
        if not valid:
            preview_status = 'queued' if snapshot['entry'] else 'none'
        for f in snapshot['files']:
            for h in f['hunks']:
                h['rendered'] = passages.get(h['id'], {})
        context = self.review_context() if self.review_context else {}
        result = {**snapshot, **r['metadata'], **context, 'base': snapshot['base'], 'proposed': snapshot['proposed'],
                'revision': r['revision'], 'decisions': decisions, 'comments': comments,
                'history': history, 'resolved': r['resolved'], 'drafts': r['drafts'], 'ui': r['ui'], 'round_id': round_id(snapshot),
                'scope': scope, 'baseline': r['baseline'], 'result': r['result'],
                'documents': manifest.get('documents', {}) if valid else {},
                'preview_status': preview_status, 'preview_error': r['metadata'].get(error_key),
                'proposal_label': (f'Selected manuscript ({r["result"][:7]})' if scope == 'baseline' else r['metadata']['proposal_label']),
                'base_label': (r['metadata'].get('baseline_label', r['metadata']['base_label']) if scope == 'baseline' else r['metadata']['base_label']),
                'applied': applied,
                'library_url': self.library_url, 'feedback_path': str(self.store.path)}
        return review_payload(result, file) if interactive else result

    def summary(self):
        """Sidebar state has no source, preview, or discussion bodies."""
        def select(record):
            snapshot, metadata = record['snapshot'], record['metadata']
            ids = [edit['id'] for file in snapshot['files'] for edit in file['edits']]
            done = sum(record['decisions'].get(identifier, 'pending') != 'pending' for identifier in ids)
            origins = {entry.get('origin_id') or entry['id'] for entry in record['history'] if entry['comment'].strip()}
            origins.update(metadata['id'] + ':' + key for key, text in record['comments'].items() if text.strip())
            return {**metadata, 'repo': snapshot['repo'], 'base': snapshot['base'], 'proposed': snapshot['proposed'], 'entry': snapshot['entry'],
                    'revision': record['revision'], 'result': record['result'], 'baseline': record['baseline'],
                    'progress': {'total': len(ids), 'done': done, 'complete': done == len(ids)},
                    'unresolved': len(origins - set(record['resolved'])), 'drafts': list(record['drafts']),
                    'applied': is_applied(record)}
        with self.store.transaction():
            return self.store.read(select)

    def save_ui(self, ui):
        if not isinstance(ui, dict) or 'drafts' in ui or len(json.dumps(ui)) > 2_000_000:
            raise ValueError('Invalid review position.')
        with self.store.transaction():
            self.store.patch({'ui': ui})
        return {'message': 'Review position saved.'}

    def _status(self):
        with self.store.transaction():
            stat = self.store.path.stat()
            version = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            if self.status_cache is None or self.status_cache[0] != version:
                state = self.store.read(lambda record: {**record['metadata'], 'revision': record['revision'],
                    'base': record['snapshot']['base'], 'proposed': record['snapshot']['proposed'],
                    'entry': record['snapshot']['entry'], 'baseline': record['baseline'], 'result': record['result']})
                self.status_cache = (version, state)
            result = dict(self.status_cache[1])
        return result

    def status(self):
        state = self._status()
        return {'id': state['id'], 'revision': state['revision'], 'authoring': state.get('authoring', False),
                **(self.review_context() if self.review_context else {})}

    def preview(self, scope='round'):
        if scope not in ('round', 'baseline', 'manuscript'):
            raise ValueError('Choose this round or since baseline.')
        state = self._status()
        baseline = scope == 'baseline'
        base, proposed = (state['baseline'], state['result']) if baseline else (state['base'], state['proposed'])
        manifest = read_json(self.directory / ('baseline-renders' if scope == 'baseline' else 'renders') / 'manifest.json', {})
        valid = (manifest.get('base'), manifest.get('proposed'), manifest.get('renderer')) == (base, proposed, RENDER_VERSION)
        status = state.get('baseline_preview_status' if baseline else 'preview_status', 'queued')
        return {'base': base, 'proposed': proposed,
                'preview_status': status if valid else 'queued' if state.get('entry') else 'none',
                'preview_error': state.get('baseline_preview_error' if baseline else 'preview_error'),
                'documents': manifest.get('documents', {}) if valid else {},
                'passages': preview_assets(manifest.get('passages', {})) if valid else {}}

    def editor(self, path, text=None, point=None, version=None):
        """Project review spans onto selected wording or an exact external buffer."""
        with self.store.transaction():
            record = self.store.read(lambda record: {**record, 'snapshot': {**record['snapshot'],
                'files': [file for file in record['snapshot']['files'] if file['path'] == path]},
                'history': [entry for entry in record['history'] if entry['file'] == path]})
        if version is None:
            file = next(iter(record['snapshot']['files']), None)
            if file is None:
                file = self._document_file(record, path)
        else:
            saved = saved_source(record, path, version)
            file = next((file for file in record['snapshot']['files'] if file['path'] == path), None)
            if file is None:
                file = enrich_snapshot({'files': [compare(path, saved['text'], saved['text'])]})['files'][0]
        projected = project_source(file, record['decisions'])
        original = projected.content or ''
        draft = record['drafts'].get(path)
        if text is None:
            text = draft['text'] if draft else original
        elif not isinstance(text, str) or len(text) > 1_000_000:
            raise ValueError('An editor buffer needs at most 1,000,000 characters.')
        text.encode('utf-16-le')
        mapping = SourceMap(original, text)
        supplementary = [match.start() for match in re.finditer(r'[^\u0000-\uFFFF]', text)]
        def offset(point):
            return point + bisect_left(supplementary, point)
        ranges = []
        for group in file['edits']:
            span = mapping.project(SourceSpan(*projected.ranges[group['id']]))
            ranges.append({'id': group['id'], 'from': offset(span.start), 'to': offset(span.end),
                           'rejected': record['decisions'].get(group['id']) == 'reject'})
        baseline = SourceMap(file['before'] or '', text)
        passages = []
        for passage in file['hunks']:
            span = baseline.project(SourceSpan(*passage['base_span']))
            passages.append({'id': passage['id'], 'from': offset(span.start), 'to': offset(span.end)})
        notes = []
        sources = {}
        for entry in record['history']:
            if entry['file'] != path:
                continue
            anchor = entry['anchor']
            version = anchor['revision']
            if version not in sources:
                key = (record['snapshot']['repo'], version, path)
                with self.store.transaction():
                    if key not in self.note_sources:
                        self.note_sources[key] = read_blob(*key)
                    self.note_sources.move_to_end(key)
                    source = self.note_sources[key]
                    while len(self.note_sources) > 32:
                        self.note_sources.popitem(last=False)
                sources[version] = SourceMap(source or '', text), source is None
            note_mapping, missing = sources[version]
            span = note_mapping.project(SourceSpan(anchor['start'], anchor['end']))
            if missing and entry['before']:
                start = text.find(entry['before'])
                if start >= 0 and text.find(entry['before'], start + 1) < 0:
                    span = SourceSpan(start, start + len(entry['before']))
            notes.append({'id': entry['id'], 'from': offset(span.start), 'to': offset(span.end), 'note': True})
        position = None
        if point is not None:
            start = source_point(original, point)
            position = offset(mapping.project(SourceSpan(start, start)).start)
        return {'revision': record['revision'], 'file': path, 'source': draft['source'] if draft else record['result'],
                'original': original, 'text': text, 'ranges': ranges, 'passages': passages, 'notes': notes, 'position': position}

    def _document_file(self, record, path):
        """Share immutable unchanged-file comparisons between projection and comments."""
        existing = next((file for file in record['snapshot']['files'] if file['path'] == path), None)
        if existing is not None:
            return existing
        snapshot = record['snapshot']
        key = (snapshot['repo'], snapshot['base'], snapshot['proposed'], path)
        with self.store.transaction():
            if key not in self.editor_files:
                self.editor_files[key] = document_file(record, path)
            self.editor_files.move_to_end(key)
            while len(self.editor_files) > 8:
                self.editor_files.popitem(last=False)
            return self.editor_files[key]

    def save_note(self, request):
        """Use ordinary discussion entries for comments on any source selection."""
        with self.store.transaction():
            record = self.store.read(lambda record: {**record, 'snapshot': {**record['snapshot'],
                'files': [file for file in record['snapshot']['files'] if file['path'] == request.get('file')]}})
            self.check_revision(request, record)
            comment = request['comment']
            if not isinstance(comment, str) or len(comment) > 20_000:
                raise ValueError('Comments must be text of at most 20,000 characters.')
            identifier = request.get('id')
            if identifier:
                entry = next((entry for entry in record['history'] if entry['id'] == identifier), None)
                if not entry or entry['kind'] != 'source' or entry['author'] != 'user' or entry['replies']:
                    raise ValueError('This comment already has a response. Leave a follow-up instead.')
                if entry['comment'] == comment:
                    return {'revision': record['revision'], 'entry': entry, 'message': 'Comment saved.'}
                entry['comment'] = comment
                if not comment.strip():
                    record['history'].remove(entry)
            else:
                if not comment.strip():
                    return {'revision': record['revision'], 'entry': None, 'message': 'Comment cleared.'}
                identifier = stable_id('discussion', [record['metadata']['id'], secrets.token_hex(16)])
                entry = self._source_note(record, request, 'user', identifier)
                record['history'].append(entry)
            record['revision'] += 1
            self.store.patch({'revision': record['revision'], 'history': record['history']})
            return {'revision': record['revision'], 'entry': entry, 'message': 'Comment saved.'}

    def _source_note(self, record, request, author, identifier):
        """Capture source context once for editor comments and imported feedback."""
        path, text, source = request['file'], request['text'], request['source']
        draft = record['drafts'].get(path)
        if (not isinstance(text, str) or len(text) > 1_000_000
                or source != (draft['source'] if draft else record['result'])):
            self.store.backup_request(request)
            raise ValueError('The manuscript changed. Your comment is retained; reload before continuing.')
        start, end = source_point(text, request['start']), source_point(text, request['end'])
        if end < start:
            raise ValueError('Invalid comment selection.')
        parent = next((entry for entry in record['history'] if entry['id'] == request.get('parent')), None)
        if request.get('parent') and (parent is None or parent['file'] != path):
            raise ValueError('The original comment is not in this file.')
        try:
            file = self._document_file(record, path)
            selected = selected_content(file, record['decisions'])
        except ValueError:
            if parent is None:
                raise
            saved = saved_source(record, path)
            file = enrich_snapshot({'files': [compare(path, saved['text'], saved['text'])]})['files'][0]
            selected = None
        snapshot = record['snapshot']
        reference = 'refs/manuscript-review/' + record['metadata']['id'] + '/notes'
        key = (snapshot['repo'], record['result'], path, text)
        if key not in self.note_versions:
            if selected == text:
                pinned = record['result']
                git(snapshot['repo'], 'update-ref', reference + '/' + pinned, pinned)
            else:
                pinned = source_version(snapshot['repo'], record['result'], {path: text}, reference,
                                        'Manuscript Review comment source')
            self.note_versions[key] = pinned
        self.note_versions.move_to_end(key)
        pinned = self.note_versions[key]
        while len(self.note_versions) > 16:
            self.note_versions.popitem(last=False)
        breaks = list(re.finditer(r'\r?\n\r?\n', text))
        left = max((match.end() for match in breaks if match.end() <= start), default=0)
        right = min((match.start() for match in breaks if match.start() >= end), default=len(text))
        entry = {'id': identifier, 'author': author, 'origin_id': parent['origin_id'] if parent else identifier,
                 'origin_review': str(self.directory), 'created': datetime.now(timezone.utc).isoformat(),
                 'round_id': round_id(snapshot), 'base': snapshot['base'], 'source_proposed': pinned,
                 'kind': 'source', 'file': path, 'line': text[:start].count('\n') + 1, 'passage': None,
                 'decision': 'settled', 'before': text[start:end], 'proposed': text[start:end],
                 'context_before': text[left:right], 'context_proposed': text[left:right], 'comment': request['comment'],
                 'anchor': {'revision': pinned, 'start': start, 'end': end}, 'target': None, 'replies': []}
        mapped = SourceMap(text, file['before'] or '').project(SourceSpan(start, end))
        attachment = {**entry, 'anchor': {'revision': snapshot['base'], 'start': mapped.start, 'end': mapped.end}}
        attach(attachment, file)
        entry['target'] = attachment['target']
        return entry

    def import_annotations(self, records, revision):
        """Anchor external feedback to exact quotes without changing the manuscript."""
        with self.store.transaction():
            record = self.store.read()
            self.check_revision({'revision': revision, 'annotations': records}, record)
            if not isinstance(records, list):
                raise ValueError('Annotations must be a list of {file, quote, text} records, with an optional line.')
            requests = []
            sources = {}
            for row in records:
                if (not isinstance(row, dict) or not {'file', 'quote', 'text'} <= row.keys()
                        or row.keys() - {'file', 'quote', 'text', 'line'}
                        or not all(isinstance(row[key], str) and row[key].strip() for key in ('file', 'quote', 'text'))
                        or len(row['text']) > 20_000
                        or ('line' in row and (type(row['line']) is not int or row['line'] < 1))):
                    raise ValueError('Each annotation needs a file, exact quote, and text; line must be a positive integer.')
                path = row['file']
                if path not in sources:
                    file = document_file(record, path)
                    draft = record['drafts'].get(path)
                    sources[path] = (draft['text'], draft['source']) if draft else (selected_content(file, record['decisions']) or '', record['result'])
                text, source = sources[path]
                if len(text) > 1_000_000:
                    raise ValueError('Comments support source files of at most 1,000,000 characters.')
                matches = [match.start() for match in re.finditer('(?=' + re.escape(row['quote']) + ')', text)]
                if 'line' in row:
                    lines = [0, *[match.end() for match in re.finditer('\n', text)], len(text) + 1]
                    line = row['line']
                    matches = [start for start in matches if line < len(lines) and lines[line-1] <= start < lines[line]]
                if len(matches) != 1:
                    raise ValueError(f'{path}: the quote must match exactly once. Include more context or its starting line.')
                start, end = matches[0], matches[0] + len(row['quote'])
                offset = lambda point: len(text[:point].encode('utf-16-le')) // 2
                identifier = stable_id('discussion', [record['baseline'], 'agent', path, text, str(start), str(end), row['text']])
                requests.append((identifier, {'file': path, 'source': source, 'text': text,
                                              'start': offset(start), 'end': offset(end), 'comment': row['text']}))
            count = len(record['history'])
            existing = {entry['id'] for entry in record['history']}
            for identifier, request in requests:
                if identifier not in existing:
                    record['history'].append(self._source_note(record, request, 'agent', identifier))
                    existing.add(identifier)
            if len(record['history']) > count:
                record['revision'] += 1
                self.store.commit(record)
            return {'history': record['history'], 'revision': record['revision']}

    def save_draft(self, request):
        with self.store.transaction():
            record = self.store.read(lambda record: {**record, 'snapshot': {**record['snapshot'],
                'files': [file for file in record['snapshot']['files'] if file['path'] == request['id']]}})
            self.check_revision(request, record)
            identifier, draft = request['id'], request['draft']
            discard_saved = draft is None and identifier in record['drafts']
            if not discard_saved:
                self._document_file(record, identifier)
            if draft is not None:
                if (not isinstance(draft, dict) or draft.get('file') != identifier
                        or set(draft) != {'file', 'source', 'text'}
                        or not isinstance(draft['text'], str) or len(draft['text']) > 1_000_000
                        or not isinstance(draft['source'], str) or len(draft['source']) != 40):
                    raise ValueError('A draft needs its pinned source and at most 1,000,000 characters.')
                # Retain the editor's exact input version even when a parallel
                # proposal arrived. Saving the file performs the three-way merge.
                git(record['snapshot']['repo'], 'rev-parse', '--verify', draft['source'] + '^{commit}')
            previous = record['drafts'].get(identifier)
            if draft != previous:
                if draft is None:
                    record['drafts'].pop(identifier, None)
                else:
                    record['drafts'][identifier] = draft
                record['revision'] += 1
                self.store.patch({'revision': record['revision'], 'drafts': record['drafts']})
            return {'revision': record['revision'], 'message': 'Draft saved.' if draft is not None else 'Draft discarded.'}

    def resolve_thread(self, request):
        """Resolve one discussion origin without changing wording or its messages."""
        with self.store.transaction():
            record = self.store.read(feedback_record)
            self.check_revision(request, record)
            if type(request.get('resolved')) is not bool:
                raise ValueError('Choose resolved or unresolved for this thread.')
            if not isinstance(request.get('id'), str) or not request['id']:
                raise ValueError('Choose a saved discussion thread.')
            report = feedback_report(record['snapshot'], record['decisions'], record['comments'], record['history'], record['metadata']['id'])
            entries = [*report['comments'], *report['history']]
            entry = next((entry for entry in entries if entry['thread_id'] == request['id']), None)
            if entry is None:
                entry = next((entry for entry in entries if request['id'] in (entry['id'], entry.get('discussion_id'))), None)
            if entry is None:
                raise ValueError('Choose a saved discussion thread.')
            origin = entry['thread_id']
            resolved = set(record['resolved'])
            if (origin in resolved) != request['resolved']:
                if request['resolved']:
                    resolved.add(origin)
                else:
                    resolved.discard(origin)
                record['resolved'] = sorted(resolved)
                record['revision'] += 1
                self.store.patch({'revision': record['revision'], 'resolved': record['resolved']})
            return {'revision': record['revision'], 'resolved': record['resolved'],
                    'message': 'Comment resolved.' if request['resolved'] else 'Comment reopened.'}

    def import_responses(self, records, revision):
        with self.store.transaction():
            r = self.store.read()
            self.check_revision({'revision': revision, 'responses': records}, r)
            if not isinstance(records, list):
                raise ValueError('Responses must be a list of {id, text} records.')
            identifiers = {row.get('id') for row in records if isinstance(row, dict) and isinstance(row.get('id'), str)}
            report = feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history'], r['metadata']['id'])
            notes = {n['id']: n['comment'] for n in report['comments'] if n['discussion_id'] in identifiers}
            state = {**r, 'comments': notes}
            selected = feedback_report(r['snapshot'], r['decisions'], notes, r['history'], r['metadata']['id'])
            entries = build_history(r['snapshot'], r['snapshot'], state, selected, r['history'], self.directory)
            r['history'] = add_responses(entries, records)
            r['comments'] = {key: text for key, text in r['comments'].items() if key not in notes}
            r['revision'] += 1
            self.store.patch({'revision': r['revision'], 'history': r['history'], 'comments': r['comments']})
            return {'history': r['history'], 'comments': r['comments'], 'revision': r['revision']}

    def import_explanations(self, records, revision):
        with self.store.transaction():
            r = self.store.read()
            self.check_revision({'revision': revision, 'explanations': records}, r)
            entries = add_explanations(r['snapshot'], r['decisions'], r['history'], records, self.directory, r['metadata']['id'])
            if entries != r['history']:
                r['history'] = entries
                r['revision'] += 1
                self.store.patch({'revision': r['revision'], 'history': r['history']})
            return {'history': r['history'], 'revision': r['revision']}

    def check_revision(self, request, previous):
        if type(request.get('revision')) is not int or request['revision'] != previous['revision']:
            self.store.backup_request(request)
            raise StaleReview('This review changed in another window. Your draft was retained. Reload to continue.')

    def update(self, action, request, *, interactive=False):
        if action not in ('save', 'apply', 'file'):
            raise ValueError('Unknown action.')
        with self.store.transaction():
            previous = self.store.read()
            self.check_revision(request, previous)
            snapshot = previous['snapshot']
            validate_decisions(snapshot, request['decisions'])
            validate_comments(snapshot, request['comments'])
            for draft in previous['drafts'].values():
                file = next((f for f in snapshot['files'] if f['path'] == draft['file']), None)
                if file and selected_content(file, previous['decisions']) != selected_content(file, request['decisions']):
                    raise ValueError('Save or discard the file draft before changing its review decisions.')
            if action == 'save' and request['decisions'] == previous['decisions'] and request['comments'] == previous['comments']:
                return {'revision': previous['revision'], 'message': 'Saved locally.'}
            record = dict(previous) if action == 'save' else copy.deepcopy(previous)
            record.update(decisions=request['decisions'], comments=request['comments'], revision=previous['revision'] + 1)
            record['result'] = selected_version(record)
            self.reconcile_delivery(record)
            if action == 'save':
                self.store.patch({key: record[key] for key in ('revision', 'result', 'decisions', 'comments', 'metadata')})
                return {'revision': record['revision'], 'result': record['result'], 'message': 'Saved locally.'}
            if action == 'apply':
                if record['drafts']:
                    raise ValueError('Save or discard source drafts before applying the review.')
                count = apply_record(self.store, previous, record)
                message = (f'Applied review to {count} manuscript {"file" if count == 1 else "files"}.' if count
                           else 'Review applied. The manuscript already matches your choices.')
                return {'revision': record['revision'], 'applied': is_applied(record),
                        'message': message}
            try:
                result = self.revise_file(previous, record, request)
            except Exception:
                self.store.backup_request(request)
                raise
        # Library context reads this record through another store. Fetch it only
        # after releasing the write transaction, as with an ordinary view request.
        view = self.view(file=request.get('file'), interactive=interactive)
        return {**result, 'revision': view['revision'], 'data': view}

    def revise_file(self, previous, record, request):
        path, text, source = request['file'], request['text'], request['source']
        old = previous['snapshot']
        file = document_file(previous, path)
        if file is None or not isinstance(text, str) or len(text) > 1_000_000:
            raise ValueError('Choose a reviewed file with at most 1,000,000 characters.')
        if not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{40}', source):
            raise ValueError('The editor source changed. Your draft is retained; reload before saving.')
        text = merge_text(read_blob(old['repo'], source, path) or '', selected_content(file, record['decisions']) or '', text)
        replacements, selected_replacements = file_replacements(file, record['decisions'], text)
        if not replacements:
            record['drafts'].pop(path, None)
            self.store.commit(record)
            return {'message': 'No source changes to save.'}
        after = replace_ranges(file['after'] or '', replacements)
        changed = [SourceSpan(start, end) for start, end, _ in replacements]
        revised = self.replace_proposal_file(previous, record, file, after, changed)
        if selected_content(revised, record['decisions']) != text:
            raise ValueError('The revision could not preserve all selected wording. Your draft is retained; revise a smaller region.')
        record['drafts'].pop(path, None)
        current = record['snapshot']
        record['metadata'].update(preview_status='queued' if current['entry'] else 'none',
                                  proposal_label=local_edit_label(previous['metadata']['proposal_label'], current['proposed']))
        self.store.archive(previous)
        write_file_edit(self.store, previous, record, file, selected_replacements, request['decisions'])
        if current['entry']:
            self.previews.queue()
        return {'message': f'Saved changes to {path} and refreshed the word diff.'}

    def edit_workspace(self, request):
        with self.store.transaction():
            record = self.store.read()
            self.check_revision(request, record)
            with repository_lock(record['snapshot']['repo']):
                workspace, version = edit_checkout(self.directory, record)
                if 'workspace' not in record['metadata']:
                    record['metadata'].update(workspace=str(workspace), workspace_version=version)
                    record['applied'] = {file['path']: digest(read_blob(record['snapshot']['repo'], version, file['path']))
                                         for file in record['snapshot']['files']}
                    record['snapshot']['source_head'] = git(workspace, 'rev-parse', 'HEAD').decode().strip()
                    record['revision'] += 1
                    self.store.commit(record)
            return {'revision': record['revision'], 'workspace': str(workspace), 'workspace_version': version}

    def capture_file(self, request, *, interactive=False):
        """Capture ordered saves; the final disk text is a guard, never a source write."""
        saves = request.get('saves')
        if not isinstance(saves, list) or not saves:
            raise ValueError('Provide the ordered source saves.')
        identifiers = []
        for save in saves:
            if (not isinstance(save, dict) or not isinstance(save.get('id'), str) or not re.fullmatch(r'[a-f0-9]{32}', save.get('id', ''))
                    or not isinstance(save.get('intent'), str) or save['intent'] not in saved_edits or not isinstance(save.get('text'), str)
                    or len(save['text']) > 1_000_000 or '\0' in save['text']
                    or 'editing' in save and (not isinstance(save['editing'], str) or not re.fullmatch(r'[a-f0-9]{40}', save['editing']))):
                raise ValueError('Provide identified manuscript saves with an editing intent.')
            identifiers.append(save['id'])
        if len(set(identifiers)) != len(identifiers):
            raise ValueError('Source save identities must be distinct.')
        with self.store.transaction():
            previous = self.store.read()
            self.check_revision(request, previous)
            metadata, snapshot = previous['metadata'], previous['snapshot']
            if 'workspace' not in metadata:
                raise ValueError('Open the review’s editing checkout before capturing source.')
            workspace = working_directory(previous)
            if not same_repository(workspace, snapshot['repo']):
                raise ValueError('Choose the review’s source checkout.')
            path, text = request['file'], request['text']
            if not isinstance(path, str):
                raise ValueError('Choose a manuscript source path.')
            destination = workspace / path
            if (not isinstance(text, str) or len(text) > 1_000_000 or '\0' in text
                    or not path.endswith(('.tex', '.bib', '.md', '.txt', '.typ', '.rst'))
                    or destination.is_symlink() or not destination.resolve().is_relative_to(workspace)):
                raise ValueError('Choose a regular manuscript source file of at most 1,000,000 characters.')
            if previous['drafts'].get(path):
                raise ValueError('Save or discard this file’s retained draft before capturing native edits.')
            cursor = metadata.get('source_cursors', {}).get(path)
            consumed = identifiers.index(cursor) + 1 if cursor in identifiers else 0
            if not consumed and request.get('cursor') != cursor:
                raise ValueError('This file was captured by another editor. Its saved source is retained; reopen the comparison before continuing.')
            with repository_lock(snapshot['repo']):
                head = git(workspace, 'rev-parse', 'HEAD').decode().strip()
                if head != snapshot['source_head']:
                    try:
                        git(workspace, 'merge-base', '--is-ancestor', snapshot['source_head'], head)
                    except subprocess.CalledProcessError:
                        raise ValueError('The editing checkout moved away from B. Return to the review checkout.') from None
                if not destination.is_file() or destination.read_bytes().decode() != text:
                    raise ValueError('The saved file changed again. Save its latest text before capturing the diff.')
                source = request.get('source')
                if not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{40}', source):
                    raise ValueError('Choose the saved editor source version.')
                versions = {source, *(save['editing'] for save in saves if 'editing' in save)}
                for version in versions:
                    if subprocess.run(['git', '-C', str(snapshot['repo']), 'cat-file', '-e', version + '^{commit}'],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode:
                        raise ValueError('The saved editor source version is unavailable. Your source and review are retained.')
                if not consumed and read_blob(snapshot['repo'], source, path) != read_blob(snapshot['repo'], metadata['workspace_version'], path):
                    raise ValueError('The source checkout changed. Reload this review before saving its edits.')
                record = copy.deepcopy(previous)
                changed = False
                for save in saves[consumed:]:
                    changed = self.capture_save(record, path, save) or changed
                if changed:
                    record['metadata'].update(proposal_label=local_edit_label(metadata['proposal_label'], record['snapshot']['proposed']),
                                              preview_status='queued' if record['snapshot']['entry'] else 'none')
                    record['snapshot']['source_head'] = head
                    record['revision'] += 1
                    self.store.archive(previous)
                    self.store.commit(record)
        result = {'revision': record['revision'], 'captured': identifiers[-1],
                  'cursor': record['metadata'].get('source_cursors', {}).get(path),
                  'workspace_version': record['metadata']['workspace_version']}
        if not changed:
            return {**result, 'message': 'No source changes to capture.'}
        if record['snapshot']['entry']:
            self.previews.queue()
        return {**result, 'data': self.view(file=path, interactive=interactive), 'message': f'Saved edits to {path}; comparison updated.'}

    def capture_save(self, record, path, save):
        """One buffer transition owns proposal, author base, and saved-source acknowledgement."""
        metadata, snapshot = record['metadata'], record['snapshot']
        origin = read_blob(snapshot['repo'], save.get('editing', metadata['workspace_version']), path)
        saved = save['text']
        if origin == saved and read_blob(snapshot['repo'], metadata['workspace_version'], path) == saved:
            return False
        try:
            file = document_file(record, path)
        except ValueError:
            if read_blob(snapshot['repo'], snapshot['proposed'], path) is not None:
                raise
            file = enrich_snapshot({'files': [compare(path, read_blob(snapshot['repo'], snapshot['base'], path), None)]})['files'][0]
        intent = save['intent'] if metadata.get('authoring') else 'proposal'
        plan = saved_edits[intent](file, record['decisions'], origin, saved)
        if plan['changed']:
            self.replace_proposal_file(copy.deepcopy(record), record, file, plan['proposal'], plan['changed'])
        if plan['conflict'] and path not in metadata.get('delivery_conflicts', []):
            metadata.setdefault('delivery_conflicts', []).append(path)
        if plan['author'] is not None:
            from .authoring import rebase, RebaseConflict
            base = source_version(snapshot['repo'], snapshot['base'], {path: plan['author']},
                                  'refs/manuscript-review/' + metadata['id'] + '/author',
                                  'Manuscript Review author wording')
            try:
                rebase(record, base, self.directory)
            except RebaseConflict as error:
                error.capture = {'file': path, 'save': save['id'], 'intent': 'proposal'}
                raise
        metadata = record['metadata']
        metadata['workspace_version'] = source_version(
            snapshot['repo'], metadata['workspace_version'], {path: saved},
            'refs/manuscript-review/' + metadata['id'] + '/workspace',
            'Manuscript Review saved source')
        metadata.setdefault('source_cursors', {})[path] = save['id']
        record['applied'][path] = digest(saved)
        self.reconcile_delivery(record)
        return True

    def authoring(self, request, *, interactive=False):
        revision, changed = self._enter_authoring(request)
        result = {'revision': revision}
        if changed:
            result['data'] = self.view(file=request.get('entry'), interactive=interactive)
        return result

    def _enter_authoring(self, request):
        """Enter authoring in this review; retain the earlier comparison verbatim."""
        from .authoring import rebase
        with self.store.transaction():
            state = self.store.read(lambda record: {'revision': record['revision'], 'metadata': record['metadata']})
            self.check_revision(request, state)
            if state['metadata'].get('authoring'):
                return state['revision'], False
            previous = self.store.read()
            if 'workspace' not in previous['metadata'] or previous['drafts']:
                raise ValueError('Open the editing folder and save or discard retained drafts before reviewing agent changes.')
            record = {**previous, 'metadata': dict(previous['metadata'])}
            with repository_lock(record['snapshot']['repo']):
                rebase(record, record['metadata']['workspace_version'], self.directory, proposed=record['result'])
                entry = request.get('entry')
                if (entry and record['snapshot']['entry']
                        and read_blob(record['snapshot']['repo'], record['result'], record['snapshot']['entry']) is None):
                    source = saved_source(record, entry)
                    if entry.endswith('.tex') and '\\documentclass' in source['text']:
                        record['snapshot']['entry'] = record['metadata']['entry'] = entry
                        record['metadata']['preview_status'] = 'queued'
                record['revision'] += 1
                self.store.archive(previous)
                self.store.commit(record)
        if record['snapshot']['entry']:
            self.previews.queue()
        return record['revision'], True

    def delivery(self, request):
        """Plan exact editor replacements; only the editor writes or saves buffers."""
        with self.store.transaction():
            record = self.store.read()
            self.check_revision(request, record)
        files = []
        if (record['metadata'].get('authoring') or request.get('explicit') is True) and not record['drafts']:
            for file in record['snapshot']['files']:
                if file['path'] in record['metadata'].get('delivery_conflicts', []):
                    continue
                before = read_blob(record['snapshot']['repo'], record['metadata']['workspace_version'], file['path'])
                after = selected_content(file, record['decisions'])
                if before == after or before is None or after is None or not file['path'].endswith(('.tex', '.bib', '.md', '.txt', '.typ', '.rst')):
                    continue
                if max(len(before), len(after)) > 1_000_000:
                    continue
                edits = [{'from': len(before[:a].encode('utf-16-le')) // 2,
                          'to': len(before[:b].encode('utf-16-le')) // 2, 'text': after[c:d]}
                         for tag, a, b, c, d in SourceMap(before, after).blocks if tag != 'equal']
                files.append({'file': file['path'], 'before': before, 'after': after, 'edits': edits})
        return {'revision': record['revision'], 'source': record['result'], 'files': files,
                'conflicts': record['metadata'].get('delivery_conflicts', [])}

    def merge_proposal(self, starting, proposed, publication):
        """Accumulate a parallel proposal without writing the author's working files."""
        with self.store.transaction():
            previous = self.store.read()
            old = previous['snapshot']
            repo = old['repo']
            if publication in previous['metadata'].get('publications', []):
                raise ValueError('This proposal is already incorporated. Add its reply in the current review.')
            with repository_lock(repo):
                if git(repo, 'rev-parse', proposed + '^{tree}') == git(repo, 'rev-parse', starting + '^{tree}'):
                    raise ValueError('No source changes in this proposal. Add a reply in the existing review instead.')
                changes = build_snapshot(repo, starting, proposed, text_only=True)['files']
                from .file_scope import project_paths
                paths, _ = project_paths(repo, list(filter(None, git(repo, 'diff', '--no-renames', '--name-only', '-z', starting, proposed).decode().split('\0'))))
                unsupported = set(paths) - {file['path'] for file in changes}
                if unsupported:
                    raise ValueError('This proposal contains binary or unsupported file changes: ' + ', '.join(sorted(unsupported)) + '. Keep them in its checkout and handle them in Git before publishing a text proposal. The review is unchanged.')
                if not changes:
                    raise ValueError('This proposal is already incorporated. Add its reply in the current review.')
                record = copy.deepcopy(previous)
                incorporated = False
                for change in changes:
                    current_text = read_blob(repo, previous['result'], change['path'])
                    try:
                        incoming = merge_text(change['before'], current_text, change['after'])
                    except ValueError as error:
                        raise ValueError(f"{change['path']}: proposal overlaps newer manuscript edits. Begin a fresh parallel proposal against the current review, resolve the wording there, and finish with its starting version. This proposal, the author’s source, and review are unchanged. {error}") from error
                    if incoming == current_text:
                        continue
                    incorporated = True
                    file = next((file for file in record['snapshot']['files'] if file['path'] == change['path']), None)
                    if file is None:
                        file = enrich_snapshot({'files': [compare(change['path'], read_blob(repo, old['base'], change['path']), change['before'])]})['files'][0]
                    if incoming is None or file['after'] is None:
                        after = incoming
                        changed = [SourceSpan(0, len(file['after'] or ''))]
                    else:
                        replacements, _ = file_replacements(file, record['decisions'], incoming)
                        after = replace_ranges(file['after'], replacements)
                        changed = [SourceSpan(start, end) for start, end, _ in replacements]
                    self.replace_proposal_file(copy.deepcopy(record), record, file, after, changed, accept=False)
                    if change['path'] not in record['applied']:
                        record['applied'][change['path']] = digest(read_blob(repo, old['proposed'], change['path']))
                if not incorporated:
                    metadata = dict(previous['metadata'])
                    metadata['publications'] = [*metadata.get('publications', []), publication]
                    self.store.patch({'revision': previous['revision'] + 1, 'metadata': metadata})
                    raise ValueError('This proposal is already incorporated. Add its reply in the current review.')
                record['revision'] += 1
                record['metadata'].setdefault('publications', []).append(publication)
                record['metadata'].update(proposal_label=local_edit_label(previous['metadata']['proposal_label'], record['snapshot']['proposed']),
                                          preview_status='queued' if old['entry'] else 'none')
                self.reconcile_delivery(record)
                self.store.archive(previous)
                self.store.commit(record)
        if old['entry']:
            self.previews.queue()
        return {'revision': record['revision'], 'starting_version': starting, 'proposed_version': record['snapshot']['proposed'],
                'edits': sum(len(file['edits']) for file in record['snapshot']['files']), 'baseline': record['baseline']}

    def reconcile_delivery(self, record):
        metadata = record['metadata']
        if metadata.get('delivery_conflicts'):
            repo = record['snapshot']['repo']
            metadata['delivery_conflicts'] = [path for path in metadata['delivery_conflicts']
                if read_blob(repo, metadata['workspace_version'], path) != read_blob(repo, record['result'], path)]

    def replace_proposal_file(self, previous, record, file, after, changed, accept=True):
        path, old = file['path'], previous['snapshot']
        current = record['snapshot']
        revised = enrich_snapshot({'files': [compare(path, file['before'], after)]})['files'][0]
        if any(f['path'] == path for f in current['files']):
            current['files'] = [revised if f['path'] == path else f for f in current['files']]
        else:
            current['files'].append(revised)
        current['files'] = [f for f in current['files'] if f['before'] != f['after']]
        current['proposed'] = source_version(old['repo'], old['proposed'], {path: after},
                                            'refs/manuscript-review/' + record['metadata']['id'] + '/versions',
                                            'Manuscript Review file revision')
        affected = {item['id'] for item in [*file['edits'], *file['hunks']]
                    if any(span.overlaps(SourceSpan(*item['proposal_span'])) for span in changed)}
        valid = {g['id'] for f in current['files'] for g in f['edits']}
        valid_notes = valid | {h['id'] for f in current['files'] for h in f['hunks']}
        if set(record['decisions']) - affected - valid:
            raise ValueError('The revision changes another decision’s alignment. Your draft is retained; revise a smaller region.')
        archived = {key: value for key, value in record['comments'].items() if key in affected or key not in valid_notes}
        state = {**record, 'comments': archived}
        report = feedback_report(old, record['decisions'], archived, record['history'], record['metadata']['id'])
        record['history'] = build_history(old, current, state, report, record['history'], self.directory)
        old_edits = {g['id'] for g in file['edits']} - affected
        record['decisions'] = {key: value for key, value in record['decisions'].items() if key in valid and key not in affected}
        for group in revised['edits']:
            if group['id'] not in old_edits:
                if accept:
                    record['decisions'][group['id']] = 'accept'
        record['comments'] = {key: value for key, value in record['comments'].items() if key not in archived}
        record['result'] = selected_version(record)
        return revised

    def resume_previews(self):
        with self.store.transaction():
            if self.store.read()['metadata']['preview_status'] in ('queued', 'rendering'):
                self.previews.queue()
