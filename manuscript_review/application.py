"""Validate working files before committing a review and its source writes together."""
import hashlib
from pathlib import Path
from .comparison import git
from .editing import selected_content, projection_blocks, mapped_range
from .file_editing import replace_ranges
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


def check_checkout(store, previous, repo):
    if git(repo, 'rev-parse', 'HEAD').decode().strip() != previous['snapshot']['source_head']:
        raise ValueError('HEAD changed since this review. Open New round in the Library to compare the current manuscript.')
    if git(repo, 'diff', '--cached', '--name-only').strip():
        raise ValueError('Resolve staged changes before saving to the manuscript.')
    store.recover()


def checked_content(previous, repo, path, initial):
    destination = repo / path
    if destination.is_symlink() or not destination.resolve().is_relative_to(repo):
        raise ValueError('Unsafe manuscript path: ' + path)
    current = destination.read_bytes().decode() if destination.exists() else None
    expected = previous['applied'].get(path, digest(initial))
    if digest(current) != expected:
        raise ValueError(f'{path} was edited outside this review. Your draft is retained; update the comparison first.')
    return current


def commit_sources(store, previous, record, changes):
    plan = []
    for path, before, after in changes:
        record['applied'][path] = digest(after)
        if before != after:
            plan.append({'path': path, 'before': before, 'after': after})
    if plan:
        store.archive(previous)
    store.commit(record, plan)
    return len(plan)


def write_file_edit(store, previous, record, file, replacements, decisions):
    """Write manual intervals without applying decisions elsewhere in the file."""
    repo = Path(previous['snapshot']['repo']).resolve()
    with repository_lock(repo):
        check_checkout(store, previous, repo)
        current = checked_content(previous, repo, file['path'], file['after'])
        selected = projection_blocks(file, selected_content(file, decisions) or '')
        working = projection_blocks(file, current or '')
        # Compose through ordered source segments, preserving intervals that
        # disappear entirely in the proposal (for example a rejected deletion).
        blocks = [(a, b, c, d, identifier) for (_, _, a, b, identifier), (_, _, c, d, _) in zip(selected, working)]
        changes = [(*mapped_range(blocks, (start, end), {identifier for a, b, _, _, identifier in blocks if a == b and start <= a <= end}), text)
                   for start, end, text in replacements]
        content = replace_ranges(current or '', changes)
        revised = next((f for f in record['snapshot']['files'] if f['path'] == file['path']), None)
        if revised:
            projection_blocks(revised, content)
        elif content != file['before']:
            raise ValueError('The manual changes could not preserve the working source. Your draft is retained.')
        return commit_sources(store, previous, record, [(file['path'], current, content)])


def apply_record(store, previous, record):
    snapshot, repo = previous['snapshot'], Path(previous['snapshot']['repo']).resolve()
    with repository_lock(repo):
        if git(repo, 'rev-parse', 'HEAD').decode().strip() != snapshot['source_head']:
            # A commit cannot prevent acknowledging a selection already on disk.
            # Any actual source write still requires the original HEAD.
            files = record['snapshot']['files']
            if files and all(
                    not (repo / file['path']).is_symlink()
                    and (repo / file['path']).resolve().is_relative_to(repo)
                    and ((repo / file['path']).read_bytes().decode() if (repo / file['path']).exists() else None)
                        == selected_content(file, record['decisions']) for file in files):
                record['applied'].update({file['path']: digest(selected_content(file, record['decisions'])) for file in files})
                store.commit(record)
                return 0
            raise ValueError('HEAD changed since this review. Open New round in the Library to compare the current manuscript.')
        check_checkout(store, previous, repo)
        old_files = {f['path']: f for f in snapshot['files']}
        new_files = {f['path']: f for f in record['snapshot']['files']}
        changes = []
        for path in old_files.keys() | new_files.keys():
            before = old_files[path]['after'] if path in old_files else new_files[path]['before']
            current = checked_content(previous, repo, path, before)
            content = (selected_content(new_files[path], record['decisions']) if path in new_files
                       else old_files[path]['before'])
            changes.append((path, current, content))
        return commit_sources(store, previous, record, changes)
