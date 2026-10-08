"""A persistent library of independent manuscript review snapshots."""
import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

from .comparison import build_snapshot, git
from .feedback import feedback_report
from .history import build_history
from .versions import selected_version
from .repositories import inspect_repo, working_snapshot, find_repositories, clone_repository, fetch_repository
from .storage import FileLock, ReviewStore, atomic_json, new_record, validate_record, read_json
from .server import create_server
from .session import ReviewSession
from .application import is_applied
from .editing import selected_content
from .http import LocalHandler
from .setup import setup_status, install_skill

def default_home():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/Manuscript Review'
    return Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'manuscript-review'


class Library:
    def __init__(self, home):
        self.home = Path(home).expanduser().resolve()
        self.reviews = self.home / 'reviews'
        self.reviews.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.servers = {}
        self.jobs = {}
        self.preview_lock = threading.Lock()
        self.url = None
        self.token = secrets.token_urlsafe(32)

    def directory(self, identifier):
        if not re.fullmatch(r'[a-f0-9]{24}', identifier):
            raise ValueError('Invalid review identifier.')
        directory = self.reviews / identifier
        if not directory.is_dir():
            raise ValueError('Review not found.')
        return directory

    def metadata(self, identifier):
        store = ReviewStore(self.directory(identifier))
        with store.transaction():
            return store.read()['metadata']

    def inspect(self, path):
        repositories = find_repositories(path)
        if len(repositories) > 1:
            return {'repositories': repositories}
        info = inspect_repo(repositories[0])
        info['checkpoints'] = []
        reviews = [review for review in self.listing() if review['repo'] == info['repo']]
        for index, review in enumerate(reviews):
            store = ReviewStore(self.directory(review['id']))
            with store.transaction():
                record = store.read()
            info['checkpoints'].append({'revision': record['result'], 'subject': f'Round {len(reviews)-index}: ' + review['title'],
                                        'date': review['created'][:10], 'short': record['result'][:7]})
        if info['checkpoints']:
            info['base'] = info['checkpoints'][0]['revision']
        working, _ = working_snapshot(info['repo']) if info['dirty'] else (info['head'], info['head'])
        info['working_version'] = working
        revisions = list(dict.fromkeys([working, *[r['revision'] for r in info['commits']],
                                       *[r['revision'] for r in info['references']],
                                       *[r['revision'] for r in info['checkpoints']]]))
        trees = git(info['repo'], 'rev-parse', *[revision + '^{tree}' for revision in revisions]).decode().splitlines()
        info['trees'] = dict(zip(revisions, trees))
        return info

    def begin(self, identifier):
        store = ReviewStore(self.directory(identifier))
        with store.transaction():
            record = store.read()
            if record['drafts']:
                raise ValueError('Save or discard the active source drafts before beginning another round.')
            repo = Path(record['snapshot']['repo'])
            for file in record['snapshot']['files']:
                path = repo / file['path']
                actual = path.read_bytes().decode() if path.is_file() else None
                if actual != selected_content(file, record['decisions']):
                    raise ValueError('The working manuscript differs from your saved choices. Apply the review or compare the latest working files first.')
            starting, head = working_snapshot(repo, parent=record['result'])
            git(repo, 'update-ref', f'refs/manuscript-review/{identifier}/inputs/{starting}', starting)
            return {'review': identifier, 'revision': record['revision'], 'starting_version': starting,
                    'baseline': record['baseline'], 'source_head': head}

    def repository_job(self, operation, *arguments):
        job = secrets.token_hex(12)
        self.jobs[job] = {'status': 'loading'}
        def work():
            try:
                repo = operation(*arguments)
                self.jobs[job] = {'status': 'ready', 'repo': repo}
            except Exception as error:
                self.jobs[job] = {'status': 'error', 'error': str(error)}
        threading.Thread(target=work, daemon=True).start()
        return job

    def listing(self):
        results = []
        with self.lock:
            for folder in self.reviews.iterdir():
                path = folder / 'review.json'
                if not path.is_file():
                    continue
                store = ReviewStore(folder)
                with store.transaction():
                    record = store.read()
                metadata, snapshot, choices = record['metadata'], record['snapshot'], record['decisions']
                edits = [g for f in snapshot['files'] for g in f['edits']]
                done = sum(choices.get(g['id'], 'pending') != 'pending' for g in edits)
                results.append({**metadata, 'total': len(edits), 'done': done, 'applied': is_applied(record),
                                'comments': sum(bool(text.strip()) for text in record['comments'].values()) + sum(
                                    entry['kind'] == 'source' and not entry['replies']
                                    and bool(entry['comment'].strip()) for entry in record['history']),
                                'drafts': len(record['drafts']),
                                'files': len(snapshot['files']), 'skipped': snapshot.get('skipped', [])})
        return sorted(results, key=lambda r: r['created'], reverse=True)

    def prepared_result(self, identifier, reused=False):
        store = ReviewStore(self.directory(identifier))
        with store.transaction():
            record = store.read()
        return {'status': 'ready', 'review': identifier, 'reused': reused,
                'edits': sum(len(f['edits']) for f in record['snapshot']['files']),
                'starting_version': record['snapshot']['base'], 'baseline': record['baseline']}

    def prepare(self, request, job):
        try:
            info = inspect_repo(request['repo'])
            repo = info['repo']
            base_ref = request.get('base', info['base']).strip()
            previous_id = request.get('previous')
            saved = None
            baseline = None
            if previous_id:
                previous_dir = self.directory(previous_id)
                previous_store = ReviewStore(previous_dir)
                with previous_store.transaction():
                    saved = previous_store.read()
                if saved['snapshot']['repo'] != repo:
                    raise ValueError('Earlier feedback belongs to a different repository.')
                if request.get('manuscript'):
                    self.jobs[job] = self.prepared_result(previous_id, reused=True)
                    return
                if saved['drafts']:
                    raise ValueError('Save or discard the active source drafts before starting another round.')
                if 'expected_revision' in request and request['expected_revision'] != saved['revision']:
                    raise ValueError('The earlier review changed during this pass. Reread its feedback before finishing.')
                baseline = saved['baseline']
                base_ref = selected_version(saved)
                if request.get('starting_version'):
                    starting = request['starting_version']
                    if not re.fullmatch(r'[a-f0-9]{40}', starting):
                        raise ValueError('Use the starting version returned by begin.')
                    pinned = git(repo, 'rev-parse', f'refs/manuscript-review/{previous_id}/inputs/{starting}').decode().strip()
                    if pinned != starting:
                        raise ValueError('The starting version belongs to a different review.')
                    base_ref = starting
            if request.get('manuscript'):
                starting, head = working_snapshot(repo, parent=saved['result'] if saved else None)
                base_ref = starting
            proposed_ref = request.get('proposed', 'working').strip()
            if request.get('manuscript'):
                proposed_ref = starting
            base = git(repo, 'rev-parse', '--verify', base_ref + '^{commit}').decode().strip()
            if proposed_ref == 'working':
                proposed, source_head = working_snapshot(repo, parent=base)
            else:
                proposed = git(repo, 'rev-parse', '--verify', proposed_ref + '^{commit}').decode().strip()
                # A branch comparison may be viewed/exported anywhere. Applying
                # still requires its actual proposed contents and unchanged HEAD.
                source_head = proposed
            if request.get('manuscript'):
                source_head = head
            entry = request.get('entry', '')
            if entry:
                relative = Path(entry)
                if relative.is_absolute() or '..' in relative.parts or relative.suffix != '.tex':
                    raise ValueError('Choose a LaTeX entry file relative to the repository.')
            tree = git(repo, 'rev-parse', proposed + '^{tree}').decode().strip()
            if saved:
                old_tree = git(repo, 'rev-parse', base + '^{tree}').decode().strip()
                if old_tree == tree:
                    if request.get('require_changes'):
                        raise ValueError('No source changes since this pass began. Add a reply in the existing round instead.')
                    self.jobs[job] = self.prepared_result(previous_id, reused=True)
                    return
            identity = [repo, baseline or base, base, tree, source_head, entry, previous_id, saved['revision'] if saved else None]
            identifier = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
            directory = self.reviews / identifier
            with self.lock:
                if (directory / 'review.json').exists():
                    self.jobs[job] = self.prepared_result(identifier, reused=True)
                    return
            snapshot = build_snapshot(repo, base, proposed, text_only=True)
            snapshot.update({'source_head': source_head, 'entry': entry})
            if not snapshot['files'] and not previous_id and not request.get('manuscript'):
                raise ValueError('No changed text files between these versions.')
            if not snapshot['files'] and request.get('require_changes'):
                raise ValueError('No reviewable source changes in this pass. Add a reply in the existing round instead.')
            choices, comments, history = {}, {}, []
            if saved:
                report = feedback_report(saved['snapshot'], saved['decisions'], saved['comments'], saved['history'])
                history = build_history(saved['snapshot'], snapshot, saved, report, saved['history'], previous_dir)
            with self.lock, FileLock(self.home / '.prepare.lock'):
                if (directory / 'review.json').exists():
                    self.jobs[job] = self.prepared_result(identifier, reused=True)
                    return
                directory.mkdir(exist_ok=True)
                # Keep both immutable source versions reachable for future TeX
                # regeneration, including an otherwise unreachable working copy.
                git(repo, 'update-ref', f'refs/manuscript-review/{identifier}/base', base)
                git(repo, 'update-ref', f'refs/manuscript-review/{identifier}/proposed', proposed)
                git(repo, 'update-ref', f'refs/manuscript-review/{identifier}/baseline', baseline or base)
                metadata = {
                    'id': identifier, 'repo': repo, 'title': saved['metadata']['title'] if saved else Path(repo).name,
                    'base': base_ref, 'proposed': proposed_ref, 'entry': entry,
                    'base_label': f'Starting draft ({base[:7]})' if saved else request.get('base_label', base[:7]),
                    'baseline_label': saved['metadata'].get('baseline_label', saved['metadata']['base_label']) if saved else request.get('base_label', base[:7]),
                    'proposal_label': ('Working copy' if proposed_ref == 'working' else proposed_ref) + f' ({proposed[:7]})',
                    'created': snapshot['created'], 'preview_status': 'queued' if entry else 'none',
                    'previous': previous_id, 'previous_revision': saved['revision'] if saved else None}
                if saved:
                    with previous_store.transaction():
                        if previous_store.read()['revision'] != saved['revision']:
                            raise ValueError('The earlier review changed while preparing this round. Try again.')
                record = new_record(snapshot, metadata, choices, comments, history, baseline=baseline)
                if request.get('manuscript'):
                    record['ui']['scope'] = 'manuscript'
                atomic_json(directory / 'review.json', record)
                self.jobs[job] = self.prepared_result(identifier)
        except Exception as error:
            message = error.stderr.decode(errors='replace').strip() if isinstance(error, subprocess.CalledProcessError) and isinstance(error.stderr, bytes) else str(error)
            self.jobs[job] = {'status': 'error', 'error': message}

    def start(self, request):
        job = secrets.token_hex(12)
        self.jobs[job] = {'status': 'preparing'}
        def work():
            self.prepare(request, job)
            result = self.jobs[job]
            if result['status'] == 'ready' and self.metadata(result['review'])['preview_status'] in ('queued', 'rendering'):
                self.preview(result['review'])
        threading.Thread(target=work, daemon=True).start()
        return job

    def manuscript_request(self, repo, entry=''):
        repo = inspect_repo(str(Path(repo).expanduser().resolve()))['repo']
        previous = next((review for review in self.listing() if review['repo'] == repo), None)
        return {'repo': repo, 'entry': entry, 'manuscript': True,
                'previous': previous['id'] if previous else None}

    def preview(self, identifier):
        with self.preview_lock:
            if self.metadata(identifier)['preview_status'] != 'ready':
                self._preview(identifier)

    def resume_previews(self):
        for review in self.listing():
            if review['preview_status'] in ('queued', 'rendering'):
                threading.Thread(target=self.preview, args=(review['id'],), daemon=True).start()

    def _preview(self, identifier):
        ReviewSession(self.directory(identifier), self.url).previews.render()

    def import_review(self, source):
        source = Path(source).expanduser().resolve()
        record = validate_record(read_json(source / 'review.json' if source.is_dir() else source))
        identifier = secrets.token_hex(12)
        destination = self.reviews / identifier
        destination.mkdir()
        record['snapshot']['token'] = secrets.token_urlsafe(32)
        record['metadata'].update(id=identifier, imported_from=str(source))
        snapshot = record['snapshot']
        git(snapshot['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/base', snapshot['base'])
        git(snapshot['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/proposed', snapshot['proposed'])
        git(snapshot['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/result', record['result'])
        git(snapshot['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/baseline', record['baseline'])
        if source.is_dir() and (source / 'renders').is_dir():
            shutil.copytree(source / 'renders', destination / 'renders')
        elif snapshot['entry']:
            record['metadata']['preview_status'] = 'queued'
        atomic_json(destination / 'review.json', record)
        return identifier

    def open(self, identifier, scope=None):
        with self.lock:
            if scope is not None:
                if scope not in ('round', 'baseline', 'manuscript'):
                    raise ValueError('Unknown manuscript view.')
                store = ReviewStore(self.directory(identifier))
                with store.transaction():
                    record = store.read()
                    record['ui']['scope'] = scope
                    store.commit(record)
            if identifier not in self.servers:
                server = create_server(self.directory(identifier), library_url=self.url,
                                       review_context=lambda: self.review_context(identifier))
                self.servers[identifier] = server
                threading.Thread(target=server.serve_forever, daemon=True).start()
            atomic_json(self.home / 'library.json', {'last_opened': identifier})
            return f'http://127.0.0.1:{self.servers[identifier].server_address[1]}/'

    def review_context(self, identifier):
        current = self.metadata(identifier)
        rounds = [r for r in self.listing() if r['repo'] == current['repo']]
        index = next(i for i, r in enumerate(rounds) if r['id'] == identifier)
        return {'manuscript': Path(current['repo']).name, 'round_number': len(rounds)-index,
                'latest_review': rounds[0]['id']}


def create_library_server(library, port=0):
    class Handler(LocalHandler):
        def do_GET(self):
            if not self.trusted():
                return self.response({'error': 'Unexpected host or origin.'}, status=403)
            if self.path in ('/', '/library.js', '/review_model.js'):
                name = 'library.html' if self.path == '/' else self.path[1:]
                return self.response(Path(__file__).with_name(name).read_bytes(), 'text/html' if name.endswith('.html') else 'text/javascript')
            if self.path == '/library-data':
                return self.response({'token': library.token, 'reviews': library.listing()})
            if self.path == '/setup':
                return self.response(setup_status())
            if self.path.startswith('/jobs/'):
                return self.response(library.jobs.get(self.path[6:], {'status': 'error', 'error': 'Preparation not found.'}))
            return self.response({'error': 'Not found.'}, status=404)

        def do_POST(self):
            if not self.trusted() or self.headers.get('X-Review-Token') != library.token:
                return self.response({'error': 'Unexpected origin or token.'}, status=403)
            try:
                request = self.read_request(limit=100_000)
                if self.path == '/inspect':
                    result = library.inspect(request['repo'])
                elif self.path == '/clone':
                    result = {'job': library.repository_job(clone_repository, request['url'], request['directory'])}
                elif self.path == '/fetch':
                    repo = inspect_repo(request['repo'])['repo']
                    result = {'job': library.repository_job(fetch_repository, repo)}
                elif self.path == '/prepare':
                    result = {'job': library.start(request)}
                elif self.path == '/manuscript':
                    result = {'job': library.start(library.manuscript_request(request['repo'], request.get('entry', '')))}
                elif self.path == '/open':
                    result = {'url': library.open(request['id'], request.get('scope'))}
                elif self.path == '/update':
                    metadata = library.metadata(request['id'])
                    update = {**metadata, 'proposed': 'working', 'previous': request['id'],
                              'require_changes': request.get('require_changes', False)}
                    if 'expected_revision' in request:
                        update['expected_revision'] = request['expected_revision']
                    result = {'job': library.start(update)}
                elif self.path == '/import':
                    result = {'review': library.import_review(request['source'])}
                elif self.path == '/install-skill':
                    result = install_skill(request['agent'])
                else:
                    raise ValueError('Unknown action.')
                self.response(result)
            except Exception as error:
                message = error.stderr.decode(errors='replace').strip() if isinstance(error, subprocess.CalledProcessError) and isinstance(error.stderr, bytes) else str(error)
                self.response({'error': message}, status=400)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    library.url = f'http://127.0.0.1:{server.server_address[1]}/'
    return server


def main():
    parser = argparse.ArgumentParser(description='Open a local manuscript review library.')
    parser.add_argument('--home', type=Path, default=default_home())
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--import-review', type=Path)
    parser.add_argument('--native', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--review', help='Open a saved review at startup.')
    args = parser.parse_args()
    if args.native:
        try:
            os.setsid()
        except OSError:
            pass
    library = Library(args.home)
    if args.import_review:
        library.import_review(args.import_review)
    server = create_library_server(library, args.port)
    library.resume_previews()
    identifier = args.review or read_json(library.home / 'library.json', {}).get('last_opened')
    url = library.open(identifier) if identifier and (library.reviews / identifier).is_dir() else library.url
    print(json.dumps({'url': url, 'library_url': library.url}), flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
