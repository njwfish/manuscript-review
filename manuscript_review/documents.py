"""Selected manuscript files and comments anchored to exact source versions."""
from .comparison import compare, enrich_snapshot, git, read_blob


def document_file(record, path):
    snapshot = record['snapshot']
    existing = next((file for file in snapshot['files'] if file['path'] == path), None)
    if existing is not None:
        return existing
    entry = git(snapshot['repo'], 'ls-tree', snapshot['proposed'], '--', path).decode()
    if not path or not entry.startswith('100644 '):
        raise ValueError('Choose a regular manuscript source file.')
    before = read_blob(snapshot['repo'], snapshot['base'], path)
    after = read_blob(snapshot['repo'], snapshot['proposed'], path)
    if after is None or '\0' in after or len(after) > 1_000_000:
        raise ValueError('Choose a text file of at most 1,000,000 characters.')
    return enrich_snapshot({'files': [compare(path, before, after)]})['files'][0]


def manuscript_files(record):
    snapshot = record['snapshot']
    paths = git(snapshot['repo'], 'ls-tree', '-r', '--name-only', '-z', record['result']).decode().split('\0')
    files = []
    for path in filter(None, paths):
        if not path.endswith(('.tex', '.bib', '.md', '.txt', '.typ', '.rst')):
            continue
        try:
            files.append(document_file(record, path))
        except (ValueError, UnicodeError):
            continue
    entry = snapshot.get('entry')
    return sorted(files, key=lambda file: (file['path'] != entry, file['supporting'], file['path']))


def source_point(text, offset):
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError('A comment needs a valid text selection.')
    encoded = text.encode('utf-16-le')
    if offset * 2 > len(encoded):
        raise ValueError('The comment selection is outside the file.')
    try:
        return len(encoded[:offset * 2].decode('utf-16-le'))
    except UnicodeError as error:
        raise ValueError('The comment selection splits a character.') from error
