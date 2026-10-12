from pathlib import Path
from test_review import ReviewFixture
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json
from manuscript_review.comparison import read_blob
from manuscript_review.authoring import authored_text


class AuthoringTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.library = Library(self.root / 'library')
        self.identifier = self.session.store.read()['metadata']['id']
        self.directory = self.library.reviews / self.identifier
        self.directory.mkdir()
        atomic_json(self.directory / 'review.json', self.session.store.read())
        self.session = ReviewSession(self.directory)
        self.session.edit_workspace(self.request())

    def capture(self, text, editing=None):
        (self.repo / 'main.tex').write_text(text)
        record = self.session.store.read()
        return self.session.capture_file(self.request(file='main.tex', text=text, source=record['metadata']['workspace_version'], intent='author',
                                                      **({'editing': editing} if editing else {})))

    def propose(self, old, new, task=None):
        task = task or self.library.begin(self.identifier, parallel=True)
        path = Path(task['workspace']) / 'main.tex'
        path.write_text(path.read_text().replace(old, new))
        return self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])

    def test_initial_authoring_retains_selected_words_discussion_resolution_and_original_record(self):
        edit = next(edit for edit in self.file()['edits'] if edit['new'] == '1')
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Keep E=2.'}))
        note = self.session.report()['comments'][0]
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Kept.'}], self.session.store.read()['revision'])
        record = self.session.store.read()
        before = self.session.store.path.read_bytes()
        self.session.authoring(self.request())
        current = self.session.store.read()
        self.assertEqual(current['result'], record['result'])
        self.assertEqual(current['baseline'], record['baseline'])
        self.assertEqual(current['resolved'], record['resolved'])
        self.assertEqual((self.directory / 'versions' / f'{record["revision"]:08d}.json').read_bytes(), before)
        thread = self.session.report(note['discussion_id'])['history'][0]
        self.assertEqual(thread['comment'], 'Keep E=2.')
        self.assertEqual(thread['replies'][0]['text'], 'Kept.')
        again = self.session.store.path.read_bytes()
        self.session.authoring(self.request())
        self.assertEqual(again, self.session.store.path.read_bytes())

    def test_parallel_results_and_manual_saves_form_one_diff_of_only_agent_words(self):
        self.session.authoring(self.request())
        first = self.library.begin(self.identifier, parallel=True)
        second = self.library.begin(self.identifier, parallel=True)
        authored = (self.repo / 'main.tex').read_text().replace('expand', 'extend')
        self.capture(authored)
        self.propose('measured', 'observed', first)
        self.propose('the explanation', 'the detailed explanation', second)
        self.assertEqual((self.repo / 'main.tex').read_text(), authored)
        plan = self.session.delivery(self.request())
        self.assertEqual(len(plan['files']), 1)
        self.assertIn('extend the detailed explanation', plan['files'][0]['after'])
        self.capture(plan['files'][0]['after'], editing=plan['source'])
        record = self.session.store.read()
        self.assertEqual(read_blob(self.repo, record['snapshot']['base'], 'main.tex'), authored)
        self.assertEqual(read_blob(self.repo, record['result'], 'main.tex'), (self.repo / 'main.tex').read_text())
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.assertTrue(all(edit['id'] not in record['decisions'] for edit in self.file()['edits']))
        self.assertNotIn('extend', [edit['new'] for edit in self.file()['edits']])
        self.assertEqual(record['baseline'], self.base)

    def test_typing_after_delivery_only_moves_authored_words_into_the_base(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        plan = self.session.delivery(self.request())
        edited = plan['files'][0]['after'].replace('expand', 'extend')
        self.capture(edited, editing=plan['source'])
        record = self.session.store.read()
        baseline = read_blob(self.repo, record['snapshot']['base'], 'main.tex')
        self.assertIn('measured leaves', baseline)
        self.assertIn('extend the explanation', baseline)
        self.assertTrue(all(edit['id'] not in record['decisions'] for edit in self.file()['edits']))

    def test_another_result_during_delivery_is_preserved_for_the_next_save(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        plan = self.session.delivery(self.request())
        self.propose('explanation', 'derivation')
        self.capture(plan['files'][0]['after'], editing=plan['source'])
        pending = self.session.delivery(self.request())
        self.assertIn('observed leaves', pending['files'][0]['after'])
        self.assertIn('derivation', pending['files'][0]['after'])
        self.capture(pending['files'][0]['after'], editing=pending['source'])
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.assertEqual(len(self.file()['edits']), 2)

    def test_undo_before_first_delivery_capture_does_not_reapply_agent_words(self):
        self.session.authoring(self.request())
        authored = (self.repo / 'main.tex').read_text()
        self.propose('measured', 'observed')
        plan = self.session.delivery(self.request())
        self.capture(authored, editing=plan['source'])
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.assertEqual(self.session.store.read()['snapshot']['files'], [])
        self.assertEqual((self.repo / 'main.tex').read_text(), authored)

    def test_manual_rewrite_of_delivered_agent_words_becomes_authored_and_rejection_stays_available(self):
        self.session.authoring(self.request())
        self.propose('measured leaves', 'observed leaf states')
        plan = self.session.delivery(self.request())
        self.capture(plan['files'][0]['after'], editing=plan['source'])
        self.capture((self.repo / 'main.tex').read_text().replace('observed leaf states', 'recorded states'))
        record = self.session.store.read()
        self.assertEqual(record['snapshot']['files'], [])
        self.propose('recorded', 'measured')
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}))
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.assertIn('recorded states', (self.repo / 'main.tex').read_text())

    def test_overlapping_author_and_undelivered_agent_words_keep_both_sources(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        authored = (self.repo / 'main.tex').read_text().replace('measured', 'recorded')
        self.capture(authored)
        record = self.session.store.read()
        self.assertEqual(record['metadata']['delivery_conflicts'], ['main.tex'])
        self.assertEqual(self.session.delivery(self.request())['files'], [])
        self.assertEqual((self.repo / 'main.tex').read_text(), authored)
        self.assertIn('observed', read_blob(self.repo, record['result'], 'main.tex'))
        self.assertIn('recorded', read_blob(self.repo, record['snapshot']['base'], 'main.tex'))
        self.session.update('apply', self.request(decisions={edit['id']: 'reject' for edit in self.file()['edits']}))
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], [])
        self.assertEqual((self.repo / 'main.tex').read_text(), authored)

    def test_expanding_a_manual_change_through_one_agent_replacement_never_duplicates_words(self):
        self.assertEqual(authored_text('An observed leaf state.', 'A node.', 'An recorded leaf value.'), 'A recorded leaf value.')

    def test_manually_resolving_an_overlap_unblocks_the_next_agent_result(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        self.capture((self.repo / 'main.tex').read_text().replace('measured', 'recorded'))
        self.capture((self.repo / 'main.tex').read_text().replace('recorded', 'observed'))
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], [])
        self.propose('observed', 'sampled')
        self.assertIn('sampled', self.session.delivery(self.request())['files'][0]['after'])

    def test_conflicting_author_save_preserves_an_agent_file_deletion(self):
        self.session.authoring(self.request())
        task = self.library.begin(self.identifier, parallel=True)
        (Path(task['workspace']) / 'main.tex').unlink()
        self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])
        authored = (self.repo / 'main.tex').read_text().replace('measured', 'recorded')
        self.capture(authored)
        self.assertIsNone(self.file()['after'])
        self.assertIsNone(read_blob(self.repo, self.session.store.read()['result'], 'main.tex'))
        self.assertEqual((self.repo / 'main.tex').read_text(), authored)

    def test_review_refinement_keeps_the_author_base_and_reconstructs_the_saved_proposal(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        plan = self.session.delivery(self.request())
        self.capture(plan['files'][0]['after'], editing=plan['source'])
        before = self.session.store.read()
        text = (self.repo / 'main.tex').read_text().replace('observed', 'recorded')
        (self.repo / 'main.tex').write_text(text)
        self.session.capture_file(self.request(file='main.tex', text=text,
            source=before['metadata']['workspace_version'], intent='proposal'))
        record = self.session.store.read()
        self.assertEqual(record['snapshot']['base'], before['snapshot']['base'])
        self.assertEqual(record['baseline'], before['baseline'])
        self.assertEqual(read_blob(self.repo, record['result'], 'main.tex'), text)
        self.assertIn('recorded', read_blob(self.repo, record['snapshot']['proposed'], 'main.tex'))
        self.assertTrue(self.file()['edits'])

    def test_republishing_after_rejection_preserves_all_author_decisions_and_comments(self):
        self.session.authoring(self.request())
        task = self.library.begin(self.identifier, parallel=True)
        self.propose('measured', 'observed', task)
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Keep measured.'}))
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already incorporated'):
            self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_rejecting_an_overlap_through_save_unblocks_later_disjoint_delivery(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        self.capture((self.repo / 'main.tex').read_text().replace('measured', 'recorded'))
        self.session.update('save', self.request(decisions={edit['id']: 'reject' for edit in self.file()['edits']}))
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], [])
        self.propose('explanation', 'derivation')
        plan = self.session.delivery(self.request())
        self.assertEqual(len(plan['files']), 1)
        self.assertIn('recorded', plan['files'][0]['after'])
        self.assertIn('derivation', plan['files'][0]['after'])

    def test_identical_parallel_task_cannot_restore_a_later_rejection(self):
        self.session.authoring(self.request())
        first = self.library.begin(self.identifier, parallel=True)
        second = self.library.begin(self.identifier, parallel=True)
        self.propose('measured', 'observed', first)
        with self.assertRaisesRegex(ValueError, 'already incorporated'):
            self.propose('measured', 'observed', second)
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}, comments={edit['id']: 'Keep measured.'}))
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already incorporated'):
            self.library.finish_parallel(self.identifier, second['starting_version'], second['workspace'])
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_proposal_refinement_resolves_a_conflict_before_the_next_agent_result(self):
        self.session.authoring(self.request())
        self.propose('measured', 'observed')
        self.capture((self.repo / 'main.tex').read_text().replace('measured', 'recorded'))
        before = self.session.store.read()
        text = (self.repo / 'main.tex').read_text().replace('recorded', 'chosen')
        (self.repo / 'main.tex').write_text(text)
        self.session.capture_file(self.request(file='main.tex', text=text,
            source=before['metadata']['workspace_version'], intent='proposal'))
        self.assertEqual(self.session.store.read()['metadata']['delivery_conflicts'], [])
        self.propose('explanation', 'derivation')
        plan = self.session.delivery(self.request())
        self.assertIn('chosen', plan['files'][0]['after'])
        self.assertIn('derivation', plan['files'][0]['after'])
