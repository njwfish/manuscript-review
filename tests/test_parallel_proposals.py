from pathlib import Path
from test_review import ReviewFixture
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json
from manuscript_review.comparison import git
from manuscript_review.editing import selected_content


class ParallelProposalTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.library = Library(self.root / 'library')
        self.identifier = self.session.store.read()['metadata']['id']
        self.directory = self.library.reviews / self.identifier
        self.directory.mkdir()
        atomic_json(self.directory / 'review.json', self.session.store.read())
        self.session = ReviewSession(self.directory)

    def finish(self, task):
        return self.library.finish_parallel(self.identifier, task['starting_version'], task['workspace'])

    def test_two_agents_and_author_accumulate_in_one_diff_with_choices_and_notes_preserved(self):
        file = self.file()
        equation = next(edit for edit in file['edits'] if 'E=' in edit['new'] or edit['new'] == '1')
        self.session.update('save', self.request(decisions={equation['id']: 'reject'}, comments={equation['id']: 'Keep the original equation.'}))
        self.session.edit_workspace(self.request())
        before = self.session.store.path.read_bytes()
        first = self.library.begin(self.identifier, parallel=True)
        second = self.library.begin(self.identifier, parallel=True)
        self.assertNotEqual(first['workspace'], second['workspace'])
        self.assertEqual(self.session.store.path.read_bytes(), before)
        one = Path(first['workspace']) / 'main.tex'
        one.write_text(one.read_text().replace('measured leaves', 'observed leaves'))
        two = Path(second['workspace']) / 'main.tex'
        two.write_text(two.read_text().replace('the explanation', 'the detailed explanation'))
        author = self.repo / 'main.tex'
        author.write_text(author.read_text().replace('expand', 'extend'))
        r = self.session.store.read()
        self.session.capture_file(self.request(file='main.tex', text=author.read_text(), source=r['metadata']['workspace_version']))
        authored = author.read_bytes()
        self.finish(first)
        result = self.finish(second)
        record = self.session.store.read()
        text = selected_content(self.file(), record['decisions'])
        self.assertIn('observed leaves', text)
        self.assertIn('extend the detailed explanation', text)
        self.assertIn('E=2', text)
        self.assertEqual(record['decisions'][equation['id']], 'reject')
        self.assertIn('Keep the original equation.', str(record['comments']) + str(record['history']))
        self.assertEqual(record['snapshot']['base'], self.base)
        self.assertEqual(record['baseline'], self.base)
        self.assertEqual(result['review'], self.identifier)
        self.assertEqual(author.read_bytes(), authored)
        agent_edits = [edit for edit in self.file()['edits'] if 'observed' in edit['new'] or 'detailed' in edit['new']]
        self.assertTrue(agent_edits)
        self.assertTrue(all(record['decisions'].get(edit['id'], 'pending') == 'pending' for edit in agent_edits))

    def test_an_agent_can_revise_rejected_wording_without_a_false_concurrent_conflict(self):
        first = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={first['id']: 'reject'}))
        task = self.library.begin(self.identifier, parallel=True)
        source = Path(task['workspace']) / 'main.tex'
        self.assertIn('all nodes', source.read_text())
        source.write_text(source.read_text().replace('all nodes', 'observed nodes'))
        self.finish(task)
        record = self.session.store.read()
        self.assertIn('observed nodes', selected_content(self.file(), record['decisions']))
        self.assertNotIn(first['id'], record['decisions'])

    def test_an_unaffected_dispatched_note_keeps_its_message_identity_after_an_agent_result(self):
        equation = next(edit for edit in self.file()['edits'] if edit['new'] == '1')
        self.session.update('save', self.request(comments={equation['id']:'Explain this equation.'}))
        message = self.session.agent_request(self.request(id=equation['id']))['discussion']
        task = self.library.begin(self.identifier, parallel=True)
        source = Path(task['workspace']) / 'main.tex'
        source.write_text(source.read_text().replace('measured', 'observed'))
        self.finish(task)
        feedback = self.session.report(message)
        self.assertEqual(feedback['comments'][0]['discussion_id'], message)
        self.session.import_responses([{'id':message,'text':'The equation preserves the chosen objective.'}], feedback['revision'])
        reply = self.session.report(message)['history'][0]
        self.assertEqual(reply['comment'],'Explain this equation.')
        self.assertEqual(reply['replies'][0]['text'],'The equation preserves the chosen objective.')

    def test_overlapping_agents_leave_the_author_and_review_unchanged_on_conflict(self):
        first = self.library.begin(self.identifier, parallel=True)
        second = self.library.begin(self.identifier, parallel=True)
        for task, word in ((first, 'observed'), (second, 'recorded')):
            source = Path(task['workspace']) / 'main.tex'
            source.write_text(source.read_text().replace('measured', word))
        self.finish(first)
        record = self.session.store.path.read_bytes()
        author = (self.repo / 'main.tex').read_bytes()
        with self.assertRaisesRegex(ValueError, 'overlaps newer manuscript edits'):
            self.finish(second)
        self.assertEqual(self.session.store.path.read_bytes(), record)
        self.assertEqual((self.repo / 'main.tex').read_bytes(), author)
        self.assertIn('recorded', (Path(second['workspace']) / 'main.tex').read_text())

    def test_unsaved_author_drafts_do_not_block_proposals_and_new_files_remain_reviewable(self):
        text = selected_content(self.file(), self.session.store.read()['decisions'])
        self.session.save_draft(self.request(id='main.tex', draft={'file':'main.tex', 'source':self.session.store.read()['result'], 'text':text+'Unfinished author wording.'}))
        draft = self.session.store.read()['drafts']
        task = self.library.begin(self.identifier, parallel=True)
        workspace = Path(task['workspace'])
        (workspace / 'note.txt').write_text('Agent explanation.')
        git(workspace, 'add', 'note.txt')
        self.finish(task)
        record = self.session.store.read()
        self.assertEqual(record['drafts'], draft)
        added = next(file for file in record['snapshot']['files'] if file['path'] == 'note.txt')
        self.assertEqual(added['after'], 'Agent explanation.')
        self.assertTrue(all(edit['id'] not in record['decisions'] for edit in added['edits']))
        self.assertFalse((self.repo / 'note.txt').exists())

    def test_native_save_after_agent_result_preserves_both_changes_and_rejected_wording(self):
        equation = next(edit for edit in self.file()['edits'] if edit['new'] == '1')
        decisions = {edit['id']: 'accept' for file in self.session.snapshot['files'] for edit in file['edits']}
        decisions[equation['id']] = 'reject'
        self.session.update('apply', self.request(decisions=decisions))
        self.session.edit_workspace(self.request())
        task = self.library.begin(self.identifier, parallel=True)
        source = Path(task['workspace']) / 'main.tex'
        source.write_text(source.read_text().replace('measured', 'observed'))
        self.finish(task)
        author = self.repo / 'main.tex'
        author.write_text(author.read_text().replace('E=2', 'E=3'))
        record = self.session.store.read()
        self.session.capture_file(self.request(file='main.tex', text=author.read_text(), source=record['metadata']['workspace_version']))
        record = self.session.store.read()
        selected = selected_content(self.file(), record['decisions'])
        self.assertIn('observed', selected)
        self.assertIn('E=3', selected)
        self.assertIn('measured', author.read_text())

    def test_retained_draft_can_continue_and_save_after_a_disjoint_agent_result(self):
        self.session.edit_workspace(self.request())
        record = self.session.store.read()
        original = selected_content(self.file(), record['decisions'])
        draft = {'file':'main.tex', 'source':record['result'], 'text':original.replace('explanation', 'detailed explanation')}
        self.session.save_draft(self.request(id='main.tex', draft=draft))
        task = self.library.begin(self.identifier, parallel=True)
        source = Path(task['workspace']) / 'main.tex'
        source.write_text(source.read_text().replace('measured', 'observed'))
        self.finish(task)
        draft['text'] = draft['text'].replace('expand', 'extend')
        self.session.save_draft(self.request(id='main.tex', draft=draft))
        self.session.update('file', self.request(file='main.tex', source=draft['source'], text=draft['text']))
        record = self.session.store.read()
        text = selected_content(self.file(), record['decisions'])
        self.assertIn('observed', text)
        self.assertIn('extend the detailed explanation', text)
        self.assertNotIn('main.tex', record['drafts'])

    def test_repeated_finish_is_a_noop_and_apply_accepts_a_new_proposal_file(self):
        task = self.library.begin(self.identifier, parallel=True)
        workspace = Path(task['workspace'])
        (workspace / 'note.txt').write_text('A new source note.')
        git(workspace, 'add', 'note.txt')
        self.finish(task)
        original = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already incorporated'):
            self.finish(task)
        self.assertEqual(self.session.store.path.read_bytes(), original)
        decisions = {edit['id']: 'accept' for file in self.session.snapshot['files'] for edit in file['edits']}
        self.session.update('apply', self.request(decisions=decisions))
        self.assertEqual((self.repo / 'note.txt').read_text(), 'A new source note.')

    def test_binary_dependencies_are_never_silently_dropped(self):
        task = self.library.begin(self.identifier, parallel=True)
        workspace = Path(task['workspace'])
        (workspace / 'figure.png').write_bytes(b'\x89PNG\0binary figure')
        source = workspace / 'main.tex'
        source.write_text(source.read_text()+'\\includegraphics{figure.png}\n')
        git(workspace, 'add', 'figure.png')
        original = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'binary.*figure.png'):
            self.finish(task)
        self.assertEqual(self.session.store.path.read_bytes(), original)
        self.assertTrue((workspace / 'figure.png').is_file())
