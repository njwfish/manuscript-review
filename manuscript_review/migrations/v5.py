#!/usr/bin/env python3
"""Port passage drafts to pinned file drafts; retain byte-exact v5 records."""
import copy
from contextlib import ExitStack
from pathlib import Path
from manuscript_review.editing import selected_content, projection_blocks, mapped_range
from manuscript_review.file_editing import replace_ranges
from manuscript_review.storage import SCHEMA, FileLock, atomic_bytes, atomic_json, read_json, validate_record


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
    result.update(schema=SCHEMA, drafts=retained)
    return validate_record(result)


def port_record(old):
    if old['schema'] != 5:
        raise ValueError('Expected a v5 review record.')
    return port_drafts(old)


def upgrade(home):
    home = Path(home).expanduser().resolve()
    with FileLock(home / '.prepare.lock'), ExitStack() as locks:
        pending = []
        for path in sorted((home / 'reviews').glob('*/review.json')):
            locks.enter_context(FileLock(path.parent / '.session.lock'))
            if (path.parent / 'transaction.json').exists():
                raise ValueError('Recover an interrupted manuscript save before upgrading.')
            old = read_json(path)
            if old['schema'] == SCHEMA:
                validate_record(old)
                continue
            current = port_record(old)
            original = path.read_bytes()
            archive = path.parent / 'migration-v5' / 'review.json'
            if archive.exists() and archive.read_bytes() != original:
                raise ValueError('The original record changed after an interrupted migration; its archive is retained.')
            pending.append((path, archive, original, current))
        for path, archive, original, current in pending:
            atomic_bytes(archive, original)
            atomic_json(path, current)
        return len(pending)
