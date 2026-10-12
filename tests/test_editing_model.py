"""Whole editing sequences checked against independently stated source outcomes."""
import itertools
import json
import secrets
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from test_review import ReviewFixture
from manuscript_review.comparison import git, read_blob
from manuscript_review.editing import selected_content
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json
from manuscript_review.server import create_server


class EditingModelTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.library = Library(self.root / 'library')
        self.identifier = self.session.store.read()['metadata']['id']
        self.directory = self.library.reviews / self.identifier
        self.directory.mkdir()
        atomic_json(self.directory / 'review.json', self.session.store.read())
        self.session = ReviewSession(self.directory)
        self.session.edit_workspace(self.request())
        self.session.authoring(self.request())
        self.initial = (self.repo / 'main.tex').read_text()

    def point(self, text, intent='proposal', **values):
        return {'id': secrets.token_hex(16), 'text': text, 'intent': intent, **values}

    def capture(self, points, *, source=None, cursor=None, text=None):
        record = self.session.store.read()
        text = points[-1]['text'] if text is None else text
        (self.repo / 'main.tex').write_text(text)
        return self.session.capture_file(self.request(file='main.tex', text=text, saves=points,
            source=record['metadata']['workspace_version'] if source is None else source, cursor=cursor))

    def test_external_apply_invalidates_the_native_capture_cursor(self):
        source = self.session.store.read()['metadata']['workspace_version']
        first = self.point(self.initial.replace('measured', 'observed'))
        self.capture([first])
        edit = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={edit['id']: 'reject'}))
        self.assertNotEqual(first['id'], self.session.store.read()['metadata']['source_cursors']['main.tex'])
        before = self.session.store.path.read_bytes()
        second = self.point(first['text'].replace('expand', 'extend'))
        with self.assertRaisesRegex(ValueError, 'another editor'):
            self.capture([first, second], source=source)
        self.assertEqual(before, self.session.store.path.read_bytes())

    def test_ambiguous_rebase_retains_the_saved_draft_and_rejection_atomically(self):
        base = 'Leaf root node leaf root node node cell.\n'
        point = self.point(base, 'author')
        self.capture([point])
        task = self.library.begin(self.identifier, parallel=True)
        proposal = 'Branch root tip leaf root node node branch'
        (Path(task['workspace']) / 'main.tex').write_text(proposal)
        self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])
        decisions = {edit['id']: 'reject' if edit['new'] == 'branch' else 'accept' for edit in self.file()['edits']}
        self.session.update('save', self.request(decisions=decisions))
        self.deliver()
        record = self.session.store.read()
        saved = 'Branch root tip node node cell.\n'
        before = self.session.store.path.read_bytes()
        point = self.point(saved, 'author')
        with self.assertRaisesRegex(ValueError, 'unambiguously'):
            self.capture([point], cursor=record['metadata']['source_cursors']['main.tex'])
        self.assertEqual(self.session.store.path.read_bytes(), before)
        self.assertEqual((self.repo / 'main.tex').read_text(), saved)
        self.assert_sources(base, proposal, selected='Branch root tip leaf root node node cell.\n')
        server = create_server(self.directory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = self.request(file='main.tex', text=saved, saves=[point],
                                source=record['metadata']['workspace_version'], cursor=record['metadata']['source_cursors']['main.tex'])
            request = Request(f'http://127.0.0.1:{server.server_port}/capture', json.dumps(body).encode(),
                              headers={'X-Review-Token': record['snapshot']['token']})
            with self.assertRaises(HTTPError) as refusal:
                urlopen(request, timeout=10)
            self.assertEqual(json.load(refusal.exception)['capture'], {'file': 'main.tex', 'save': point['id'], 'intent': 'proposal'})
            self.assertEqual(self.session.store.path.read_bytes(), before)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
        # Explicit refinement is a recovery choice; the original author base stays fixed.
        self.capture([{**point, 'intent': 'proposal'}], cursor=record['metadata']['source_cursors']['main.tex'])
        self.assert_sources(base, 'Branch root tip node node branch', selected=saved)

    def test_author_insertions_beside_agent_words_survive_rejection(self):
        for old, new in [('observed', 'new observed'), ('observed', 'observed,')]:
            with self.subTest(new=new):
                case = EditingModelTests(self._testMethodName)
                case.setUp()
                try:
                    task = case.library.begin(case.identifier, parallel=True)
                    path = Path(task['workspace']) / 'main.tex'
                    path.write_text(path.read_text().replace('measured', 'observed'))
                    case.library.finish_parallel(case.identifier, task['starting_version'], task['workspace'])
                    case.deliver()
                    record = case.session.store.read()
                    proposal = (case.repo / 'main.tex').read_text().replace(old, new)
                    case.capture([case.point(proposal, 'author')], cursor=record['metadata']['source_cursors']['main.tex'])
                    base = case.initial.replace('measured', new.replace('observed', 'measured'))
                    case.assert_sources(base, proposal)
                    case.session.update('save', case.request(decisions={edit['id']: 'reject' for edit in case.file()['edits']}))
                    case.deliver()
                    case.assert_sources(base, proposal, selected=base)
                finally:
                    case.tearDown()
                    case.doCleanups()

    def test_unknown_delivery_version_cannot_be_treated_as_an_absent_source_file(self):
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'source version is unavailable'):
            self.capture([self.point(self.initial, 'author', editing='f' * 40)])
        self.assertEqual(before, self.session.store.path.read_bytes())

    def test_author_boundary_insertions_combined_with_an_interior_rewrite_survive_rejection(self):
        for wording in ['new observed cell states', 'observed cell states, with confidence']:
            with self.subTest(wording=wording):
                case = EditingModelTests(self._testMethodName)
                case.setUp()
                try:
                    task = case.library.begin(case.identifier, parallel=True)
                    path = Path(task['workspace']) / 'main.tex'
                    path.write_text(path.read_text().replace('measured leaves', 'observed leaf states'))
                    case.library.finish_parallel(case.identifier, task['starting_version'], task['workspace'])
                    case.deliver()
                    record = case.session.store.read()
                    proposal = (case.repo / 'main.tex').read_text().replace('observed leaf states', wording)
                    case.capture([case.point(proposal, 'author')], cursor=record['metadata']['source_cursors']['main.tex'])
                    base = case.initial.replace('measured leaves', wording.replace('observed', 'measured'))
                    case.assert_sources(base, proposal)
                    case.session.update('save', case.request(decisions={edit['id']: 'reject' for edit in case.file()['edits']}))
                    case.deliver()
                    case.assert_sources(base, proposal, selected=base)
                finally:
                    case.tearDown()
                    case.doCleanups()

    def test_author_and_undelivered_agent_edits_merge_when_their_intervals_are_adjacent(self):
        cases = [('observed', 'new measured', 'new observed'),
                 ('observed', 'measured,', 'observed,'),
                 ('new measured', 'recorded', 'new recorded'),
                 ('measured,', 'recorded', 'recorded,')]
        for new_agent, new_author, combined in cases:
            with self.subTest(agent=new_agent, author=new_author):
                case = EditingModelTests(self._testMethodName)
                case.setUp()
                try:
                    task = case.library.begin(case.identifier, parallel=True)
                    path = Path(task['workspace']) / 'main.tex'
                    path.write_text(path.read_text().replace('measured', new_agent))
                    case.library.finish_parallel(case.identifier, task['starting_version'], task['workspace'])
                    authored = case.initial.replace('measured', new_author)
                    case.capture([case.point(authored, 'author')])
                    proposal = case.initial.replace('measured', combined)
                    case.assert_sources(authored, proposal, saved=authored)
                    case.assertFalse(case.session.store.read()['metadata'].get('delivery_conflicts'))
                    case.assertEqual(case.session.store.read()['decisions'], {})
                    case.deliver()
                    case.session.update('save', case.request(decisions={edit['id']: 'reject' for edit in case.file()['edits']}))
                    case.deliver()
                    case.assert_sources(authored, proposal, selected=authored)
                    case.session.update('apply', case.request(decisions={edit['id']: 'accept' for edit in case.file()['edits']}))
                    case.assert_sources(authored, proposal)
                finally:
                    case.tearDown()
                    case.doCleanups()

    def test_different_insertions_at_the_same_point_keep_both_versions_for_review(self):
        task = self.library.begin(self.identifier, parallel=True)
        proposal = self.initial.replace('measured', 'new measured')
        (Path(task['workspace']) / 'main.tex').write_text(proposal)
        self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])
        authored = self.initial.replace('measured', 'other measured')
        self.capture([self.point(authored, 'author')])
        self.assert_sources(authored, proposal, saved=authored)
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], ['main.tex'])
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.session.update('apply', self.request(decisions={edit['id']: 'reject' for edit in self.file()['edits']}))
        self.assert_sources(authored, proposal, selected=authored)
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], [])

    def test_adjacent_parallel_proposals_merge_in_either_completion_order(self):
        for first, second, combined in [('observed', 'new measured', 'new observed'),
                                        ('observed', 'measured,', 'observed,'),
                                        ('new measured', 'recorded', 'new recorded'),
                                        ('measured,', 'recorded', 'recorded,')]:
            for order in ((first, second), (second, first)):
                with self.subTest(order=order):
                    case = EditingModelTests(self._testMethodName)
                    case.setUp()
                    try:
                        tasks = [case.library.begin(case.identifier, parallel=True) for _ in order]
                        for task, wording in zip(tasks, order):
                            (Path(task['workspace']) / 'main.tex').write_text(case.initial.replace('measured', wording))
                            case.library.finish_parallel(case.identifier, task['starting_version'], task['workspace'])
                        proposal = case.initial.replace('measured', combined)
                        case.assert_sources(case.initial, proposal, saved=case.initial)
                        case.assertEqual(case.session.store.read()['decisions'], {})
                        case.session.update('apply', case.request(decisions={edit['id']: 'reject' for edit in case.file()['edits']}))
                        case.assert_sources(case.initial, proposal, selected=case.initial)
                    finally:
                        case.tearDown()
                        case.doCleanups()

    def assert_sources(self, author, proposal, selected=None, saved=None):
        record = self.session.store.read()
        self.assertEqual(read_blob(self.repo, record['snapshot']['base'], 'main.tex'), author)
        self.assertEqual(read_blob(self.repo, record['snapshot']['proposed'], 'main.tex'), proposal)
        result = proposal if selected is None else selected
        self.assertEqual(read_blob(self.repo, record['result'], 'main.tex'), result)
        self.assertEqual(read_blob(self.repo, record['metadata']['workspace_version'], 'main.tex'), result if saved is None else saved)
        self.assertEqual(record['baseline'], self.base)
        for file in record['snapshot']['files']:
            self.assertEqual(read_blob(self.repo, record['result'], file['path']), selected_content(file, record['decisions']))

    def test_mixed_save_intents_keep_their_order_and_rejection_base(self):
        proposal = self.initial.replace('measured', 'observed')
        authored = proposal.replace('expand', 'extend')
        first, second = self.point(proposal), self.point(authored, 'author')
        self.capture([first, second])
        base = self.initial.replace('expand', 'extend')
        self.assert_sources(base, authored)
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Retain measured.'}))
        self.assert_sources(base, authored, selected=base, saved=authored)

    def test_drafting_then_refining_exposes_only_the_refinement(self):
        authored = self.initial.replace('measured', 'observed')
        proposal = authored.replace('expand', 'extend')
        self.capture([self.point(authored, 'author'), self.point(proposal)])
        self.assert_sources(authored, proposal)
        self.assertEqual([edit['new'] for edit in self.file()['edits']], ['extend'])

    def test_lost_acknowledgement_retries_only_the_uncaptured_suffix(self):
        original = self.session.store.read()['metadata']['workspace_version']
        proposal = self.initial.replace('measured', 'observed')
        first = self.point(proposal)
        self.capture([first], source=original)
        final = proposal.replace('expand', 'extend')
        second = self.point(final, 'author')
        self.capture([first, second], source=original)
        base = self.initial.replace('expand', 'extend')
        self.assert_sources(base, final)
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Keep this choice.'}))
        before = self.session.store.path.read_bytes()
        result = self.capture([first, second], source=original)
        self.assertEqual(result['captured'], second['id'])
        self.assertEqual(before, self.session.store.path.read_bytes())
        self.assert_sources(base, final, selected=base, saved=final)

    def test_prefix_capture_can_acknowledge_saves_while_the_disk_is_already_ahead(self):
        proposal = self.initial.replace('measured', 'observed')
        final = proposal.replace('expand', 'extend')
        first, second = self.point(proposal), self.point(final, 'author')
        result = self.capture([first], text=final)
        self.assert_sources(self.initial, proposal, saved=proposal)
        self.assertEqual((self.repo / 'main.tex').read_text(), final)
        self.capture([second], source=result['workspace_version'], cursor=result['cursor'])
        self.assert_sources(self.initial.replace('expand', 'extend'), final)

    def test_another_editor_or_stale_disk_refuses_the_whole_batch_without_state_changes(self):
        first = self.point(self.initial.replace('measured', 'observed'))
        self.capture([first])
        newer = self.point(first['text'].replace('expand', 'extend'), 'author')
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'another editor'):
            self.capture([newer])
        self.assertEqual(before, self.session.store.path.read_bytes())
        with self.assertRaisesRegex(ValueError, 'changed again'):
            self.session.capture_file(self.request(file='main.tex', text=first['text'], saves=[newer],
                source=self.session.store.read()['metadata']['workspace_version'], cursor=first['id']))
        self.assertEqual(before, self.session.store.path.read_bytes())

    def test_a_late_overlap_refuses_earlier_steps_of_the_same_batch(self):
        starting = self.library.begin(self.identifier, parallel=True)
        path = Path(starting['workspace']) / 'main.tex'
        path.write_text(path.read_text().replace('measured', 'observed'))
        self.library.finish_parallel(self.identifier, starting['starting_version'], starting['workspace'])
        self.deliver()
        newer = self.library.begin(self.identifier, parallel=True)
        path = Path(newer['workspace']) / 'main.tex'
        path.write_text(path.read_text().replace('observed', 'sampled'))
        self.library.finish_parallel(self.identifier, newer['starting_version'], newer['workspace'])
        cursor = self.session.store.read()['metadata']['source_cursors']['main.tex']
        origin = (self.repo / 'main.tex').read_text()
        first = self.point(origin.replace('expand', 'extend'))
        second = self.point(first['text'].replace('observed', 'recorded'))
        before = self.session.store.path.read_bytes()
        # A refinement cannot silently replace an unseen agent's overlapping wording.
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            self.capture([first, second], cursor=cursor)
        self.assertEqual(before, self.session.store.path.read_bytes())
        self.assertEqual((self.repo / 'main.tex').read_text(), second['text'])

    def test_interleavings_of_author_save_two_agents_delivery_and_decision(self):
        for order in itertools.permutations(('author', 'score', 'math')):
            for deliver_each in (False, True):
                with self.subTest(order=order, deliver_each=deliver_each):
                    case = EditingModelTests(self._testMethodName)
                    case.setUp()
                    try:
                        case.run_sequence(order, deliver_each)
                    finally:
                        case.tearDown()
                        case.doCleanups()

    def run_sequence(self, order, deliver_each):
        initial_record = self.session.store.read()
        head, index = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage')
        tasks = {action: self.library.begin(self.identifier, parallel=True) for action in ('score', 'math')}
        for action in order:
            if action == 'author':
                record = self.session.store.read()
                text = (self.repo / 'main.tex').read_text().replace('expand', 'extend')
                self.capture([self.point(text, 'author')], cursor=record['metadata'].get('source_cursors', {}).get('main.tex'))
            else:
                task = tasks[action]
                path = Path(task['workspace']) / 'main.tex'
                old, new = ('measured', 'observed') if action == 'score' else ('E=1', 'E=3')
                path.write_text(path.read_text().replace(old, new))
                self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])
            if deliver_each:
                self.deliver()
        self.deliver()
        author = self.initial.replace('expand', 'extend')
        proposal = author.replace('measured', 'observed').replace('E=1', 'E=3')
        self.assert_sources(author, proposal)
        edit = next(edit for edit in self.file()['edits'] if edit['new'] == 'observed')
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Retain measured.'}))
        self.deliver()
        self.assert_sources(author, proposal, selected=author.replace('E=1', 'E=3'))
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        archived = self.directory / 'versions' / f'{initial_record["revision"]:08d}.json'
        self.assertEqual(json.loads(archived.read_text()), initial_record)

    def deliver(self):
        record = self.session.store.read()
        plan = self.session.delivery(self.request())
        for file in plan['files']:
            self.capture([self.point(file['after'], editing=plan['source'])], cursor=record['metadata'].get('source_cursors', {}).get(file['file']))
