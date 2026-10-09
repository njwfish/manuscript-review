"""Explicit record migrations, loaded only by the migration command."""
from contextlib import ExitStack
from pathlib import Path
from manuscript_review.storage import SCHEMA, FileLock, atomic_bytes, atomic_json, read_json, validate_record


def port_thread_origins(record):
    """Keep saved current follow-ups with their earlier legacy messages."""
    targets = {target for target, text in record['comments'].items() if text.strip()}
    for entry in record['history']:
        if entry['origin_id'] in targets:
            entry['origin_id'] = f'{record["metadata"]["id"]}:{entry["origin_id"]}'
    return record


def upgrade_records(home, port_record):
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
            archive = path.parent / f'migration-v{old["schema"]}' / 'review.json'
            if archive.exists() and archive.read_bytes() != original:
                raise ValueError('The original record changed after an interrupted migration; its archive is retained.')
            pending.append((path, archive, original, current))
        for path, archive, original, current in pending:
            atomic_bytes(archive, original)
            atomic_json(path, current)
        return len(pending)
