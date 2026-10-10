"""Select project paths without crossing repository or ignored-folder boundaries."""
import subprocess
from pathlib import Path


def project_paths(repo, paths):
    root = Path(repo)
    excluded, eligible = [], []
    folders = {}
    for path in paths:
        parents = Path(path).parts[:-1]
        omit = False
        for index, part in enumerate(parents, 1):
            folder = Path(*parents[:index])
            if folder not in folders:
                folders[folder] = (part.startswith('.') or part in ('tmp', 'temp', '__pycache__', 'node_modules')
                                   or (root / folder / '.git').exists())
            if folders[folder]:
                omit = True
                break
        (excluded if omit else eligible).append(path)
    if eligible:
        checked = subprocess.run(['git', '-C', str(root), 'check-ignore', '--no-index', '-z', '--stdin'],
                                 input=('\0'.join(eligible)+'\0').encode(), capture_output=True)
        if checked.returncode not in (0, 1):
            raise ValueError(checked.stderr.decode(errors='replace').strip())
        ignored = set(filter(None, checked.stdout.decode().split('\0')))
        excluded.extend(path for path in eligible if path in ignored)
        eligible = [path for path in eligible if path not in ignored]
    return eligible, excluded
