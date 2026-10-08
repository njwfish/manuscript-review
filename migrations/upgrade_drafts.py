#!/usr/bin/env python3
"""Move v4 passage drafts into versioned review content; keep byte-exact originals."""
import argparse
import copy
from contextlib import ExitStack
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manuscript_review.storage import SCHEMA, FileLock, atomic_bytes, atomic_json, read_json, validate_record


def port_record(old):
    if old['schema'] != 4:
        raise ValueError('Expected a v4 review record.')
    record = copy.deepcopy(old)
    record['schema'] = SCHEMA
    record['drafts'] = record['ui'].pop('drafts', {})
    return validate_record(record)


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
            original = path.read_bytes()
            current = port_record(old)
            archive = path.parent / 'migration-v4' / 'review.json'
            if archive.exists() and archive.read_bytes() != original:
                raise ValueError('The v4 record changed after an interrupted migration; its archive is retained.')
            pending.append((path, archive, original, current))
        for path, archive, original, current in pending:
            atomic_bytes(archive, original)
            atomic_json(path, current)
        return len(pending)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('home', type=Path)
    args = parser.parse_args()
    print(f'Upgraded {upgrade(args.home)} reviews; originals retained in migration-v4/.')
