from test_review import ReviewFixture
from manuscript_review.session import ReviewSession
from manuscript_review.storage import StaleReview


class DraftTests(ReviewFixture):
    def test_retained_unmatched_draft_remains_readable_and_discardable(self):
        record = self.session.store.read()
        record['drafts']['retired-passage'] = 'Preserved source from an earlier comparison.'
        self.session.store.commit(record)
        self.assertEqual(self.session.report()['drafts'], record['drafts'])
        with self.assertRaisesRegex(ValueError, 'passage drafts'):
            self.session.update('apply', self.request())
        self.session.save_draft({'revision': 0, 'passage_id': 'retired-passage', 'text': None})
        self.assertEqual(self.session.store.read()['drafts'], {})

    def test_passage_revision_cannot_orphan_another_saved_draft(self):
        first, second = self.file()['hunks'][:2]
        self.session.save_draft({'revision': 0, 'passage_id': second['id'], 'text': 'An unfinished second passage.'})
        before = self.session.store.path.read_bytes()
        source = (self.repo / 'main.tex').read_bytes()
        with self.assertRaisesRegex(ValueError, 'another draft'):
            self.session.update('passage', self.request(passage_id=first['id'], text='We score chosen cells.\n\nWe retain the explanation.'))
        self.assertEqual(self.session.store.path.read_bytes(), before)
        self.assertEqual((self.repo / 'main.tex').read_bytes(), source)
        self.session.save_draft({'revision': 1, 'passage_id': second['id'], 'text': None})
        self.assertEqual(self.session.store.read()['drafts'], {})

    def test_navigation_and_stale_windows_cannot_erase_source_drafts(self):
        first, second = self.file()['hunks'][:2]
        initial = self.session.store.read()['revision']
        self.session.save_draft({'revision': initial, 'passage_id': first['id'], 'text': 'Unsaved source from window one.'})
        other = ReviewSession(self.directory)
        other.save_ui({'positions': {'round': {'active': 0}}})
        self.assertEqual(other.store.read()['drafts'][first['id']], 'Unsaved source from window one.')
        with self.assertRaises(StaleReview):
            other.save_draft({'revision': initial, 'passage_id': first['id'], 'text': None})
        with self.assertRaises(ValueError):
            other.save_ui({'drafts': {}})
        r = other.store.read()
        other.save_draft({'revision': r['revision'], 'passage_id': second['id'], 'text': 'Second draft.'})
        self.assertEqual(len(other.store.read()['drafts']), 2)

    def test_discard_and_passage_save_clear_only_their_own_draft(self):
        first, second = self.file()['hunks'][:2]
        for h in (first, second):
            self.session.save_draft({'revision': self.session.store.read()['revision'], 'passage_id': h['id'], 'text': 'Saved draft.'})
        request = {'revision': self.session.store.read()['revision'], 'passage_id': first['id'], 'text': None}
        discarded = self.session.save_draft(request)
        repeated = self.session.save_draft({**request, 'revision': discarded['revision']})
        self.assertEqual(repeated['revision'], discarded['revision'])
        self.assertEqual(self.session.store.read()['drafts'], {second['id']: 'Saved draft.'})
        self.session.update('passage', self.request(passage_id=second['id'], text='We retain the short explanation.'))
        self.assertEqual(self.session.store.read()['drafts'], {})
        self.assertIn('short explanation', (self.repo / 'main.tex').read_text())
