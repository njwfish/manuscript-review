"""One durable review record, atomic replacements, and recoverable file transactions."""
import fcntl
import copy
import json
import re
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
    atomic_chunks(path, (contents,))


def atomic_chunks(path, chunks):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '-', delete=False) as file:
            temporary = Path(file.name)
            os.fchmod(file.fileno(), mode)
            for chunk in chunks:
                file.write(chunk)
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
    if 'authoring' in metadata and not isinstance(metadata['authoring'], bool):
        raise ValueError('Invalid authoring comparison.')
    publications = metadata.get('publications', [])
    if not isinstance(publications, list) or any(not isinstance(item, str) or not re.fullmatch(r'[a-f0-9]{64}', item) for item in publications) or len(set(publications)) != len(publications):
        raise ValueError('Proposal publications must be distinct content identities.')
    conflicts = metadata.get('delivery_conflicts', [])
    if not isinstance(conflicts, list) or any(not isinstance(path, str) for path in conflicts) or len(set(conflicts)) != len(conflicts):
        raise ValueError('Conflicting delivery files must be distinct source paths.')
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
        self.cached = None
        self.snapshot_json = None

    @contextmanager
    def transaction(self):
        with self.lock:
            pending = read_json(self.journal)
            if pending:
                from .application import repository_lock
                with repository_lock(pending['record']['snapshot']['repo']):
                    self.recover()
            yield self

    def read(self, select=None):
        """Copy only a caller's projection, without exposing the cached record."""
        with self.lock:
            record = self._record()
            return copy.deepcopy(select(record) if select else record)

    def _record(self):
        if not self.path.exists():
            raise ValueError('Review record not found.')
        stat = self.path.stat()
        version = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        if self.cached is None or self.cached[0] != version:
            self.cached = (version, validate_record(read_json(self.path)))
            self.snapshot_json = None
        return self.cached[1]

    def _write_record(self, path, record):
        """Reuse immutable comparison bytes within the same canonical JSON record."""
        snapshot = self.snapshot_json
        if snapshot is None or self.cached is None or record['snapshot'] != self.cached[1]['snapshot']:
            snapshot = json.dumps(record['snapshot'], ensure_ascii=False, separators=(',', ':')).encode()
        def chunks():
            yield b'{\n'
            for index, (key, value) in enumerate(record.items()):
                if index:
                    yield b',\n'
                yield (json.dumps(key) + ': ').encode()
                yield snapshot if key == 'snapshot' else json.dumps(value, ensure_ascii=False, indent=2).encode()
            yield b'\n}\n'
        atomic_chunks(path, chunks())
        return snapshot

    def patch(self, fields):
        """Replace mutable fields without copying the unchanged source comparison."""
        with self.transaction():
            previous = self._record()
            if not fields.keys() <= previous.keys() - {'schema', 'snapshot'}:
                raise ValueError('A state update cannot replace the source comparison or record format.')
            record = validate_record({**previous, **copy.deepcopy(fields)})
            self.snapshot_json = self._write_record(self.path, record)
            stat = self.path.stat()
            self.cached = ((stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns), record)

    def backup_request(self, request):
        folder = self.directory / 'conflicting-drafts'
        folder.mkdir(exist_ok=True)
        atomic_json(folder / (secrets.token_hex(12) + '.json'), request)

    def archive(self, record):
        with self.lock:
            folder = self.directory / 'versions'
            folder.mkdir(exist_ok=True)
            self._write_record(folder / f'{record["revision"]:08d}.json', record)

    def commit(self, record, files=None):
        with self.lock:
            validate_record(record)
            if self.journal.exists():
                raise ValueError('An interrupted manuscript save needs recovery before another write.')
            if files:
                # The journal is durable before any manuscript write. Recovery completes
                # the exact same transaction, refusing any intervening external edits.
                atomic_json(self.journal, {'record': record, 'files': files})
                self.recover()
                self.snapshot_json = None
            else:
                self.snapshot_json = self._write_record(self.path, record)
            stat = self.path.stat()
            self.cached = ((stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns), copy.deepcopy(record))

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
            plan.append((destination, item))
        for destination, item in plan:
            current = destination.read_bytes().decode() if destination.exists() else None
            if destination.is_symlink() or not destination.resolve().is_relative_to(repo) or current not in (item['before'], item['after']):
                raise ValueError(f'{item["path"]} changed during an interrupted save. The draft is retained in {self.journal}.')
            content = item['after']
            if current == content:
                continue
            if content is None:
                destination.unlink(missing_ok=True)
                sync_directory(destination.parent)
            else:
                atomic_bytes(destination, content.encode())
        for destination, item in plan:
            current = destination.read_bytes().decode() if destination.exists() else None
            if current != item['after']:
                raise ValueError(f'{item["path"]} changed during an interrupted save. The draft is retained in {self.journal}.')
        atomic_json(self.path, transaction['record'])
        self.journal.unlink()
        sync_directory(self.directory)
