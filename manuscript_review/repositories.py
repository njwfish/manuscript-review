"""Locate manuscript repositories, inspect Git versions, and capture working files."""
import os
import re
import subprocess
import tempfile
from pathlib import Path
from .comparison import git


def inspect_repo(path):
    candidate = Path(path).expanduser().resolve()
    repo = Path(git(candidate, 'rev-parse', '--show-toplevel').decode().strip())
    references = []
    for line in git(repo, 'for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(subject)', 'refs/heads', 'refs/remotes', 'refs/tags').decode().splitlines():
        name, _, subject = line.split('\0', 2)
        if name.endswith('/HEAD'):
            continue
        revision = git(repo, 'rev-parse', name + '^{commit}').decode().strip()
        references.append({'name': name, 'revision': revision, 'subject': subject})
    refs = [r['name'] for r in references]
    baseline = 'origin/main' if 'origin/main' in refs else 'origin/master' if 'origin/master' in refs else 'main' if 'main' in refs else 'master' if 'master' in refs else 'HEAD'
    entries = []
    for filename in git(repo, 'ls-files', '-z', '*.tex').decode().split('\0'):
        if not filename:
            continue
        file = repo / filename
        if file.is_file() and not file.is_symlink() and '\\documentclass' in file.read_text(errors='replace'):
            entries.append(filename)
    entries.sort(key=lambda p: (p not in ('main.tex', 'paper.tex', 'manuscript.tex'), len(p), p))
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    fields = git(repo, 'log', 'HEAD', '--branches', '--remotes', '--tags', '--date-order', '-n', '200', '-z',
                 '--format=%H%x00%h%x00%cs%x00%s%x00%D').decode().split('\0')
    commits = [dict(zip(('revision', 'short', 'date', 'subject', 'refs'), fields[i:i+5]))
               for i in range(0, len(fields)-4, 5)]
    base = git(repo, 'rev-parse', baseline + '^{commit}').decode().strip()
    dirty = bool(git(repo, 'status', '--porcelain', '--untracked-files=no').strip())
    if base == head and not dirty:
        parent = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--verify', 'HEAD^'], capture_output=True, text=True)
        if parent.returncode == 0:
            base = parent.stdout.strip()
    return {'repo': str(repo), 'refs': refs, 'references': references, 'commits': commits,
            'base': base, 'entries': entries, 'head': head, 'dirty': dirty, 'has_origin': bool(git(repo, 'remote', 'get-url', 'origin').strip()) if 'origin' in git(repo, 'remote').decode().splitlines() else False}


def working_snapshot(repo, parent=None):
    """Snapshot tracked working files with a separate Git index; leave HEAD/index alone."""
    repo = Path(repo)
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    if git(repo, 'ls-files', '--unmerged').strip():
        raise ValueError('Resolve Git merge conflicts before starting a review.')
    tracked = git(repo, 'ls-files', '-z') + git(repo, 'ls-tree', '-r', '--name-only', '-z', head)
    paths = b'\0'.join(sorted(set(filter(None, tracked.split(b'\0'))))) + b'\0'
    with tempfile.TemporaryDirectory(prefix='manuscript-review-index-') as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        def command(*args, input=None):
            result = subprocess.run(['git', '-C', str(repo), *args], input=input,
                                    env=env, capture_output=True, check=True)
            return result.stdout.decode().strip()
        command('read-tree', head)
        if paths:
            command('--literal-pathspecs', 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul', input=paths)
        tree = command('write-tree')
        parent = parent or head
        if tree == git(repo, 'rev-parse', parent + '^{tree}').decode().strip():
            return parent, head
        env.update({'GIT_AUTHOR_NAME': 'Manuscript Review', 'GIT_AUTHOR_EMAIL': 'review@localhost',
                    'GIT_COMMITTER_NAME': 'Manuscript Review', 'GIT_COMMITTER_EMAIL': 'review@localhost'})
        revision = command('commit-tree', tree, '-p', parent, input=b'Manuscript Review working-copy snapshot\n')
    if git(repo, 'rev-parse', 'HEAD').decode().strip() != head:
        raise ValueError('HEAD changed while preparing the comparison. Try again.')
    return revision, head


def find_repositories(path):
    path = Path(path).expanduser().resolve()
    if not path.is_dir():
        raise ValueError('Choose an existing manuscript folder.')
    found = []
    result = subprocess.run(['git', '-C', str(path), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if result.returncode == 0:
        found.append(Path(result.stdout.strip()))
    excluded = {'.git', '.venv', 'node_modules', 'build', 'dist', 'Library', '__pycache__'}
    for directory, children, _ in os.walk(path):
        current = Path(directory)
        if (current / '.git').exists() and current not in found:
            found.append(current)
        children[:] = [name for name in children if name not in excluded and not name.startswith('.')]
        if len(current.relative_to(path).parts) >= 2:
            children.clear()
    found = [repo for repo in found if repo.is_relative_to(path)] or found
    manuscripts = [repo for repo in found if git(repo, 'ls-files', '*.tex').strip()]
    if not manuscripts and not found:
        raise ValueError('No Git repository found here. Open its local folder or clone a repository from GitHub.')
    return [str(repo) for repo in (manuscripts or found)]


def clone_repository(url, directory):
    url = url.strip()
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?/?', url.strip())
    if not match or any(part in ('.', '..') for part in match.groups()):
        raise ValueError('Enter a GitHub repository URL, such as https://github.com/owner/manuscript.')
    owner, name = match.groups()
    parent = Path(directory).expanduser().resolve()
    if not parent.is_dir():
        raise ValueError('Choose an existing folder for the clone.')
    destination = parent / name
    if destination.exists():
        raise ValueError(f'{destination} already exists. Open it as a local folder instead.')
    remote = f'https://github.com/{owner}/{name}.git' if url.startswith('https:') else f'git@github.com:{owner}/{name}.git'
    result = subprocess.run(['git', 'clone', '--', remote, str(destination)], capture_output=True, text=True,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=300)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'Could not clone the repository. Check the URL and your GitHub credentials.')
    return str(destination)


def fetch_repository(repo):
    result = subprocess.run(['git', '-C', str(repo), 'fetch', 'origin'], capture_output=True, text=True,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=300)
    if result.returncode:
        raise ValueError('Could not fetch origin. Check your connection and GitHub credentials.')
    return str(Path(repo).resolve())
