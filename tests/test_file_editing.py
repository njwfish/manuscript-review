from test_review import ReviewFixture
from manuscript_review.editing import selected_content
from manuscript_review.comparison import build_snapshot, git
from manuscript_review.storage import new_record


class FileEditingTests(ReviewFixture):
    def versions(self, before, after):
        (self.repo / 'main.tex').write_text(before)
        self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / 'main.tex').write_text(after)
        self.commit()
        snapshot = build_snapshot(self.repo, base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='')
        self.session.store.commit(new_record(snapshot, self.session.store.read()['metadata']))

    def revise(self, text):
        return self.session.update('file', self.request(file='main.tex', source=self.session.store.read()['result'], text=text))

    def test_manual_save_preserves_unrelated_rejections_pending_source_and_comments(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'},
                                                comments={first['id']: 'Use chosen cells.', second['id']: 'Keep this comment.'}))
        record = self.session.store.read()
        before = (self.repo / 'main.tex').read_text()
        text = selected_content(self.file(), record['decisions']).replace('measured leaves', 'chosen cells')
        result = self.revise(text)
        current = self.file()
        self.assertEqual(result['data']['base'], record['snapshot']['base'])
        self.assertEqual(self.session.store.read()['baseline'], record['baseline'])
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')
        self.assertNotIn(third['id'], self.session.store.read()['decisions'])
        self.assertEqual(self.session.store.read()['comments'], {second['id']: 'Keep this comment.'})
        self.assertEqual((self.repo / 'main.tex').read_text(), before.replace('measured leaves', 'chosen cells'))
        self.assertIn('expand the explanation', current['after'])
        self.assertIn('retain the explanation', selected_content(current, self.session.store.read()['decisions']))
        self.assertEqual(self.session.store.read()['history'][0]['comment'], 'Use chosen cells.')
        self.assertNotEqual(self.session.store.read()['result'], record['result'])

    def test_changes_in_multiple_passages_and_outside_the_diff_accumulate(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions'])
        text = 'Context before the manuscript.\n\n' + text.replace('measured leaves', 'chosen cells').replace('E=1', 'E=3') + '\nA final explanation.\n'
        self.revise(text)
        working = (self.repo / 'main.tex').read_text()
        self.assertTrue(working.startswith('Context before the manuscript.'))
        self.assertIn('chosen cells', working)
        self.assertIn('E=3', working)
        self.assertTrue(working.endswith('A final explanation.\n'))
        self.assertIn('expand the explanation', working)
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')

    def test_manual_save_after_applying_choices_keeps_the_working_projection(self):
        first, second, third = self.file()['edits']
        self.session.update('apply', self.request(decisions={first['id']: 'reject', third['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions']).replace('explanation', 'short explanation')
        self.revise(text)
        self.assertEqual((self.repo / 'main.tex').read_text(), text)
        self.assertEqual(self.session.store.read()['decisions'][first['id']], 'reject')
        self.assertEqual(self.session.store.read()['decisions'][third['id']], 'reject')

    def test_editing_rejected_wording_revises_only_that_replacement(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={first['id']: 'reject', second['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions']).replace('all nodes', 'chosen nodes')
        self.revise(text)
        self.assertIn('chosen nodes', self.file()['after'])
        self.assertIn('expand the explanation', self.file()['after'])
        self.assertIn('retain the explanation', selected_content(self.file(), self.session.store.read()['decisions']))
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')

    def test_outside_edits_are_refused_and_the_source_draft_is_retained(self):
        editor = self.session.editor('main.tex')
        text = editor['text'].replace('measured leaves', 'chosen cells')
        self.session.save_draft({'revision': editor['revision'], 'id': 'main.tex', 'draft': {'file': 'main.tex', 'source': editor['source'], 'text': text}})
        (self.repo / 'main.tex').write_text('Outside edit.\n')
        record = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'edited outside'):
            self.revise(text)
        self.assertEqual(self.session.store.path.read_bytes(), record)
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Outside edit.\n')
        self.assertEqual(self.session.store.read()['drafts']['main.tex']['text'], text)

    def test_rejected_deletion_at_a_manual_interval_end_is_not_duplicated(self):
        self.versions('Start old middle removed end.\n', 'Start new middle end.\n')
        removed = next(g for g in self.file()['edits'] if g['old'] == ' removed')
        self.session.update('apply', self.request(decisions={removed['id']: 'reject'}))
        self.revise('Start replacement end.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Start replacement end.\n')
        self.assertEqual(selected_content(self.file(), self.session.store.read()['decisions']), 'Start replacement end.\n')

    def test_an_untouched_rejected_deletion_at_the_boundary_remains(self):
        self.versions('Start old middle removed end.\n', 'Start new middle end.\n')
        removed = next(g for g in self.file()['edits'] if g['old'] == ' removed')
        self.session.update('apply', self.request(decisions={removed['id']: 'reject'}))
        self.revise('Start replacement removed end.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Start replacement removed end.\n')

    def test_repeated_source_and_unicode_keep_their_locations(self):
        self.versions('α😀\n\nOne cell.\n\nRepeated description.\n\nOne cell.\n',
                      'α😀\n\nTwo cells.\n\nRepeated description.\n\nTwo cells.\n')
        first, second = self.file()['edits']
        self.session.update('apply', self.request(decisions={first['id']: 'reject', second['id']: 'accept'}))
        self.session.update('save', self.request(decisions={first['id']: 'accept', second['id']: 'reject'}))
        editor = self.session.editor('main.tex')
        mark = next(r for r in editor['ranges'] if r['id'] == first['id'])
        utf16 = editor['text'].encode('utf-16-le')
        self.assertEqual(utf16[mark['from'] * 2:mark['to'] * 2].decode('utf-16-le'), first['new'])
        self.revise('α😀\n\nTwo cells.\n\nRepeated description.\n\nChosen cells.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'α😀\n\nOne cell.\n\nRepeated description.\n\nChosen cells.\n')
        self.assertEqual(self.session.store.read()['decisions'][first['id']], 'accept')

    def test_new_and_previously_deleted_files_can_be_edited(self):
        for path, text in [('empty.txt', 'New text.\n'), ('deleted.txt', 'Restored text.\n')]:
            self.session.update('file', self.request(file=path, source=self.session.store.read()['result'], text=text))
            self.assertEqual((self.repo / path).read_text(), text)
