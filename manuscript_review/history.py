"""Keep earlier feedback separate from the current round's editable notes."""
import copy
from .anchors import SourceMap, SourceSpan
from .comparison import read_blob, stable_id
from .editing import project_source, passage_text


def attach(entry, file):
    entry['target'] = None
    if file is None:
        return
    span = SourceSpan(entry['anchor']['start'], entry['anchor']['end'])
    for hunk in file['hunks']:
        lo, hi = hunk['base_span']
        if not span.overlaps(SourceSpan(lo, hi)):
            continue
        matches = []
        for group in hunk['edits']:
            a, b = group['base_span']
            if span.overlaps(SourceSpan(a, b)):
                matches.append(group)
        target = matches[0] if entry['kind'] == 'edit' and len(matches) == 1 else hunk
        entry['target'] = {'kind': 'edit' if target is not hunk else 'passage', 'id': target['id']}
        return


def add_responses(entries, responses):
    """Append replies to exact discussion IDs; repeated imports are idempotent."""
    from datetime import datetime, timezone
    result = copy.deepcopy(entries)
    if not isinstance(responses, list):
        raise ValueError('Responses must be a list of {id, text} records.')
    known = {entry['id']: entry for entry in result}
    seen = set()
    for row in responses:
        if not isinstance(row, dict) or not isinstance(row.get('text'), str) or not row['text'].strip():
            raise ValueError('Each response needs a discussion id and text.')
        identifier = row.get('id')
        if not isinstance(identifier, str) or identifier not in known or identifier in seen:
            raise ValueError('Response must identify one saved discussion: ' + str(identifier))
        seen.add(identifier)
        entry = known[identifier]
        reply_id = stable_id('reply', [identifier, row['text']])
        replies = entry.setdefault('replies', [])
        if not any(reply['id'] == reply_id for reply in replies):
            replies.append({'id': reply_id, 'text': row['text'], 'created': datetime.now(timezone.utc).isoformat()})
        if 'title' in row:
            if not isinstance(row['title'], str):
                raise ValueError('Response title must be text.')
            entry['title'] = row['title']
    return result


def round_id(snapshot):
    """The fixed base and creation time identify a round across proposal edits."""
    return stable_id('round', [snapshot['repo'], snapshot['base'], snapshot['created']])


def discussion_id(snapshot, target, text, author):
    namespace = {'user': 'discussion', 'agent': 'agent-discussion'}[author]
    return stable_id(namespace, [round_id(snapshot), target, text])


def discussion_note(note, snapshot, review, author):
    return {**{key: value for key, value in note.items() if key not in ('discussion_id', 'thread_id', 'resolved')},
            'id': discussion_id(snapshot, note['id'], note['comment'], author),
            'author': author, 'origin_id': note['origin_id'], 'origin_review': str(review),
            'created': snapshot['created'], 'round_id': round_id(snapshot),
            'base': snapshot['base'], 'source_proposed': snapshot['proposed'], 'replies': []}


def add_explanations(snapshot, decisions, entries, records, review, review_id):
    """Record agent rationale against exact passage or edit IDs, without changing notes."""
    from .feedback import feedback_report, validate_comments
    if not isinstance(records, list):
        raise ValueError('Explanations must be a list of {id, text} records.')
    comments, titles = {}, {}
    for row in records:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not isinstance(row.get('text'), str) or not row['text'].strip():
            raise ValueError('Each explanation needs a passage or edit id and text.')
        if row['id'] in comments:
            raise ValueError('Use one explanation per target in an import: ' + row['id'])
        comments[row['id']] = row['text']
        if 'title' in row:
            if not isinstance(row['title'], str) or len(row['title']) > 200:
                raise ValueError('Explanation title must be text of at most 200 characters.')
            titles[row['id']] = row['title']
    validate_comments(snapshot, comments)
    result = copy.deepcopy(entries)
    known = {entry['id']: entry for entry in result}
    targets = {item['id']: item for file in snapshot['files'] for passage in file['hunks']
               for item in [passage, *passage['edits']]}
    for note in feedback_report(snapshot, decisions, comments, [], review_id)['comments']:
        existing = next((entry for entry in result if entry['author'] == 'agent'
                         and entry['origin_id'] == note['origin_id'] and entry['base'] == snapshot['base']
                         and entry['created'] == snapshot['created'] and entry['comment'] == note['comment']), None)
        identifier = existing['id'] if existing else discussion_id(snapshot, note['id'], note['comment'], 'agent')
        if identifier not in known:
            target = targets[note['id']]
            start, end = target['base_span']
            entry = discussion_note(note, snapshot, review, 'agent')
            entry['anchor'] = {'revision': snapshot['base'], 'start': start, 'end': end}
            entry['target'] = {'kind': note['kind'], 'id': note['id']}
            result.append(entry)
            known[identifier] = entry
        if note['id'] in titles:
            known[identifier]['title'] = titles[note['id']]
    return result


def build_history(previous, current, state, report, inherited, previous_review):
    if previous['repo'] != current['repo']:
        raise ValueError('Earlier feedback must belong to the same manuscript repository.')
    old_files = {f['path']: f for f in previous['files']}
    new_files = {f['path']: f for f in current['files']}
    entries = copy.deepcopy(inherited)
    known = {e['id'] for e in entries}
    sources = {}
    projections = {}
    maps = {}

    def source(revision, path):
        key = revision, path
        if key not in sources:
            sources[key] = read_blob(current['repo'], revision, path) or ''
        return sources[key]

    def mapped(path, before, start, end):
        if (path, before) not in maps:
            maps[path, before] = SourceMap(before, source(current['base'], path))
        return maps[path, before].project(SourceSpan(start, end))

    for entry in entries:
        path, anchor = entry['file'], entry['anchor']
        span = mapped(path, source(anchor['revision'], path), anchor['start'], anchor['end'])
        attachment = {**entry, 'anchor': {'revision': current['base'], 'start': span.start, 'end': span.end}}
        attach(attachment, new_files.get(path))
        entry['target'] = attachment['target']

    for note in report['comments']:
        comment = state['comments'][note['id']]
        # Keep existing history ids. New messages are identified by round,
        # original anchor and exact text, so editing a note cannot erase it.
        if any(e['author'] == 'user' and e['origin_id'] == note['origin_id'] and e['base'] == previous['base']
               and e['source_proposed'] == previous['proposed']
               and e['created'] == previous['created'] and e['comment'] == comment for e in entries):
            continue
        identifier = discussion_id(previous, note['id'], comment, 'user')
        if identifier in known:
            continue
        file = old_files[note['file']]
        if note['file'] not in projections:
            projections[note['file']] = project_source(file, state['decisions'])
        projection = projections[note['file']]
        selected, ranges = projection.content or '', projection.ranges
        if note['kind'] == 'edit':
            start, end = ranges[note['id']]
        else:
            hunk = next(h for h in file['hunks'] if h['id'] == note['id'])
            context = passage_text(file, hunk, state['decisions'])
            start = ranges[hunk['edits'][0]['id']][0]
            # Retained leading context is before the first changed group.
            for segment in hunk['grouped_segments']:
                if 'members' in segment:
                    break
                start -= len(segment['text'])
            end = start + len(context)
        span = mapped(note['file'], selected, start, end)
        entry = discussion_note(note, previous, previous_review, 'user')
        entry['anchor'] = {'revision': current['base'], 'start': span.start, 'end': span.end}
        attach(entry, new_files.get(note['file']))
        entries.append(entry)
        known.add(identifier)
    return entries
