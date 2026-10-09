"""The source checkout and last captured wording used for author edits."""
from pathlib import Path
from .comparison import git


def working_directory(record):
    return Path(record['metadata'].get('workspace', record['snapshot']['repo'])).resolve()


def same_repository(left, right):
    def common(repo):
        value = Path(git(repo, 'rev-parse', '--git-common-dir').decode().strip())
        return (value if value.is_absolute() else Path(repo) / value).resolve()
    return common(left) == common(right)


def edit_checkout(directory, record):
    snapshot, metadata = record['snapshot'], record['metadata']
    repo = Path(snapshot['repo']).resolve()
    if 'workspace' in metadata:
        workspace = working_directory(record)
        if not workspace.is_dir() or not same_repository(repo, workspace):
            raise ValueError('The review checkout is unavailable. Restore it before editing.')
        return workspace, metadata['workspace_version']
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    if head == snapshot['source_head']:
        for version in dict.fromkeys((record['result'], snapshot['proposed'])):
            if not git(repo, 'diff', '--name-only', version, '--').strip():
                return repo, version
    workspace = Path(directory) / 'source' / repo.name
    if workspace.exists():
        if (not same_repository(repo, workspace)
                or git(workspace, 'rev-parse', 'HEAD').decode().strip() != record['result']
                or git(workspace, 'diff', '--name-only', record['result'], '--').strip()):
            raise ValueError('The review checkout contains other changes. Open it before continuing.')
    else:
        workspace.parent.mkdir(exist_ok=True)
        git(repo, 'worktree', 'add', '--detach', str(workspace), record['result'])
    return workspace.resolve(), record['result']
