"""Review operations share one transaction boundary and one source projection."""
import copy
import json
from .application import apply_record, is_applied
from .comparison import compare, enrich_snapshot, make_patch, validate_decisions, build_snapshot
from .feedback import feedback_report, validate_comments
from .history import add_explanations, add_responses, build_history, round_id
from .previews import Previews
from .storage import ReviewStore, read_json, FileLock, atomic_json, StaleReview
from .versions import source_version, selected_version


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
        if scope == 'round':
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
        if scope not in ('round', 'baseline'):
            raise ValueError('Choose this round or since baseline.')
        with self.store.transaction():
            r = self.store.read()
        snapshot = self.comparison(r, scope)
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
        manifest = read_json(self.directory / ('renders' if scope == 'round' else 'baseline-renders') / 'manifest.json', {})
        valid = manifest.get('proposed') == snapshot['proposed'] and manifest.get('base') == snapshot['base']
        passages = manifest.get('passages', {}) if valid else {}
        status_key = 'preview_status' if scope == 'round' else 'baseline_preview_status'
        error_key = 'preview_error' if scope == 'round' else 'baseline_preview_error'
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
                'proposal_label': ('Selected manuscript · ' + r['result'][:7] if scope == 'baseline' else r['metadata']['proposal_label']),
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

    def save_draft(self, request):
        with self.store.transaction():
            record = self.store.read()
            self.check_revision(request, record)
            identifier, text = request['passage_id'], request['text']
            valid = {h['id'] for f in record['snapshot']['files'] for h in f['hunks']}
            discard_saved = text is None and identifier in record['drafts']
            if (identifier not in valid and not discard_saved) or (text is not None and (not isinstance(text, str) or len(text) > 200_000)):
                raise ValueError('A draft needs a current passage and at most 200,000 characters.')
            previous = record['drafts'].get(identifier)
            if text != previous:
                if text is None:
                    record['drafts'].pop(identifier, None)
                else:
                    record['drafts'][identifier] = text
                record['revision'] += 1
                self.store.commit(record)
            return {'revision': record['revision'], 'message': 'Draft saved.' if text is not None else 'Draft discarded.'}

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
        if action not in ('save', 'apply', 'passage'):
            raise ValueError('Unknown action.')
        with self.store.transaction():
            previous = self.store.read()
            self.check_revision(request, previous)
            snapshot = previous['snapshot']
            validate_decisions(snapshot, request['decisions'])
            validate_comments(snapshot, request['comments'])
            if action == 'save' and request['decisions'] == previous['decisions'] and request['comments'] == previous['comments']:
                return {'revision': previous['revision'], 'message': 'Saved locally.'}
            record = copy.deepcopy(previous)
            record.update(decisions=request['decisions'], comments=request['comments'], revision=previous['revision'] + 1)
            record['result'] = selected_version(record)
            if action == 'save':
                self.store.commit(record)
                return {'revision': record['revision'], 'message': 'Saved locally.'}
            if action == 'apply':
                if record['drafts']:
                    raise ValueError('Save or discard passage drafts before applying the review.')
                count = apply_record(self.store, previous, record)
                message = (f'Applied review to {count} manuscript {"file" if count == 1 else "files"}.' if count
                           else 'Review applied. The manuscript already matches your choices.')
                return {'revision': record['revision'], 'applied': is_applied(record),
                        'message': message}
            try:
                return self.revise_passage(previous, record, request)
            except Exception:
                self.store.backup_request(request)
                raise

    def revise_passage(self, previous, record, request):
        text = request['text']
        if not isinstance(text, str) or len(text) > 200_000:
            raise ValueError('Passage source must be text of at most 200,000 characters.')
        old = previous['snapshot']
        location = next(((f, h) for f in old['files'] for h in f['hunks'] if h['id'] == request['passage_id']), None)
        if location is None:
            raise ValueError('Unknown passage.')
        file, passage = location
        start, end = passage['proposal_span']
        after = (file['after'] or '')[:start] + text + (file['after'] or '')[end:]
        current = record['snapshot']
        revised = enrich_snapshot({'files': [compare(file['path'], file['before'], after)]})['files'][0]
        current['files'] = [revised if f['path'] == file['path'] else f for f in current['files']]
        current['files'] = [f for f in current['files'] if f['before'] != f['after']]
        current['proposed'] = source_version(old['repo'], old['proposed'], {file['path']: after},
                                            'refs/manuscript-review/' + record['metadata']['id'] + '/versions',
                                            'Manuscript Review passage revision')
        # Archive affected notes before removing their old edit identities. Earlier
        # discussion is reattached against the unchanged baseline, never rewritten.
        affected = {passage['id'], *(g['id'] for g in passage['edits'])}
        notes = {key: value for key, value in record['comments'].items() if key in affected}
        state = {**record, 'comments': notes}
        report = feedback_report(old, record['decisions'], notes, record['history'])
        record['history'] = build_history(old, current, state, report, record['history'], self.directory)
        valid = {g['id'] for f in current['files'] for g in f['edits']}
        valid_notes = valid | {h['id'] for f in current['files'] for h in f['hunks']}
        outside = set(record['decisions']) - affected
        if outside - valid:
            raise ValueError('The edit changes another decision’s alignment. Your draft is retained; revise a smaller passage or update the comparison.')
        passage_ids = {h['id'] for f in current['files'] for h in f['hunks']}
        if set(record['drafts']) - {passage['id']} - passage_ids:
            raise ValueError('The edit changes another draft’s location. Save or discard that draft first; your source is retained.')
        lost_notes = {key: value for key, value in record['comments'].items() if key not in affected and key not in valid_notes}
        if lost_notes:
            archived = {**state, 'comments': lost_notes}
            report = feedback_report(old, record['decisions'], lost_notes, record['history'])
            record['history'] = build_history(old, current, archived, report, record['history'], self.directory)
        record['decisions'] = {key: value for key, value in record['decisions'].items() if key in valid and key not in affected}
        lo, hi = passage['base_span']
        for g in revised['edits']:
            a, b = g['base_span']
            if a <= hi and b >= lo:
                record['decisions'][g['id']] = 'accept'
        record['comments'] = {key: value for key, value in record['comments'].items() if key in valid_notes and key not in affected}
        record['result'] = selected_version(record)
        record['metadata'].update(preview_status='queued' if current['entry'] else 'none',
                                  proposal_label='Your revision · ' + current['proposed'][:7])
        record['drafts'].pop(passage['id'], None)
        self.store.archive(previous)
        apply_record(self.store, previous, record, only_file=file['path'])
        self.previews.queue()
        return {'revision': record['revision'], 'data': self.view(),
                'message': f'Saved passage to {file["path"]} and refreshed its word changes.'}

    def resume_previews(self):
        with self.store.transaction():
            if self.store.read()['metadata']['preview_status'] in ('queued', 'rendering'):
                self.previews.queue()
