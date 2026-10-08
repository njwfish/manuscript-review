"""Apply manual changes from the selected document to its proposal."""
from .anchors import SourceMap, SourceSpan
from .comparison import compare, enrich_snapshot
from .editing import project_source, projection_blocks, mapped_range


def merge_spans(spans):
    merged = []
    for span in sorted(spans, key=lambda item: (item.start, item.end)):
        if merged and span.start <= merged[-1].end:
            previous = merged.pop()
            span = SourceSpan(previous.start, max(span.end, previous.end))
        merged.append(span)
    return merged


def file_replacements(file, decisions, text):
    source = project_source(file, decisions)
    before = source.content or ''
    delta = enrich_snapshot({'files': [compare(file['path'], before, text)]})['files'][0]
    spans = []
    for edit in delta['edits']:
        span = SourceSpan(*edit['base_span'])
        for start, end in source.ranges.values():
            if span.overlaps(SourceSpan(start, end)):
                span = SourceSpan(min(span.start, start), max(span.end, end))
        spans.append(span)
    spans = merge_spans(spans)
    mapping = SourceMap(before, text)
    baseline = SourceMap(before, file['before'] or '')
    blocks = [(c, d, a, b, identifier) for a, b, c, d, identifier in projection_blocks(file, before)]
    original_ids = {group['id'] for group in file['edits']}
    while True:
        replacements, selected_replacements = [], []
        for span in spans:
            changed = mapping.project(span)
            # Boundary insertions belong to their manual replacement, including
            # added text at the end of a nonempty interval.
            for edit in delta['edits']:
                if span.overlaps(SourceSpan(*edit['base_span'])):
                    changed = SourceSpan(min(changed.start, edit['proposal_span'][0]), max(changed.end, edit['proposal_span'][1]))
            start, end = mapped_range(blocks, (span.start, span.end))
            if replacements and start < replacements[-1][1]:
                raise ValueError('The manual changes overlap in the proposal. Your draft is retained; revise a smaller region.')
            replacement = text[changed.start:changed.end]
            replacements.append((start, end, replacement))
            selected_replacements.append((span.start, span.end, replacement))
        after = replace_ranges(file['after'] or '', replacements)
        revised = enrich_snapshot({'files': [compare(file['path'], file['before'], after)]})['files'][0]
        expanded = []
        for span in spans:
            anchor = baseline.project(span)
            for group in revised['edits']:
                if group['id'] in original_ids or not anchor.overlaps(SourceSpan(*group['base_span'])):
                    continue
                # A manual change can merge neighboring replacements. Carry
                # their selected wording into that new conceptual edit, so an
                # absorbed rejection keeps the author's wording intact.
                for previous in file['edits']:
                    if SourceSpan(*previous['base_span']).overlaps(SourceSpan(*group['base_span'])):
                        lo, hi = source.ranges[previous['id']]
                        span = SourceSpan(min(span.start, lo), max(span.end, hi))
            expanded.append(span)
        expanded = merge_spans(expanded)
        if expanded == spans:
            return replacements, selected_replacements
        spans = expanded


def replace_ranges(content, replacements):
    for start, end, text in reversed(replacements):
        content = content[:start] + text + content[end:]
    return content
