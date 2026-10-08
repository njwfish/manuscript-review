from test_review import ReviewFixture
from manuscript_review.session import ReviewSession
from manuscript_review.storage import StaleReview
from manuscript_review.editing import selected_content


class DraftTests(ReviewFixture):
    def draft(self, text, path='main.tex'):
        record = self.session.store.read()
        return {'revision': record['revision'], 'id': path,
                'draft': {'file': path, 'source': record['result'], 'text': text}}

    def test_detached_draft_remains_readable_and_discardable(self):
        record = self.session.store.read()
        record['drafts']['detached'] = {'file': None, 'source': record['result'], 'text': 'Preserved unfinished words.'}
        self.session.store.commit(record)
        self.assertEqual(self.session.report()['drafts'], record['drafts'])
        with self.assertRaisesRegex(ValueError, 'source drafts'):
            self.session.update('apply', self.request())
        self.session.save_draft({'revision': 0, 'id': 'detached', 'draft': None})
        self.assertEqual(self.session.store.read()['drafts'], {})

    def test_navigation_and_stale_windows_cannot_erase_file_drafts(self):
        request = self.draft('Unsaved source from window one.')
        self.session.save_draft(request)
        other = ReviewSession(self.directory)
        other.save_ui({'positions': {'round': {'active': 0}}})
        self.assertEqual(other.store.read()['drafts']['main.tex']['text'], request['draft']['text'])
        with self.assertRaises(StaleReview):
            other.save_draft({'revision': request['revision'], 'id': 'main.tex', 'draft': None})
        with self.assertRaises(ValueError):
            other.save_ui({'drafts': {}})

    def test_decisions_in_a_drafted_file_are_protected_but_comments_still_save(self):
        self.session.save_draft(self.draft('Unfinished source.'))
        group = self.file()['edits'][0]['id']
        with self.assertRaisesRegex(ValueError, 'file draft'):
            self.session.update('save', self.request(decisions={group: 'reject'}))
        self.session.update('save', self.request(comments={group: 'Please check the wording.'}))
        self.assertEqual(self.session.store.read()['drafts']['main.tex']['text'], 'Unfinished source.')

    def test_discard_and_file_save_clear_only_their_own_draft(self):
        text = selected_content(self.file(), {}) + '\nNew context.\n'
        self.session.save_draft(self.draft(text))
        self.session.save_draft(self.draft('A draft for a different file.', 'empty.txt'))
        record = self.session.store.read()
        self.session.update('file', self.request(file='main.tex', source=record['drafts']['main.tex']['source'], text=text))
        self.assertEqual(set(self.session.store.read()['drafts']), {'empty.txt'})
        self.assertIn('New context.', (self.repo / 'main.tex').read_text())
        response = self.session.save_draft({'revision': self.session.store.read()['revision'], 'id': 'empty.txt', 'draft': None})
        repeat = self.session.save_draft({'revision': response['revision'], 'id': 'empty.txt', 'draft': None})
        self.assertEqual(repeat['revision'], response['revision'])

    def test_editor_restores_the_file_and_maps_highlights_over_a_saved_draft(self):
        original = selected_content(self.file(), {})
        text = 'Additional context.\n\n' + original
        self.session.save_draft(self.draft(text))
        editor = self.session.editor('main.tex')
        self.assertEqual(editor['original'], original)
        self.assertEqual(editor['text'], text)
        group = self.file()['edits'][0]
        mark = next(r for r in editor['ranges'] if r['id'] == group['id'])
        self.assertEqual(text[mark['from']:mark['to']], group['new'])
