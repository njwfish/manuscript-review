"""Current notes, immutable earlier discussion, and exports from the review record."""
from .history import build_history, discussion_id


def validate_comments(snapshot, comments):
    valid = {g['id'] for f in snapshot['files'] for g in f['edits']}
    valid.update(h['id'] for f in snapshot['files'] for h in f['hunks'])
    if not isinstance(comments, dict) or not set(comments) <= valid:
        raise ValueError('Unknown edit or passage in comments.')
    if any(not isinstance(v, str) or len(v) > 20_000 for v in comments.values()):
        raise ValueError('Comments must be text of at most 20,000 characters.')


def feedback_report(snapshot, decisions, comments, history):
    notes, edits = [], []
    for file in snapshot['files']:
        for number, passage in enumerate(file['hunks'], 1):
            for edit in passage['edits']:
                edits.append({'id': edit['id'], 'passage_id': passage['id'], 'file': file['path'], 'line': passage['line'],
                              'decision': decisions.get(edit['id'], 'pending'), 'before': edit['old'], 'proposed': edit['new'],
                              'context_before': passage['before'], 'context_proposed': passage['after']})
            for item, kind in [(passage, 'passage'), *[(g, 'edit') for g in passage['edits']]]:
                text = comments.get(item['id'], '')
                if not text.strip():
                    continue
                statuses = {decisions.get(g['id'], 'pending') for g in passage['edits']} if kind == 'passage' else {decisions.get(item['id'], 'pending')}
                notes.append({'id': item['id'], 'discussion_id': discussion_id(snapshot, item['id'], text, 'user'), 'kind': kind, 'file': file['path'], 'line': passage['line'],
                              'passage': number, 'decision': next(iter(statuses)) if len(statuses) == 1 else 'mixed',
                              'before': item['before'] if kind == 'passage' else item['old'],
                              'proposed': item['after'] if kind == 'passage' else item['new'],
                              'context_before': passage['before'], 'context_proposed': passage['after'], 'comment': text})
    return {'repo': snapshot['repo'], 'base': snapshot['base'], 'proposed': snapshot['proposed'],
            'decisions': decisions, 'edits': edits, 'comments': notes, 'history': history}
