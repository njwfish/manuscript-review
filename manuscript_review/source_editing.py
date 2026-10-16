"""Plan a saved buffer's change without writing source or review state."""
from .anchors import SourceMap, SourceSpan
from .authoring import authored_text, merge_saved
from .editing import decision_blocks, projection_blocks, mapped_range, selected_content
from .file_editing import file_replacements, merge_spans, replace_ranges
from .merging import changes_overlap, merge_text


def refined_text(file, decisions, origin, saved):
    """Map deliberate edits through known choices, preserving newer choices elsewhere."""
    selected = selected_content(file, decisions)
    if origin == selected:
        return saved
    try:
        origin_blocks = projection_blocks(file, origin or '')
    except ValueError:
        return merge_text(origin, selected, saved)
    blocks = [(c, d, g, h, identifier) for (_, _, c, d, identifier), (_, _, g, h, _) in
              zip(origin_blocks, decision_blocks(file, decisions))]
    mapping = SourceMap(origin or '', saved)
    spans = []
    for tag, a, b, _, _ in mapping.blocks:
        if tag == 'equal':
            continue
        span = SourceSpan(a, b)
        for lo, hi, _, _, identifier in blocks:
            if identifier and lo != hi and changes_overlap(span, SourceSpan(lo, hi)):
                span = SourceSpan(min(span.start, lo), max(span.end, hi))
        spans.append(span)
    replacements = []
    for span in merge_spans(spans):
        changed = mapping.project(span)
        for tag, a, b, c, d in mapping.blocks:
            if tag != 'equal' and span.overlaps(SourceSpan(a, b)):
                changed = SourceSpan(min(changed.start, c), max(changed.end, d))
        replacements.append((*mapped_range(blocks, (span.start, span.end)), saved[changed.start:changed.end]))
    return replace_ranges(selected or '', replacements)


def proposal_edit(file, decisions, origin, saved):
    """Refine the proposal; unrelated selected wording and the base stay fixed."""
    if origin == saved:
        return {'proposal': file['after'], 'changed': [], 'edited': set(), 'selected': selected_content(file, decisions), 'author': None, 'conflict': False}
    if file['before'] is None and file['after'] is None or origin is None and saved == '':
        replacements = [(0, len(file['after'] or ''), saved)]
        edited = {group['id'] for group in file['edits']}
        merged = saved
    else:
        merged = refined_text(file, decisions, origin, saved)
        replacements, _, edited = file_replacements(file, decisions, merged or '')
    return {'proposal': replace_ranges(file['after'] or '', replacements),
            'changed': [SourceSpan(start, end) for start, end, _ in replacements],
            'selected': merged, 'edited': edited,
            'author': None, 'conflict': False}


def author_edit(file, decisions, origin, saved):
    """Advance author wording while retaining undelivered, contested proposals."""
    if origin == saved:
        return {'proposal': file['after'], 'changed': [], 'edited': set(), 'selected': selected_content(file, decisions), 'author': None, 'conflict': False}
    selected = selected_content(file, decisions)
    if file['before'] is None and file['after'] is None:
        proposal, changed, conflict = saved, [SourceSpan(0, 0)], False
        edited = {group['id'] for group in file['edits']}
        merged = saved
    elif selected is None:
        proposal, changed, conflict = None, [], True
        edited = set()
        merged = None
    else:
        merged, conflict = merge_saved(origin or '', selected, saved)
        replacements, _, edited = file_replacements(file, decisions, merged)
        proposal = replace_ranges(file['after'] or '', replacements)
        changed = [SourceSpan(start, end) for start, end, _ in replacements]
    return {'proposal': proposal, 'changed': changed, 'selected': merged, 'edited': edited,
            'author': authored_text(origin or '', file['before'] or '', saved), 'conflict': conflict}


saved_edits = {'proposal': proposal_edit, 'author': author_edit}
