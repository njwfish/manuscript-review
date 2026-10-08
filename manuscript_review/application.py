"""Validate working files before committing a review and its source writes together."""
import hashlib
from pathlib import Path
from .comparison import git
from .editing import selected_content
from .storage import FileLock


def digest(content):
    return None if content is None else hashlib.sha256(content.encode()).hexdigest()


def is_applied(record):
    files = record['snapshot']['files']
    return bool(files) and all(file['path'] in record['applied']
                              and record['applied'][file['path']] == digest(selected_content(file, record['decisions']))
                              for file in files)


def repository_lock(repo):
    common = Path(git(repo, 'rev-parse', '--git-common-dir').decode().strip())
    return FileLock((common if common.is_absolute() else Path(repo) / common) / 'manuscript-review.lock')


def apply_record(store, previous, record, only_file=None):
    snapshot, repo = previous['snapshot'], Path(previous['snapshot']['repo']).resolve()
    with repository_lock(repo):
        if git(repo, 'rev-parse', 'HEAD').decode().strip() != snapshot['source_head']:
            # A commit cannot prevent acknowledging a selection already on disk.
            # Any actual source write still requires the original HEAD.
            files = record['snapshot']['files']
            if only_file is None and files and all(
                    not (repo / file['path']).is_symlink()
                    and (repo / file['path']).resolve().is_relative_to(repo)
                    and ((repo / file['path']).read_bytes().decode() if (repo / file['path']).exists() else None)
                        == selected_content(file, record['decisions']) for file in files):
                record['applied'].update({file['path']: digest(selected_content(file, record['decisions'])) for file in files})
                store.commit(record)
                return 0
            raise ValueError('HEAD changed since this review. Open New round in the Library to compare the current manuscript.')
        if git(repo, 'diff', '--cached', '--name-only').strip():
            raise ValueError('Resolve staged changes before saving to the manuscript.')
        store.recover()
        old_files = {f['path']: f for f in snapshot['files']}
        new_files = {f['path']: f for f in record['snapshot']['files']}
        paths = [only_file] if only_file else list(old_files.keys() | new_files.keys())
        plan = []
        for path in paths:
            destination = repo / path
            if destination.is_symlink() or not destination.resolve().is_relative_to(repo):
                raise ValueError('Unsafe manuscript path: ' + path)
            current = destination.read_bytes().decode() if destination.exists() else None
            before = old_files[path]['after'] if path in old_files else new_files[path]['before']
            expected = previous['applied'].get(path, digest(before))
            if digest(current) != expected:
                raise ValueError(f'{path} was edited outside this review. Your draft is retained; update the comparison first.')
            content = (selected_content(new_files[path], record['decisions']) if path in new_files
                       else old_files[path]['before'])
            record['applied'][path] = digest(content)
            if content != current:
                plan.append({'path': path, 'before': current, 'after': content})
        if plan:
            store.archive(previous)
        store.commit(record, plan)
    return len(plan)
