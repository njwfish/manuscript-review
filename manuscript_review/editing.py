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


def projection_blocks(file, content):
    """Exact proposal-to-projection spans, preserving repeated source locations."""
    states = {(0, ())}
    offset = 0
    for identifier, old, new in source_segments(file):
        following = set()
        for position, blocks in states:
            for text in dict.fromkeys((new, old)):
                if content.startswith(text, position):
                    block = (offset, offset + len(new), position, position + len(text), identifier)
                    following.add((position + len(text), (*blocks, block)))
        states = following
        offset += len(new)
    matches = {blocks for position, blocks in states if position == len(content)}
    if len(matches) != 1:
        raise ValueError('The source cannot be located unambiguously. Your draft is retained; update the comparison first.')
    return matches.pop()


def mapped_range(blocks, span, included=()):
    """Map an interval; changed groups map as a whole and retained text exactly."""
    lo, hi = span
    def position(point, end):
        for a, b, c, d, identifier in blocks:
            if (a < point <= b if end else a <= point < b):
                return c + point - a if identifier is None else d if end else c
        return 0 if point == 0 else blocks[-1][3] if blocks else 0
    if lo == hi:
        collapsed = [(c, d) for a, b, c, d, _ in blocks if a == b == lo and c != d]
        if collapsed:
            return min(c for c, _ in collapsed), max(d for _, d in collapsed)
        point = position(lo, False)
        return point, point
    start, end = position(lo, False), position(hi, True)
    for a, b, c, d, identifier in blocks:
        if a == b and lo <= a <= hi and identifier in included:
            start, end = min(start, c), max(end, d)
    return start, end


def selected_content(file, decisions):
    return project_source(file, decisions).content


def passage_text(file, hunk, decisions):
    return ''.join(group_text(file, segment, decisions) if 'members' in segment else segment['text']
                   for segment in hunk['grouped_segments'])
