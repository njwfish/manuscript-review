"""Combine disjoint word changes between exact source versions."""
from .anchors import SourceMap, SourceSpan
from .file_editing import replace_ranges


def changes_overlap(first, second):
    """Adjacent insertions and replacements do not contest each other's text."""
    if first.start == first.end:
        if second.start == second.end:
            return first.start == second.start
        return second.start < first.start < second.end
    if second.start == second.end:
        return first.start < second.start < first.end
    return first.overlaps(second)


def merge_text(base, current, incoming):
    if current == incoming or incoming == base:
        return current
    if current == base:
        return incoming
    if None in (base, current, incoming):
        raise ValueError('Overlapping file creation or deletion.')
    ours, theirs = SourceMap(base, current), SourceMap(base, incoming)
    changed = [(SourceSpan(a, b), current[c:d]) for tag, a, b, c, d in ours.blocks if tag != 'equal']
    replacements = []
    for tag, a, b, c, d in theirs.blocks:
        if tag == 'equal':
            continue
        span, text = SourceSpan(a, b), incoming[c:d]
        overlaps = [(other, value) for other, value in changed if changes_overlap(span, other)]
        if overlaps:
            if overlaps == [(span, text)]:
                continue
            raise ValueError('Overlapping changes near: ' + base[max(0, a-40):min(len(base), b+40)])
        mapped = ours.project(span)
        replacements.append((mapped.start, mapped.end, text))
    return replace_ranges(current, replacements)
