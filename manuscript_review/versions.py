"""Create reachable source versions without touching the checkout or Git index."""
import os
import subprocess
import tempfile
from pathlib import Path


def source_version(repo, parent, contents, reference, message, reuse=None):
    with tempfile.TemporaryDirectory(prefix='review-index-') as temporary:
        environment = {**os.environ, 'GIT_INDEX_FILE': str(Path(temporary) / 'index'),
                       'GIT_AUTHOR_NAME': 'Manuscript Review', 'GIT_AUTHOR_EMAIL': 'review@localhost',
                       'GIT_COMMITTER_NAME': 'Manuscript Review', 'GIT_COMMITTER_EMAIL': 'review@localhost'}
        def command(*args, input=None):
            return subprocess.check_output(['git', '-C', str(repo), *args], env=environment, input=input).decode().strip()
        command('read-tree', parent)
        for path, content in contents.items():
            if content is None:
                command('update-index', '--force-remove', '--', path)
            else:
                blob = command('hash-object', '-w', '--stdin', input=content.encode())
                command('update-index', '--add', '--cacheinfo', '100644', blob, path)
        tree = command('write-tree')
        if tree == command('rev-parse', parent + '^{tree}'):
            revision = parent
        elif reuse and tree == command('rev-parse', reuse + '^{tree}'):
            revision = reuse
        else:
            revision = command('commit-tree', tree, '-p', parent, input=(message + '\n').encode())
        command('update-ref', reference + '/' + revision, revision)
        return revision


def selected_version(record):
    from .editing import selected_content
    snapshot = record['snapshot']
    contents = {file['path']: selected_content(file, record['decisions']) for file in snapshot['files']
                if selected_content(file, record['decisions']) != file['after']}
    if not contents:
        return snapshot['proposed']
    return source_version(snapshot['repo'], snapshot['proposed'], contents,
                          'refs/manuscript-review/' + record['metadata']['id'] + '/results',
                          'Manuscript Review selected wording', reuse=record.get('result'))
