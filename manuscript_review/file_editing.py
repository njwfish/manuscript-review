"""Apply manual changes from the selected document to its proposal."""
from .anchors import SourceMap, SourceSpan
from .comparison import compare, enrich_snapshot
from .editing import project_source, decision_blocks, mapped_range


def equivalent_edits(file, revised):
    """Match edits by their exact effect on the same baseline, despite alignment shifts."""
    baseline = file['before'] or ''
    current = {edit['id'] for edit in revised['edits']}
    matches = {}
    for old in file['edits']:
        if old['id'] in current:
            matches[old['id']] = old['id']
            continue
        a, b = old['base_span']
        candidates = []
        for new in revised['edits']:
            c, d = new['base_span']
            if not SourceSpan(a, b).overlaps(SourceSpan(c, d)):
                continue
            lo, hi = min(a, c), max(b, d)
            if baseline[lo:a] + old['new'] + baseline[b:hi] == baseline[lo:c] + new['new'] + baseline[d:hi]:
                candidates.append(new['id'])
        if len(candidates) == 1:
            matches[old['id']] = candidates[0]
    return matches


def revised_decisions(file, revised, decisions, changed, edited, accept=True):
    """Carry choices across equivalent edits; new author wording is accepted."""
    matches = equivalent_edits(file, revised)
    affected = {group['id'] for group in file['edits'] if group['id'] in edited or
                group['id'] not in matches and any(span.overlaps(SourceSpan(*group['proposal_span'])) for span in changed)}
    choices = {}
    for key, value in decisions.items():
        if key in affected:
            continue
        target = matches.get(key, key)
        if target in choices and choices[target] != value:
            raise ValueError('The revision combines conflicting decisions. Your draft is retained.')
        choices[target] = value
    retained = {matches[group['id']] for group in file['edits'] if group['id'] not in affected and group['id'] in matches}
    for group in revised['edits']:
        if accept and group['id'] not in retained:
            choices[group['id']] = 'accept'
    return choices, affected


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
    edited = {identifier for identifier, interval in source.ranges.items()
              if any(SourceSpan(*edit['base_span']).overlaps(SourceSpan(*interval)) for edit in delta['edits'])}
    spans = []
    for edit in delta['edits']:
        span = SourceSpan(*edit['base_span'])
        for start, end in source.ranges.values():
            if span.overlaps(SourceSpan(start, end)):
                span = SourceSpan(min(span.start, start), max(span.end, end))
        spans.append(span)
    spans = merge_spans(spans)
    mapping = SourceMap(before, text)
    blocks = [(c, d, a, b, identifier) for a, b, c, d, identifier in decision_blocks(file, decisions)]
    absorbed = set(edited)
    while True:
        replacements, selected_replacements = [], []
        for span in spans:
            changed = mapping.project(span)
            # Boundary insertions belong to their manual replacement, including
            # added text at the end of a nonempty interval.
            for edit in delta['edits']:
                if span.overlaps(SourceSpan(*edit['base_span'])):
                    changed = SourceSpan(min(changed.start, edit['proposal_span'][0]), max(changed.end, edit['proposal_span'][1]))
            included = {identifier for identifier, interval in source.ranges.items()
                        if span.overlaps(SourceSpan(*interval))}
            start, end = mapped_range(blocks, (span.start, span.end), included)
            if replacements and start < replacements[-1][1]:
                raise ValueError('The manual changes overlap in the proposal. Your draft is retained; revise a smaller region.')
            replacement = text[changed.start:changed.end]
            replacements.append((start, end, replacement))
            selected_replacements.append((span.start, span.end, replacement))
        after = replace_ranges(file['after'] or '', replacements)
        revised = enrich_snapshot({'files': [compare(file['path'], file['before'], after)]})['files'][0]
        matches = equivalent_edits(file, revised)
        expanded = list(spans)
        newly_absorbed = set()
        for previous in file['edits']:
            lo, hi = source.ranges[previous['id']]
            if previous['id'] in matches or previous['id'] in absorbed:
                continue
            newly_absorbed.add(previous['id'])
            # Reconcile one lost edit at a time: restoring its selected words
            # can recover neighboring edits' original alignment and choices.
            expanded.append(SourceSpan(lo, hi))
            break
        expanded = merge_spans(expanded)
        if expanded == spans and not newly_absorbed:
            return replacements, selected_replacements, edited
        spans = expanded
        absorbed.update(newly_absorbed)


def replace_ranges(content, replacements):
    for start, end, text in reversed(replacements):
        content = content[:start] + text + content[end:]
    return content
