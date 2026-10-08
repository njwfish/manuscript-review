"""Project conceptual decisions onto source; passage edits replace the proposal itself."""
from dataclasses import dataclass


@dataclass(frozen=True)
class SelectedSource:
    content: str | None
    ranges: dict[str, tuple[int, int]]


def group_text(file, group, decisions):
    return group['old'] if decisions.get(group['id']) == 'reject' else group['new']


def source_segments(file):
    groups = {g['start']: g for g in file['edits']}
    index = 0
    while index < len(file['pieces']):
        group = groups.get(index)
        if group:
            yield group['id'], group['old'], group['new']
            index = group['stop']
        else:
            text = file['pieces'][index]['new']
            yield None, text, text
            index += 1


def project_source(file, decisions):
    content, ranges, offset = [], {}, 0
    for identifier, old, new in source_segments(file):
        text = old if decisions.get(identifier) == 'reject' else new
        if identifier:
            ranges[identifier] = (offset, offset + len(text))
        content.append(text)
        offset += len(text)
    absent = (file['status'] == 'new' and decisions.get(file['edits'][0]['id']) == 'reject'
              or file['status'] == 'deleted' and decisions.get(file['edits'][0]['id']) != 'reject')
    return SelectedSource(None if absent else ''.join(content), ranges)


def working_passage_range(file, passage, working):
    """Locate a passage in a projection of this proposal, without guessing at repeats."""
    lo, hi = passage['proposal_span']
    if working == (file['after'] or ''):
        return lo, hi
    selected = {group['id'] for group in passage['edits']}
    states, offset = {(0, None, None)}, 0
    for identifier, old, new in source_segments(file):
        following = set()
        for position, start, end in states:
            for text in dict.fromkeys((new, old)):
                if not working.startswith(text, position):
                    continue
                first, last = start, end
                if identifier in selected:
                    first = position if first is None else first
                    last = position + len(text)
                elif identifier is None and max(lo, offset) < min(hi, offset + len(new)):
                    first = position + max(lo - offset, 0) if first is None else first
                    last = position + min(hi - offset, len(new))
                following.add((position + len(text), first, last))
        states = following
        offset += len(new)
        if not states:
            break
    ranges = {(start, end) for position, start, end in states if position == len(working) and start is not None}
    if len(ranges) != 1:
        raise ValueError('This passage cannot be located unambiguously in the working file. Your draft is retained; update the comparison first.')
    return ranges.pop()


def selected_content(file, decisions):
    return project_source(file, decisions).content


def passage_text(file, hunk, decisions):
    return ''.join(group_text(file, segment, decisions) if 'members' in segment else segment['text']
                   for segment in hunk['grouped_segments'])
