#!/usr/bin/env python3
"""Port passage drafts to pinned file drafts; retain byte-exact v5 records."""
import copy
from manuscript_review.editing import selected_content, projection_blocks, mapped_range
from manuscript_review.file_editing import replace_ranges
from manuscript_review.storage import SCHEMA, validate_record
from . import port_thread_origins, upgrade_records


def port_drafts(record):
    result = copy.deepcopy(record)
    drafts = record['drafts']
    located = {h['id']: (file, h) for file in record['snapshot']['files'] for h in file['hunks']}
    changes, retained = {}, {}
    for identifier, text in drafts.items():
        if identifier not in located:
            retained[identifier] = {'file': None, 'source': record['result'], 'text': text}
            continue
        file, passage = located[identifier]
        content = selected_content(file, record['decisions']) or ''
        start, end = mapped_range(projection_blocks(file, content), passage['proposal_span'],
                                  {g['id'] for g in passage['edits']})
        changes.setdefault(file['path'], (content, []))[1].append((start, end, text))
    for path, (content, replacements) in changes.items():
        replacements.sort()
        if any(first[1] > second[0] for first, second in zip(replacements, replacements[1:])):
            raise ValueError('Overlapping passage drafts need reconciliation before upgrading.')
        retained[path] = {'file': path, 'source': record['result'], 'text': replace_ranges(content, replacements)}
    result.update(schema=SCHEMA, drafts=retained, resolved=record.get('resolved', []))
    return validate_record(port_thread_origins(result))


def port_record(old):
    if old['schema'] != 5:
        raise ValueError('Expected a v5 review record.')
    return port_drafts(old)


def upgrade(home):
    return upgrade_records(home, port_record)
