import json
import threading
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from test_review import ReviewFixture
from manuscript_review.application import is_applied
from manuscript_review.comparison import git, read_blob
from manuscript_review.editing import selected_content
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession
from manuscript_review.server import create_server


class WorkspaceTests(ReviewFixture):
    def bind(self):
        result = self.session.edit_workspace(self.request())
        return Path(result['workspace'])

    def capture(self, workspace, text, file='main.tex'):
        (workspace / file).write_text(text)
        return self.session.capture_file(self.request(file=file, text=text,
                   source=self.session.store.read()['metadata']['workspace_version']))

    def test_matching_b_uses_the_checkout_and_a_stays_fixed_across_saves(self):
        workspace = self.bind()
        self.assertEqual(workspace, self.repo.resolve())
        before = self.session.store.read()
        head, index = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage')
        original = before['snapshot']['proposed']
        text = (workspace / 'main.tex').read_text().replace('measured leaves', 'chosen leaves')
        result = self.capture(workspace, text)
        record = self.session.store.read()
        self.assertEqual(record['snapshot']['base'], before['snapshot']['base'])
        self.assertEqual(record['baseline'], before['baseline'])
        self.assertEqual(record['metadata']['id'], before['metadata']['id'])
        self.assertEqual(record['metadata'].get('previous'), before['metadata'].get('previous'))
        self.assertIn(' + local edits (', record['metadata']['proposal_label'])
        self.assertEqual(read_blob(self.repo, record['snapshot']['proposed'], 'main.tex'), text)
        self.assertIn('measured leaves', read_blob(self.repo, original, 'main.tex'))
        self.capture(workspace, text.replace('chosen leaves', 'chosen cells'))
        self.assertEqual(self.session.snapshot['base'], before['snapshot']['base'])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        self.assertEqual(result['data']['id'], before['metadata']['id'])

    def test_historical_b_gets_an_isolated_worktree_and_never_edits_current_a(self):
        proposed = self.session.snapshot['proposed']
        git(self.repo, 'checkout', '--detach', self.base)
        path = self.repo / 'main.tex'
        path.write_text('Unrelated local draft.\n')
        head, index, outside = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage'), path.read_bytes()
        workspace = self.bind()
        self.assertNotEqual(workspace, self.repo.resolve())
        self.assertEqual(git(workspace, 'rev-parse', 'HEAD').decode().strip(), proposed)
        text = (workspace / 'main.tex').read_text().replace('measured leaves', 'chosen leaves')
        self.capture(workspace, text)
        self.assertEqual(path.read_bytes(), outside)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        before = self.session.store.path.read_bytes()
        self.assertEqual(self.bind(), workspace)
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_saved_edits_keep_unaffected_rejections_notes_and_resolved_threads(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'},
             comments={first['id']: 'Revise this wording.', second['id']: 'Keep this explanation.'}))
        note = next(n for n in self.session.report()['comments'] if n['id'] == first['id'])
        self.session.resolve_thread(self.request(id=note['thread_id'], resolved=True))
        workspace = self.bind()
        text = (workspace / 'main.tex').read_text().replace('measured leaves', 'chosen leaves')
        self.capture(workspace, text)
        record = self.session.store.read()
        self.assertEqual(record['decisions'][second['id']], 'reject')
        self.assertNotIn(third['id'], record['decisions'])
        self.assertEqual(record['comments'], {second['id']: 'Keep this explanation.'})
        self.assertTrue(self.session.report()['history'][0]['resolved'])
        self.assertEqual(self.session.report()['history'][0]['comment'], 'Revise this wording.')
        self.assertIn('retain the explanation', selected_content(self.file(), record['decisions']))
        self.assertIn('expand the explanation', text)

    def test_native_save_after_apply_preserves_other_rejected_proposals(self):
        second = self.file()['edits'][1]
        workspace = self.bind()
        self.session.update('apply', self.request(decisions={second['id']: 'reject'}))
        text = (workspace / 'main.tex').read_text().replace('measured leaves', 'chosen leaves')
        self.capture(workspace, text)
        record = self.session.store.read()
        self.assertEqual(record['decisions'][second['id']], 'reject')
        self.assertIn('expand the explanation', self.file()['after'])
        self.assertEqual(selected_content(self.file(), record['decisions']), text)
        self.assertEqual((workspace / 'main.tex').read_text(), text)
        self.assertTrue(is_applied(record))

    def test_native_capture_keeps_the_existing_review_file_order(self):
        workspace = self.bind()
        before = [file['path'] for file in self.session.snapshot['files']]
        self.capture(workspace, 'Restored contents', 'deleted.txt')
        self.assertEqual([file['path'] for file in self.session.snapshot['files']], before)

    def test_new_file_save_is_captured_without_staging_it(self):
        workspace = self.bind()
        index = git(workspace, 'ls-files', '--stage')
        self.capture(workspace, 'A new section.\n', 'new.tex')
        self.assertEqual(read_blob(self.repo, self.session.snapshot['proposed'], 'new.tex'), 'A new section.\n')
        self.assertEqual(git(workspace, 'ls-files', '--stage'), index)

    def test_empty_new_and_recreated_deleted_files_are_distinct_from_absence(self):
        workspace = self.bind()
        self.capture(workspace, '', 'new.tex')
        self.assertEqual(read_blob(self.repo, self.session.snapshot['proposed'], 'new.tex'), '')
        self.capture(workspace, 'Restored source', 'deleted.txt')
        file = next(f for f in self.session.snapshot['files'] if f['path'] == 'deleted.txt')
        self.assertEqual(selected_content(file, self.session.store.read()['decisions']), 'Restored source')
        self.capture(workspace, '', 'main.tex')
        self.assertEqual(read_blob(self.repo, self.session.snapshot['proposed'], 'main.tex'), '')

    def test_recreating_a_rejected_deleted_file_as_empty_is_a_manual_change(self):
        file = next(f for f in self.session.snapshot['files'] if f['path'] == 'deleted.txt')
        group = file['edits'][0]
        self.session.update('save', self.request(decisions={group['id']:'reject'}, comments={group['id']:'Retain source.'}))
        workspace = self.bind()
        self.capture(workspace, '', 'deleted.txt')
        record = self.session.store.read()
        file = next(f for f in record['snapshot']['files'] if f['path'] == 'deleted.txt')
        self.assertEqual(selected_content(file, record['decisions']), '')
        self.assertEqual(read_blob(self.repo, record['result'], 'deleted.txt'), '')
        self.assertEqual(self.session.report()['history'][0]['comment'], 'Retain source.')

    def test_selected_checkout_initialization_and_committed_apply_preserve_rejected_proposals(self):
        group = self.file()['edits'][1]
        self.session.update('save', self.request(decisions={group['id']:'reject'}, comments={group['id']:'Retain explanation.'}))
        git(self.repo, 'checkout', '--detach', self.base)
        workspace = self.bind()
        self.session.update('apply', self.request())
        self.capture(workspace, (workspace / 'main.tex').read_text().replace('measured leaves','chosen leaves'))
        record = self.session.store.read()
        self.assertEqual(record['decisions'][group['id']], 'reject')
        self.assertEqual(record['comments'][group['id']], 'Retain explanation.')
        self.assertIn('expand the explanation', self.file()['after'])

        # Acknowledge the author's committed selection after Git HEAD changes.
        other = self.file()['edits'][-1]
        self.session.update('save', self.request(decisions={**record['decisions'], other['id']:'reject'}, comments=record['comments']))
        (workspace / 'main.tex').write_text(selected_content(self.file(), self.session.store.read()['decisions']))
        git(workspace,'add','-A');git(workspace,'commit','-qm','Author selected wording')
        self.session.update('apply', self.request())
        self.capture(workspace, (workspace / 'main.tex').read_text().replace('chosen leaves','chosen cells'))
        record = self.session.store.read()
        self.assertEqual(record['decisions'][other['id']], 'reject')
        self.assertIn('E=1', self.file()['after'])

    def test_apply_and_interrupted_recovery_target_b_not_the_original_checkout(self):
        git(self.repo, 'checkout', '--detach', self.base)
        original = (self.repo / 'main.tex').read_bytes()
        workspace = self.bind()
        group = self.file()['edits'][0]
        from manuscript_review import storage
        atomic = storage.atomic_bytes
        def interrupted(path, content):
            if Path(path) == workspace / 'main.tex':
                raise OSError('Interrupted source write')
            return atomic(path, content)
        with patch('manuscript_review.storage.atomic_bytes', side_effect=interrupted), self.assertRaises(OSError):
            self.session.update('apply', self.request(decisions={group['id']: 'reject'}))
        self.assertTrue(self.session.store.journal.exists())
        with self.session.store.transaction():
            record = self.session.store.read()
        self.assertFalse(self.session.store.journal.exists())
        self.assertEqual((self.repo / 'main.tex').read_bytes(), original)
        self.assertIn('all nodes', (workspace / 'main.tex').read_text())
        self.assertTrue(is_applied(record))
        text = (workspace / 'main.tex').read_text().replace('E=1', 'E=3')
        self.capture(workspace, text)
        record = self.session.store.read()
        self.session.update('file', self.request(file='main.tex', source=record['result'], text=text.replace('score', 'evaluate')))
        self.assertIn('evaluate all nodes', (workspace / 'main.tex').read_text())
        self.assertEqual((self.repo / 'main.tex').read_bytes(), original)

    def test_native_capture_preserves_staged_index_and_allows_an_author_commit(self):
        workspace = self.bind()
        (workspace / 'main.tex').write_text((workspace / 'main.tex').read_text().replace('measured', 'chosen'))
        git(workspace, 'add', 'main.tex')
        index = git(workspace, 'ls-files', '--stage')
        self.capture(workspace, (workspace / 'main.tex').read_text().replace('chosen', 'selected'))
        self.assertEqual(git(workspace, 'ls-files', '--stage'), index)
        git(workspace, 'commit', '-qm', 'Author wording')
        self.capture(workspace, (workspace / 'main.tex').read_text().replace('selected', 'observed'))
        self.assertEqual(self.session.snapshot['source_head'], git(workspace, 'rev-parse', 'HEAD').decode().strip())
        self.assertEqual(self.session.snapshot['base'], self.base)
        git(workspace, 'checkout', '--force', '--detach', self.base)
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'moved away from B'):
            self.capture(workspace, 'Unrelated source')
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_native_capture_refuses_retained_drafts_and_unsafe_files(self):
        workspace = self.bind()
        record = self.session.store.read()
        text = (workspace / 'main.tex').read_text()
        self.session.save_draft(self.request(id='main.tex', draft={'file':'main.tex', 'text':text+'Draft', 'source':record['result']}))
        with self.assertRaisesRegex(ValueError, 'retained draft'):
            self.capture(workspace, text + 'Native edit')
        self.session.save_draft(self.request(id='main.tex', draft=None))
        outside = self.root / 'outside.tex';outside.write_text('Outside source')
        (workspace / 'link.tex').symlink_to(outside)
        before = self.session.store.path.read_bytes()
        for file in ('../outside.tex', str(outside), 'link.tex'):
            with self.subTest(file=file), self.assertRaises(ValueError):
                self.session.capture_file(self.request(file=file, text='Outside source', source=self.session.store.read()['metadata']['workspace_version']))
        self.assertEqual(self.session.store.path.read_bytes(), before)
        self.assertEqual(outside.read_text(), 'Outside source')

    def test_http_workspace_and_saved_capture_share_the_session_operations(self):
        server = create_server(self.directory)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = 'http://127.0.0.1:' + str(server.server_address[1])
        def post(route, body):
            request = Request(url+route, json.dumps(body).encode(), headers={'Content-Type':'application/json','X-Review-Token':self.session.snapshot['token']})
            return json.load(urlopen(request, timeout=5))
        try:
            checkout = post('/workspace', self.request())
            path = Path(checkout['workspace']) / 'main.tex'
            text = path.read_text().replace('measured leaves', 'chosen leaves');path.write_text(text)
            result = post('/capture', self.request(file='main.tex', text=text, source=checkout['workspace_version']))
            self.assertEqual(result['data']['base'], self.base)
            self.assertEqual(result['data']['workspace'], checkout['workspace'])
            self.assertEqual(self.session.report()['workspace'], checkout['workspace'])
        finally:
            server.shutdown();server.server_close()

    def test_unchanged_save_is_read_only_and_stale_or_unsaved_capture_is_refused(self):
        workspace = self.bind()
        text = (workspace / 'main.tex').read_text()
        before = self.session.store.path.read_bytes()
        self.session.capture_file(self.request(file='main.tex', text=text, source=self.session.store.read()['metadata']['workspace_version']))
        self.assertEqual(self.session.store.path.read_bytes(), before)
        for changes in ({'revision': -1}, {'source': self.base}, {'text': 'Not saved to disk.'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                request = self.request(file='main.tex', text=text,
                       source=self.session.store.read()['metadata']['workspace_version'])
                request.update(changes)
                self.session.capture_file(request)
            self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_agent_followup_reads_the_editing_checkout_and_preserves_the_round(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'HEAD', 'entry': ''}, 'first')
        identifier = library.jobs['first']['review']
        self.session = ReviewSession(library.directory(identifier))
        git(self.repo, 'checkout', '--detach', self.base)
        workspace = self.bind()
        self.capture(workspace, (workspace / 'main.tex').read_text().replace('measured leaves', 'chosen leaves'))
        self.capture(workspace, 'An unstaged new section.\n', 'new.tex')
        started = library.begin(identifier)
        self.assertEqual(read_blob(self.repo, started['starting_version'], 'new.tex'), 'An unstaged new section.\n')
        original = self.session.store.path.read_bytes()
        (workspace / 'main.tex').write_text((workspace / 'main.tex').read_text().replace('chosen leaves', 'chosen cells'))
        library.prepare({'repo': str(self.repo), 'previous': identifier, 'expected_revision': started['revision'],
                         'starting_version': started['starting_version'], 'proposed': 'working', 'entry': ''}, 'next')
        self.assertEqual(library.jobs['next']['status'], 'ready', library.jobs['next'])
        new = ReviewSession(library.directory(library.jobs['next']['review'])).store.read()
        self.assertEqual(new['snapshot']['base'], started['starting_version'])
        self.assertEqual(new['baseline'], self.base)
        self.assertEqual(new['metadata']['workspace'], str(workspace))
        self.assertEqual(read_blob(self.repo, new['snapshot']['proposed'], 'new.tex'), 'An unstaged new section.\n')
        self.assertEqual(self.session.store.path.read_bytes(), original)

        info = library.inspect(str(workspace))
        self.assertEqual(info['repo'], str(self.repo.resolve()))
        self.assertEqual(info['workspace'], str(workspace))
        opened = library.manuscript_request(str(workspace))
        self.assertEqual(opened['repo'], str(self.repo.resolve()))
        self.assertEqual(opened['previous'], new['metadata']['id'])
        self.assertEqual(read_blob(self.repo, info['working_version'], 'main.tex'), (workspace / 'main.tex').read_text())
        library.prepare({'repo': str(workspace), 'workspace': str(workspace), 'previous': identifier,
                         'proposed': self.base, 'entry': ''}, 'committed')
        self.assertEqual(library.jobs['committed']['status'], 'ready', library.jobs['committed'])
        other = ReviewSession(library.directory(library.jobs['committed']['review']))
        self.assertNotIn('workspace', other.store.read()['metadata'])
        self.assertEqual(read_blob(self.repo, other.snapshot['proposed'], 'main.tex'), self.base_text)

    def test_import_does_not_share_a_bound_source_checkout(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'HEAD'}, 'one')
        self.session = ReviewSession(library.directory(library.jobs['one']['review']))
        git(self.repo, 'checkout', '--detach', self.base)
        workspace = self.bind()
        imported = ReviewSession(library.directory(library.import_review(self.session.directory)))
        self.assertNotIn('workspace', imported.store.read()['metadata'])
        copied = Path(imported.edit_workspace({'revision':imported.store.read()['revision']})['workspace'])
        self.assertNotEqual(copied, workspace)

    def test_rebound_checkout_replaces_stale_physical_hashes(self):
        library = Library(self.root / 'library')
        library.prepare({'repo':str(self.repo), 'base':self.base, 'proposed':'HEAD'}, 'one')
        self.session = ReviewSession(library.directory(library.jobs['one']['review']))
        workspace = self.bind()
        group = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={group['id']:'reject'}))
        self.session.update('save', self.request(decisions={group['id']:'accept'}))
        imported = ReviewSession(library.directory(library.import_review(self.session.directory)))
        imported.edit_workspace({'revision':imported.store.read()['revision']})
        record = imported.store.read()
        self.assertTrue(is_applied(record))
        imported.update('apply', {'revision':record['revision'],'decisions':record['decisions'],'comments':record['comments']})

    def test_begin_binds_a_cli_commit_comparison_before_returning_the_source_directory(self):
        library = Library(self.root / 'library')
        library.prepare({'repo':str(self.repo), 'base':self.base, 'proposed':'HEAD'}, 'one')
        identifier = library.jobs['one']['review']
        git(self.repo, 'checkout', '--detach', self.base)
        original = (self.repo / 'main.tex').read_bytes()
        started = library.begin(identifier)
        self.assertNotEqual(started['workspace'], str(self.repo.resolve()))
        self.assertIn('measured leaves', (Path(started['workspace']) / 'main.tex').read_text())
        self.assertEqual((self.repo / 'main.tex').read_bytes(), original)
        self.assertEqual(started['revision'], ReviewSession(library.directory(identifier)).store.read()['revision'])

    def test_working_picker_retains_only_captured_untracked_sources(self):
        library = Library(self.root / 'library')
        library.prepare({'repo':str(self.repo), 'base':self.base, 'proposed':'HEAD'}, 'one')
        self.session = ReviewSession(library.directory(library.jobs['one']['review']))
        workspace = self.bind()
        self.capture(workspace, 'Known section', 'new.tex')
        (workspace / 'scratch.tex').write_text('Unknown scratch')
        info = library.inspect(str(workspace))
        self.assertFalse(info['dirty'])
        self.assertEqual(read_blob(self.repo, info['working_version'], 'new.tex'), 'Known section')
        self.assertIsNone(read_blob(self.repo, info['working_version'], 'scratch.tex'))
        record = self.session.store.read()
        library.prepare({'repo':str(self.repo), 'previous':record['metadata']['id'], 'proposed':'working'}, 'unchanged')
        self.assertEqual(library.jobs['unchanged']['review'], record['metadata']['id'])

    def test_explicit_working_folder_controls_the_proposal_even_with_a_saved_starting_draft(self):
        library = Library(self.root / 'library')
        library.prepare({'repo':str(self.repo), 'base':self.base, 'proposed':'HEAD'}, 'one')
        identifier = library.jobs['one']['review']
        self.session = ReviewSession(library.directory(identifier))
        git(self.repo, 'checkout', '--detach', self.base)
        workspace = self.bind()
        self.assertNotEqual(workspace, self.repo.resolve())
        info = library.inspect(str(self.repo))
        self.assertEqual(info['workspace'], str(self.repo.resolve()))
        library.prepare({'repo':info['repo'],'workspace':info['workspace'],'previous':identifier,'proposed':'working'}, 'two')
        self.assertEqual(library.jobs['two']['status'],'ready',library.jobs['two'])
        other = ReviewSession(library.directory(library.jobs['two']['review'])).store.read()
        self.assertEqual(read_blob(self.repo,other['snapshot']['proposed'],'main.tex'), self.base_text)
        self.assertEqual(other['metadata']['workspace'], str(self.repo.resolve()))

    def test_an_empty_tracked_tree_is_a_valid_working_snapshot(self):
        from manuscript_review.repositories import working_snapshot
        git(self.repo,'rm','-r','--','.')
        git(self.repo,'commit','-qm','Empty tree')
        head,index = git(self.repo,'rev-parse','HEAD'),git(self.repo,'ls-files','--stage')
        version,source = working_snapshot(self.repo)
        self.assertEqual(version,head.decode().strip())
        self.assertEqual(source,version)
        self.assertEqual(git(self.repo,'ls-files','--stage'),index)
