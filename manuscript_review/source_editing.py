"""Plan a saved buffer's change without writing source or review state."""
from .anchors import SourceSpan
from .authoring import authored_text, merge_saved
from .editing import projection_blocks, selected_content
from .file_editing import file_replacements, replace_ranges
from .merging import merge_text


def proposal_edit(file, decisions, origin, saved):
    """Refine the proposal; unrelated selected wording and the base stay fixed."""
    if origin == saved:
        return {'proposal': file['after'], 'changed': [], 'author': None, 'conflict': False}
    if file['before'] is None and file['after'] is None or origin is None and saved == '':
        replacements = [(0, len(file['after'] or ''), saved)]
    else:
        try:
            blocks = projection_blocks(file, origin or '')
        except ValueError:
            merged = merge_text(origin, selected_content(file, decisions), saved)
            replacements, _ = file_replacements(file, decisions, merged or '')
        else:
            groups = {group['id']: group for group in file['edits']}
            choices = {identifier: 'reject' for _, _, start, end, identifier in blocks
                       if identifier and (origin or '')[start:end] == groups[identifier]['old']}
            replacements, _ = file_replacements(file, choices, saved)
    return {'proposal': replace_ranges(file['after'] or '', replacements),
            'changed': [SourceSpan(start, end) for start, end, _ in replacements],
            'author': None, 'conflict': False}


def author_edit(file, decisions, origin, saved):
    """Advance author wording while retaining undelivered, contested proposals."""
    if origin == saved:
        return {'proposal': file['after'], 'changed': [], 'author': None, 'conflict': False}
    selected = selected_content(file, decisions)
    if file['before'] is None and file['after'] is None:
        proposal, changed, conflict = saved, [SourceSpan(0, 0)], False
    elif selected is None:
        proposal, changed, conflict = None, [], True
    else:
        merged, conflict = merge_saved(origin or '', selected, saved)
        replacements, _ = file_replacements(file, decisions, merged)
        proposal = replace_ranges(file['after'] or '', replacements)
        changed = [SourceSpan(start, end) for start, end, _ in replacements]
    return {'proposal': proposal, 'changed': changed,
            'author': authored_text(origin or '', file['before'] or '', saved), 'conflict': conflict}


saved_edits = {'proposal': proposal_edit, 'author': author_edit}
