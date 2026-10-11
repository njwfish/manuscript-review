"""Keep author wording as the base of one accumulating agent comparison."""
import copy
from .anchors import SourceMap, SourceSpan
from .comparison import build_snapshot
from .feedback import feedback_report
from .history import build_history
from .file_editing import replace_ranges, merge_spans
from .versions import selected_version
from .editing import project_source


def merge_saved(before, current, saved):
    """Merge author saves while leaving contested agent wording for review."""
    ours = SourceMap(before, current)
    changes = [(SourceSpan(a, b), current[c:d]) for tag, a, b, c, d in ours.blocks if tag != 'equal']
    replacements, conflict = [], False
    for tag, a, b, c, d in SourceMap(before, saved).blocks:
        if tag == 'equal':
            continue
        span, text = SourceSpan(a, b), saved[c:d]
        overlaps = [(other, value) for other, value in changes if span.overlaps(other)]
        if overlaps:
            conflict |= overlaps != [(span, text)]
            continue
        target = ours.project(span)
        replacements.append((target.start, target.end, text))
    return replace_ranges(current, replacements), conflict


def authored_text(before, baseline, saved):
    """Carry only the author's new edits back through the agent changes."""
    mapping = SourceMap(before, baseline)
    saved_mapping = SourceMap(before, saved)
    spans = []
    for tag, a, b, _, _ in saved_mapping.blocks:
        if tag == 'equal':
            continue
        span = SourceSpan(a, b)
        for change, lo, hi, _, _ in mapping.blocks:
            if change != 'equal' and span.overlaps(SourceSpan(lo, hi)):
                span = SourceSpan(min(span.start, lo), max(span.end, hi))
        spans.append(span)
    replacements = []
    for span in merge_spans(spans):
        target, source = mapping.project(span), saved_mapping.project(span)
        replacements.append((target.start, target.end, saved[source.start:source.end]))
    return replace_ranges(baseline, replacements)


def rebase(record, base, directory, proposed=None):
    previous = copy.deepcopy(record)
    old = previous['snapshot']
    snapshot = build_snapshot(old['repo'], base, proposed or old['proposed'], text_only=True)
    snapshot.update({key: old[key] for key in ('source_head', 'entry', 'token', 'created')})
    # Offsets in the proposed source remain exact when only the base changes.
    choices = {(file['path'], tuple(edit['proposal_span']), edit['old'], edit['new']): previous['decisions'][edit['id']]
               for file in old['files'] for edit in file['edits'] if edit['id'] in previous['decisions']}
    record['decisions'] = {edit['id']: choices[key] for file in snapshot['files'] for edit in file['edits']
                           if (key := (file['path'], tuple(edit['proposal_span']), edit['old'], edit['new'])) in choices}
    if proposed:
        selected = set()
        for file in old['files']:
            projection = project_source(file, previous['decisions'])
            for edit in file['edits']:
                if edit['id'] in previous['decisions']:
                    a, b = projection.ranges[edit['id']]
                    selected.add((file['path'], (a, b), (projection.content or '')[a:b]))
        record['decisions'] = {edit['id']: 'accept' for file in snapshot['files'] for edit in file['edits']
                               if (file['path'], tuple(edit['proposal_span']), edit['new']) in selected}
    report = feedback_report(old, previous['decisions'], previous['comments'], previous['history'], previous['metadata']['id'])
    record['history'] = build_history(old, snapshot, previous, report, previous['history'], directory)
    record['comments'] = {}
    record['snapshot'] = snapshot
    record['result'] = selected_version(record)
    record['metadata'].update(base=base, base_label='Your saved draft', proposal_label='Agent changes',
                              authoring=True, preview_status='queued' if snapshot['entry'] else 'none')
