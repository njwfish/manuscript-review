"""Review operations share one transaction boundary and one source projection."""
import copy
import json
import re
import secrets
from datetime import datetime, timezone
from .application import apply_record, write_file_edit, is_applied
from .comparison import compare, enrich_snapshot, make_patch, validate_decisions, build_snapshot, read_blob, stable_id
from .editing import selected_content, project_source
from .file_editing import file_replacements, replace_ranges
from .anchors import SourceSpan, SourceMap
from .feedback import feedback_report, validate_comments
from .history import add_explanations, add_responses, build_history, round_id, attach
from .previews import Previews
from .storage import ReviewStore, read_json, FileLock, atomic_json, StaleReview
from .versions import source_version, selected_version
from .documents import document_file, manuscript_files, source_point


class ReviewSession:
    def __init__(self, directory, library_url=None, review_context=None):
        self.store = ReviewStore(directory)
        self.directory = self.store.directory
        self.library_url = library_url
        self.review_context = review_context
        self.previews = Previews(self)
        self.cumulative = None
        self.cumulative_history = None
        self.comparison_lock = FileLock(self.directory / '.comparison.lock')
        with self.store.transaction():
            self.store.read()

    @property
    def snapshot(self):
        return self.store.read()['snapshot']

    def report(self):
        with self.store.transaction():
            r = self.store.read()
            return {**feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history']),
                    'baseline': r['baseline'], 'result': r['result'],
                    'previous': r['metadata'].get('previous'), 'drafts': r['drafts'], 'comparison': 'round'}

    def selected_patch(self, scope='round'):
        with self.store.transaction():
            r = self.store.read()
            return make_patch(self.comparison(r, scope), {} if scope == 'baseline' else r['decisions'])

    def comparison(self, record, scope):
        if scope in ('round', 'manuscript'):
            return copy.deepcopy(record['snapshot'])
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

    def view(self, scope='round'):
        if scope not in ('round', 'baseline', 'manuscript'):
            raise ValueError('Choose this round or since baseline.')
        with self.store.transaction():
            r = self.store.read()
        snapshot = self.comparison(r, scope)
        if scope == 'manuscript':
            snapshot['files'] = manuscript_files(r)
        history, decisions, comments = r['history'], r['decisions'], r['comments']
        if scope == 'baseline':
            with self.comparison_lock:
                key = (r['revision'], r['result'])
                if self.cumulative_history is None or self.cumulative_history[0] != key:
                    report = feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history'])
                    entries = build_history(r['snapshot'], snapshot, r, report, r['history'], self.directory)
                    self.cumulative_history = (key, entries)
                history = copy.deepcopy(self.cumulative_history[1])
            decisions = {g['id']: 'accept' for f in snapshot['files'] for g in f['edits']}
            comments = {}
        manifest = read_json(self.directory / ('renders' if scope != 'baseline' else 'baseline-renders') / 'manifest.json', {})
        valid = manifest.get('proposed') == snapshot['proposed'] and manifest.get('base') == snapshot['base']
        passages = manifest.get('passages', {}) if valid else {}
        status_key = 'preview_status' if scope != 'baseline' else 'baseline_preview_status'
        error_key = 'preview_error' if scope != 'baseline' else 'baseline_preview_error'
        preview_status = r['metadata'].get(status_key, 'queued' if snapshot['entry'] else 'none')
        if scope == 'baseline' and not valid:
            preview_status = 'queued' if snapshot['entry'] else 'none'
        for f in snapshot['files']:
            for h in f['hunks']:
                h['rendered'] = passages.get(h['id'], {})
        context = self.review_context() if self.review_context else {}
        return {**snapshot, **r['metadata'], **context, 'base': snapshot['base'], 'proposed': snapshot['proposed'],
                'revision': r['revision'], 'decisions': decisions, 'comments': comments,
                'history': history, 'drafts': r['drafts'], 'ui': r['ui'], 'round_id': round_id(snapshot),
                'scope': scope, 'baseline': r['baseline'], 'result': r['result'],
                'preview_status': preview_status, 'preview_error': r['metadata'].get(error_key),
                'proposal_label': (f'Selected manuscript ({r["result"][:7]})' if scope == 'baseline' else r['metadata']['proposal_label']),
                'base_label': (r['metadata'].get('baseline_label', r['metadata']['base_label']) if scope == 'baseline' else r['metadata']['base_label']),
                'applied': is_applied(r),
                'library_url': self.library_url, 'feedback_path': str(self.store.path)}

    def save_ui(self, ui):
        if not isinstance(ui, dict) or 'drafts' in ui or len(json.dumps(ui)) > 2_000_000:
            raise ValueError('Invalid review position.')
        with self.store.transaction():
            record = self.store.read()
            record['ui'] = ui
            self.store.commit(record)
        return {'message': 'Review position saved.'}

    def editor(self, path):
        """The selected file and its retained draft, with exact editor highlights."""
        with self.store.transaction():
            record = self.store.read()
        file = document_file(record, path)
        projected = project_source(file, record['decisions'])
        original = projected.content or ''
        draft = record['drafts'].get(path)
        text = draft['text'] if draft else original
        mapping = SourceMap(original, text)
        def offset(point):
            return len(text[:point].encode('utf-16-le')) // 2
        ranges = []
        for group in file['edits']:
            span = mapping.project(SourceSpan(*projected.ranges[group['id']]))
            ranges.append({'id': group['id'], 'from': offset(span.start), 'to': offset(span.end),
                           'rejected': record['decisions'].get(group['id']) == 'reject'})
        notes = []
        sources = {}
        for entry in record['history']:
            if entry['file'] != path:
                continue
            anchor = entry['anchor']
            version = anchor['revision']
            if version not in sources:
                sources[version] = SourceMap(read_blob(record['snapshot']['repo'], version, path) or '', text)
            span = sources[version].project(SourceSpan(anchor['start'], anchor['end']))
            notes.append({'id': entry['id'], 'from': offset(span.start), 'to': offset(span.end), 'note': True})
        return {'revision': record['revision'], 'file': path, 'source': draft['source'] if draft else record['result'],
                'original': original, 'text': text, 'ranges': ranges, 'notes': notes}

    def save_note(self, request):
        """Use ordinary discussion entries for comments on any source selection."""
        with self.store.transaction():
            record = self.store.read()
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
                path, text, source = request['file'], request['text'], request['source']
                file = document_file(record, path)
                draft = record['drafts'].get(path)
                if (not isinstance(text, str) or len(text) > 1_000_000
                        or source != (draft['source'] if draft else record['result'])):
                    self.store.backup_request(request)
                    raise ValueError('The manuscript changed. Your comment is retained; reload before continuing.')
                start, end = source_point(text, request['start']), source_point(text, request['end'])
                if end < start:
                    raise ValueError('Invalid comment selection.')
                snapshot = record['snapshot']
                pinned = source_version(snapshot['repo'], record['result'], {path: text},
                                        'refs/manuscript-review/' + record['metadata']['id'] + '/notes',
                                        'Manuscript Review comment source')
                identifier = stable_id('discussion', [record['metadata']['id'], secrets.token_hex(16)])
                parent = next((entry for entry in record['history'] if entry['id'] == request.get('parent')), None)
                if request.get('parent') and (parent is None or parent['file'] != path):
                    raise ValueError('The original comment is not in this file.')
                breaks = list(re.finditer(r'\r?\n\r?\n', text))
                left = max((match.end() for match in breaks if match.end() <= start), default=0)
                right = min((match.start() for match in breaks if match.start() >= end), default=len(text))
                entry = {'id': identifier, 'author': 'user', 'origin_id': parent['origin_id'] if parent else identifier,
                         'origin_review': str(self.directory), 'created': datetime.now(timezone.utc).isoformat(),
                         'round_id': round_id(snapshot), 'base': snapshot['base'], 'source_proposed': pinned,
                         'kind': 'source', 'file': path, 'line': text[:start].count('\n') + 1, 'passage': None,
                         'decision': 'settled', 'before': text[start:end], 'proposed': text[start:end],
                         'context_before': text[left:right], 'context_proposed': text[left:right], 'comment': comment,
                         'anchor': {'revision': pinned, 'start': start, 'end': end}, 'target': None, 'replies': []}
                mapped = SourceMap(text, file['before'] or '').project(SourceSpan(start, end))
                attachment = {**entry, 'anchor': {'revision': snapshot['base'], 'start': mapped.start, 'end': mapped.end}}
                attach(attachment, file)
                entry['target'] = attachment['target']
                record['history'].append(entry)
            record['revision'] += 1
            self.store.commit(record)
            return {'revision': record['revision'], 'entry': entry, 'message': 'Comment saved.'}

    def save_draft(self, request):
        with self.store.transaction():
            record = self.store.read()
            self.check_revision(request, record)
            identifier, draft = request['id'], request['draft']
            discard_saved = draft is None and identifier in record['drafts']
            file = None if discard_saved else document_file(record, identifier)
            if draft is not None:
                if (not isinstance(draft, dict) or draft.get('file') != identifier
                        or set(draft) != {'file', 'source', 'text'}
                        or not isinstance(draft['text'], str) or len(draft['text']) > 1_000_000
                        or not isinstance(draft['source'], str) or len(draft['source']) != 40):
                    raise ValueError('A draft needs its pinned source and at most 1,000,000 characters.')
                if (read_blob(record['snapshot']['repo'], draft['source'], identifier) or '') != (selected_content(file, record['decisions']) or ''):
                    raise ValueError('The selected wording changed. Your draft is retained; reload before editing.')
            previous = record['drafts'].get(identifier)
            if draft != previous:
                if draft is None:
                    record['drafts'].pop(identifier, None)
                else:
                    record['drafts'][identifier] = draft
                record['revision'] += 1
                self.store.commit(record)
            return {'revision': record['revision'], 'message': 'Draft saved.' if draft is not None else 'Draft discarded.'}

    def import_responses(self, records, revision):
        with self.store.transaction():
            r = self.store.read()
            self.check_revision({'revision': revision, 'responses': records}, r)
            if not isinstance(records, list):
                raise ValueError('Responses must be a list of {id, text} records.')
            identifiers = {row.get('id') for row in records if isinstance(row, dict) and isinstance(row.get('id'), str)}
            report = feedback_report(r['snapshot'], r['decisions'], r['comments'], r['history'])
            notes = {n['id']: n['comment'] for n in report['comments'] if n['discussion_id'] in identifiers}
            state = {**r, 'comments': notes}
            selected = feedback_report(r['snapshot'], r['decisions'], notes, r['history'])
            entries = build_history(r['snapshot'], r['snapshot'], state, selected, r['history'], self.directory)
            r['history'] = add_responses(entries, records)
            r['comments'] = {key: text for key, text in r['comments'].items() if key not in notes}
            r['revision'] += 1
            self.store.commit(r)
            return {'history': r['history'], 'comments': r['comments'], 'revision': r['revision']}

    def import_explanations(self, records, revision):
        with self.store.transaction():
            r = self.store.read()
            self.check_revision({'revision': revision, 'explanations': records}, r)
            entries = add_explanations(r['snapshot'], r['decisions'], r['history'], records, self.directory)
            if entries != r['history']:
                r['history'] = entries
                r['revision'] += 1
                self.store.commit(r)
            return {'history': r['history'], 'revision': r['revision']}

    def check_revision(self, request, previous):
        if type(request.get('revision')) is not int or request['revision'] != previous['revision']:
            self.store.backup_request(request)
            raise StaleReview('This review changed in another window. Your draft was retained. Reload to continue.')

    def update(self, action, request):
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
            record = copy.deepcopy(previous)
            record.update(decisions=request['decisions'], comments=request['comments'], revision=previous['revision'] + 1)
            record['result'] = selected_version(record)
            if action == 'save':
                self.store.commit(record)
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
        view = self.view()
        return {**result, 'revision': view['revision'], 'data': view}

    def revise_file(self, previous, record, request):
        path, text, source = request['file'], request['text'], request['source']
        old = previous['snapshot']
        file = document_file(previous, path)
        if file is None or not isinstance(text, str) or len(text) > 1_000_000:
            raise ValueError('Choose a reviewed file with at most 1,000,000 characters.')
        if not isinstance(source, str) or len(source) != 40 or (read_blob(old['repo'], source, path) or '') != (selected_content(file, record['decisions']) or ''):
            raise ValueError('The editor source changed. Your draft is retained; reload before saving.')
        replacements, selected_replacements = file_replacements(file, record['decisions'], text)
        if not replacements:
            record['drafts'].pop(path, None)
            self.store.commit(record)
            return {'message': 'No source changes to save.'}
        after = replace_ranges(file['after'] or '', replacements)
        current = record['snapshot']
        revised = enrich_snapshot({'files': [compare(path, file['before'], after)]})['files'][0]
        current['files'] = [f for f in current['files'] if f['path'] != path] + [revised]
        current['files'] = [f for f in current['files'] if f['before'] != f['after']]
        current['proposed'] = source_version(old['repo'], old['proposed'], {path: after},
                                            'refs/manuscript-review/' + record['metadata']['id'] + '/versions',
                                            'Manuscript Review file revision')
        changed = [SourceSpan(start, end) for start, end, _ in replacements]
        affected = {item['id'] for item in [*file['edits'], *file['hunks']]
                    if any(span.overlaps(SourceSpan(*item['proposal_span'])) for span in changed)}
        valid = {g['id'] for f in current['files'] for g in f['edits']}
        valid_notes = valid | {h['id'] for f in current['files'] for h in f['hunks']}
        if set(record['decisions']) - affected - valid:
            raise ValueError('The revision changes another decision’s alignment. Your draft is retained; revise a smaller region.')
        archived = {key: value for key, value in record['comments'].items() if key in affected or key not in valid_notes}
        state = {**record, 'comments': archived}
        report = feedback_report(old, record['decisions'], archived, record['history'])
        record['history'] = build_history(old, current, state, report, record['history'], self.directory)
        old_edits = {g['id'] for g in file['edits']} - affected
        record['decisions'] = {key: value for key, value in record['decisions'].items() if key in valid and key not in affected}
        for group in revised['edits']:
            if group['id'] not in old_edits:
                record['decisions'][group['id']] = 'accept'
        if selected_content(revised, record['decisions']) != text:
            raise ValueError('The revision could not preserve all selected wording. Your draft is retained; revise a smaller region.')
        record['comments'] = {key: value for key, value in record['comments'].items() if key not in archived}
        record['drafts'].pop(path, None)
        record['result'] = selected_version(record)
        record['metadata'].update(preview_status='queued' if current['entry'] else 'none',
                                  proposal_label=f'Your revision ({current["proposed"][:7]})')
        self.store.archive(previous)
        write_file_edit(self.store, previous, record, file, selected_replacements, request['decisions'])
        if current['entry']:
            self.previews.queue()
        return {'message': f'Saved changes to {path} and refreshed the word diff.'}

    def resume_previews(self):
        with self.store.transaction():
            if self.store.read()['metadata']['preview_status'] in ('queued', 'rendering'):
                self.previews.queue()
