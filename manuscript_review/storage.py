"""One durable review record, atomic replacements, and recoverable file transactions."""
import fcntl
import json
import os
import secrets
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = 7


class StaleReview(ValueError):
    """A refused write whose conflicting request has been retained."""


class FileLock:
    def __init__(self, path):
        self.path = Path(path)
        self.thread = threading.RLock()
        self.handle = None
        self.depth = 0

    def __enter__(self):
        self.thread.acquire()
        try:
            if not self.depth:
                self.handle = self.path.open('a')
                fcntl.flock(self.handle, fcntl.LOCK_EX)
            self.depth += 1
        except Exception:
            if self.handle:
                self.handle.close()
                self.handle = None
            self.thread.release()
            raise
        return self

    def __exit__(self, *args):
        try:
            self.depth -= 1
            if not self.depth:
                self.handle.close()
                self.handle = None
        finally:
            self.thread.release()


def atomic_bytes(path, contents):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '-', delete=False) as file:
            temporary = Path(file.name)
            os.fchmod(file.fileno(), mode)
            file.write(contents)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
        sync_directory(path.parent)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


def read_json(path, default=None):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def new_record(snapshot, metadata, decisions=None, comments=None, history=None, baseline=None):
    return {'schema': SCHEMA, 'snapshot': snapshot, 'metadata': metadata,
            'baseline': baseline or snapshot['base'], 'result': snapshot['proposed'],
            'revision': 0, 'decisions': decisions or {}, 'comments': comments or {},
            'history': history or [], 'resolved': [], 'drafts': {}, 'applied': {}, 'ui': {}}


def validate_record(record):
    if not isinstance(record, dict) or record.get('schema') != SCHEMA:
        raise ValueError('Unsupported review format. Close review interfaces and run the agent’s migrate command.')
    from .comparison import validate_decisions
    from .feedback import validate_comments
    validate_decisions(record['snapshot'], record['decisions'])
    validate_comments(record['snapshot'], record['comments'])
    if any(not isinstance(record.get(key), str) or len(record[key]) != 40 for key in ('baseline', 'result')):
        raise ValueError('A review needs pinned baseline and selected source versions.')
    if not isinstance(record['revision'], int) or not isinstance(record['history'], list):
        raise ValueError('Invalid review record.')
    if any(not isinstance(entry, dict) or entry.get('author') not in ('user', 'agent') for entry in record['history']):
        raise ValueError('Each discussion needs a user or agent author.')
    resolved = record['resolved']
    if not isinstance(resolved, list) or any(not isinstance(identifier, str) or not identifier or len(identifier) > 200 for identifier in resolved) or len(set(resolved)) != len(resolved):
        raise ValueError('Resolved threads must contain distinct discussion origins.')
    drafts = record['drafts']
    if not isinstance(drafts, dict) or any(
            not isinstance(key, str) or not isinstance(draft, dict)
            or set(draft) != {'file', 'source', 'text'}
            or draft['file'] is not None and not isinstance(draft['file'], str)
            or not isinstance(draft['source'], str) or len(draft['source']) != 40
            or not isinstance(draft['text'], str) or len(draft['text']) > 1_000_000
            for key, draft in drafts.items()):
        raise ValueError('Invalid source drafts.')
    if 'drafts' in record['ui']:
        raise ValueError('Source drafts belong to review content, not navigation preferences.')
    metadata = record['metadata']
    if ('workspace' in metadata) != ('workspace_version' in metadata):
        raise ValueError('A source checkout needs its captured version.')
    if 'workspace' in metadata and (not isinstance(metadata['workspace'], str)
            or not Path(metadata['workspace']).is_absolute()
            or not isinstance(metadata['workspace_version'], str) or len(metadata['workspace_version']) != 40):
        raise ValueError('Invalid source checkout.')
    return record


class ReviewStore:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.lock = FileLock(self.directory / '.session.lock')
        self.path = self.directory / 'review.json'
        self.journal = self.directory / 'transaction.json'

    @contextmanager
    def transaction(self):
        with self.lock:
            pending = read_json(self.journal)
            if pending:
                from .application import repository_lock
                with repository_lock(pending['record']['snapshot']['repo']):
                    self.recover()
            yield self

    def read(self):
        return validate_record(read_json(self.path))

    def backup_request(self, request):
        folder = self.directory / 'conflicting-drafts'
        folder.mkdir(exist_ok=True)
        atomic_json(folder / (secrets.token_hex(12) + '.json'), request)

    def archive(self, record):
        folder = self.directory / 'versions'
        folder.mkdir(exist_ok=True)
        atomic_json(folder / f'{record["revision"]:08d}.json', record)

    def commit(self, record, files=None):
        validate_record(record)
        if self.journal.exists():
            raise ValueError('An interrupted manuscript save needs recovery before another write.')
        if files:
            # The journal is durable before any manuscript write. Recovery completes
            # the exact same transaction, refusing any intervening external edits.
            atomic_json(self.journal, {'record': record, 'files': files})
            self.recover()
        else:
            atomic_json(self.path, record)

    def recover(self):
        transaction = read_json(self.journal)
        if transaction is None:
            return
        snapshot = transaction['record']['snapshot']
        from .workspace import working_directory
        repo = working_directory(transaction['record'])
        from .comparison import git
        if git(repo, 'rev-parse', 'HEAD').decode().strip() != snapshot['source_head']:
            raise ValueError('HEAD changed during an interrupted save. The transaction and draft are retained.')
        if git(repo, 'diff', '--cached', '--name-only').strip():
            raise ValueError('The repository has staged changes. Unstage them before recovering the interrupted save.')
        plan = []
        for item in transaction['files']:
            destination = repo / item['path']
            if destination.is_symlink() or not destination.resolve().is_relative_to(repo):
                raise ValueError('Unsafe manuscript path during recovery.')
            current = destination.read_bytes().decode() if destination.exists() else None
            if current not in (item['before'], item['after']):
                raise ValueError(f'{item["path"]} changed during an interrupted save. The draft is retained in {self.journal}.')
            plan.append((destination, item['after']))
        for destination, content in plan:
            if content is None:
                destination.unlink(missing_ok=True)
                sync_directory(destination.parent)
            else:
                atomic_bytes(destination, content.encode())
        atomic_json(self.path, transaction['record'])
        self.journal.unlink()
        sync_directory(self.directory)
