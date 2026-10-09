import json
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_review import ReviewFixture
from manuscript_review.library import Library, inspect_repo, working_snapshot
from manuscript_review.library import create_library_server
from manuscript_review.setup import install_skill
from unittest.mock import patch
from manuscript_review.server import create_server
from manuscript_review.storage import ReviewStore
from manuscript_review.comparison import git
from manuscript_review.session import ReviewSession


class LibraryTests(ReviewFixture):
    def test_comparison_from_an_inspected_draft_keeps_choices_feedback_and_baseline(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working'}, 'one')
        identifier = library.jobs['one']['review']
        session = ReviewSession(library.directory(identifier))
        record = session.store.read()
        edit = record['snapshot']['files'][0]['edits'][0]
        session.update('save', {'revision': record['revision'], 'decisions': {edit['id']: 'reject'},
                               'comments': {edit['id']: 'Keep my original wording.'}})
        before = session.store.path.read_bytes()
        record = session.store.read()
        checkpoint = library.inspect(str(self.repo))['checkpoints'][0]
        self.assertEqual(checkpoint['revision'], record['result'])
        self.assertEqual(checkpoint['review'], identifier)
        self.assertEqual(checkpoint['review_revision'], record['revision'])
        request = {'repo': str(self.repo), 'base': checkpoint['revision'], 'previous': checkpoint['review'],
                   'expected_revision': checkpoint['review_revision'], 'proposed': 'working',
                   'proposed_label': 'Working files', 'require_changes': True}
        library.prepare(request, 'two')
        self.assertEqual(library.jobs['two']['status'], 'ready')
        revised = ReviewStore(library.directory(library.jobs['two']['review'])).read()
        self.assertEqual(revised['snapshot']['base'], record['result'])
        self.assertEqual(revised['baseline'], self.base)
        self.assertEqual(revised['metadata']['previous'], identifier)
        self.assertEqual(revised['history'][0]['comment'], 'Keep my original wording.')
        self.assertTrue(revised['metadata']['proposal_label'].startswith('Working files ('))
        self.assertEqual(session.store.path.read_bytes(), before)
        session.update('save', {'revision': record['revision'], 'decisions': {}, 'comments': record['comments']})
        library.prepare(request, 'stale')
        self.assertEqual(library.jobs['stale']['status'], 'error')
        self.assertIn('earlier review changed', library.jobs['stale']['error'])

    def test_git_comparison_retains_the_readable_proposal_label_and_pinned_version(self):
        library = Library(self.root / 'library')
        proposed = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        library.prepare({'repo': str(self.repo), 'base': self.base, 'base_label': 'origin/main',
                         'proposed': proposed, 'proposed_label': 'Revised argument'}, 'comparison')
        record = ReviewStore(library.directory(library.jobs['comparison']['review'])).read()
        self.assertEqual(record['snapshot']['proposed'], proposed)
        self.assertEqual(record['metadata']['proposal_label'], f'Revised argument ({proposed[:7]})')

    def test_update_forwards_the_pinned_revision_and_refuses_an_empty_source_pass(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working'}, 'initial')
        identifier = library.jobs['initial']['review']
        store = ReviewStore(library.directory(identifier))
        before = store.path.read_bytes()
        server = create_library_server(library)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            body = {'id': identifier, 'expected_revision': store.read()['revision'], 'require_changes': True}
            request = Request(library.url + 'update', json.dumps(body).encode(),
                              headers={'Content-Type': 'application/json', 'X-Review-Token': library.token})
            with patch.object(library, 'start', return_value='captured') as start:
                self.assertEqual(json.load(urlopen(request))['job'], 'captured')
            prepared = start.call_args.args[0]
            self.assertTrue(prepared['require_changes'])
            self.assertEqual(prepared['expected_revision'], body['expected_revision'])
            library.prepare(prepared, 'empty')
            self.assertEqual(library.jobs['empty']['status'], 'error')
            self.assertIn('No source changes', library.jobs['empty']['error'])
            self.assertEqual(store.path.read_bytes(), before)
            self.assertEqual(len(library.listing()), 1)
        finally:
            server.shutdown(); server.server_close()

    def test_passage_response_returns_library_context_after_releasing_the_record(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working'}, 'one')
        identifier = library.jobs['one']['review']
        url = library.open(identifier)
        record = ReviewStore(library.directory(identifier)).read()
        file = next(f for f in record['snapshot']['files'] if f['path'] == 'main.tex')
        passage = file['hunks'][0]
        request = Request(url + 'file', json.dumps({'revision': record['revision'], 'decisions': {},
                          'comments': {}, 'file': 'main.tex', 'source': record['result'], 'text': file['after'].replace(passage['after'], 'Author’s passage.', 1)}).encode(),
                          headers={'Content-Type': 'application/json', 'X-Review-Token': record['snapshot']['token']})
        try:
            result = json.load(urlopen(request, timeout=5))
            self.assertEqual(result['revision'], result['data']['revision'])
            self.assertEqual(result['data']['round_number'], 1)
            self.assertEqual(result['data']['latest_review'], identifier)
            self.assertTrue((self.repo / 'main.tex').read_text().startswith('Author’s passage.'))
        finally:
            library.servers[identifier].shutdown();library.servers[identifier].server_close()

    def test_skill_install_route_requires_the_library_token(self):
        library = Library(self.root / 'library')
        server = create_library_server(library)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def request(token):
            return Request(library.url + 'install-skill', json.dumps({'agent': 'codex'}).encode(),
                           headers={'Content-Type': 'application/json', 'X-Review-Token': token})
        target = self.root / 'agent-home/.agents/skills/manuscript-review'
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(request('wrong'))
            self.assertEqual(error.exception.code, 403)
            self.assertFalse(target.exists())
            with patch('manuscript_review.library.install_skill', side_effect=lambda agent: install_skill(agent, self.root / 'agent-home')):
                self.assertIn('installed', json.load(urlopen(request(library.token)))['message'])
            self.assertTrue((target / 'SKILL.md').is_file())
        finally:
            server.shutdown();server.server_close()

    def test_library_create_update_and_clean_import(self):
        library = Library(self.root / 'library')
        request = {'repo':str(self.repo),'base':self.base,'proposed':'working','entry':''}
        library.prepare(request,'one')
        self.assertEqual(library.jobs['one']['status'], 'ready')
        identifier=library.jobs['one']['review'];store=ReviewStore(library.directory(identifier))
        record=store.read();g=record['snapshot']['files'][0]['edits'][0]
        record['comments'][g['id']]='Original request';record['decisions'][g['id']]='accept';store.commit(record)
        library.prepare(request,'same');self.assertEqual(library.jobs['same']['review'],identifier)
        self.assertEqual(library.listing()[0]['done'],1)
        imported=library.import_review(library.directory(identifier))
        copied=ReviewStore(library.directory(imported)).read()
        self.assertEqual(copied['comments'],record['comments'])
        self.assertNotEqual(copied['snapshot']['token'],record['snapshot']['token'])
        path=self.repo/'main.tex';path.write_text(path.read_text().replace('measured leaves','selected leaves'))
        library.prepare({**request,'previous':identifier},'next')
        second=ReviewStore(library.directory(library.jobs['next']['review'])).read()
        self.assertEqual(second['history'][0]['comment'],'Original request')
        self.assertEqual(store.read(),record)

    def test_working_snapshot_preserves_staged_index(self):
        path=self.repo/'main.tex';path.write_text('Staged source');git(self.repo,'add','main.tex');path.write_text('Working source')
        index=git(self.repo,'ls-files','--stage');head=git(self.repo,'rev-parse','HEAD')
        revision,_=working_snapshot(self.repo)
        self.assertEqual(git(self.repo,'show',revision+':main.tex'), b'Working source')
        self.assertEqual(git(self.repo,'ls-files','--stage'),index)
        self.assertEqual(git(self.repo,'rev-parse','HEAD'),head)

    def test_http_requires_revision_and_preserves_notes_across_windows(self):
        server=create_server(self.directory)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base='http://127.0.0.1:'+str(server.server_address[1])
        token=self.session.snapshot['token']
        def post(value):
            request=Request(base+'/save',json.dumps(value).encode(),headers={'Content-Type':'application/json','X-Review-Token':token})
            return json.load(urlopen(request))
        try:
            initial=self.request(comments={self.file()['edits'][0]['id']: 'Saved note'})
            self.assertEqual(post(initial)['revision'],1)
            with self.assertRaises(HTTPError) as error:post(initial)
            self.assertEqual(error.exception.code,409)
            self.assertTrue(json.load(error.exception)['stale'])
            self.assertEqual(json.load(urlopen(base+'/data'))['revision'],1)
            request=Request(base+'/save',json.dumps(self.request()).encode(),headers={'Content-Type':'application/json','X-Review-Token':'wrong'})
            with self.assertRaises(HTTPError) as error:urlopen(request)
            self.assertEqual(error.exception.code,403)
        finally:
            server.shutdown();server.server_close()
