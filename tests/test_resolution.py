import copy
from test_review import ReviewFixture
from manuscript_review.comparison import git
from manuscript_review.library import Library
from manuscript_review.migrations.v6 import upgrade
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json, ReviewStore


class ResolutionTests(ReviewFixture):
    def note(self):
        identifier = self.file()['edits'][0]['id']
        self.session.update('save', self.request(comments={identifier: 'Please clarify this loss.'}))
        return self.session.report()['comments'][0]

    def test_resolution_changes_only_status_and_is_idempotent(self):
        note = self.note()
        before = self.session.store.read()
        head, index = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage')
        text = (self.repo / 'main.tex').read_bytes()
        result = self.session.resolve_thread(self.request(id=note['discussion_id'], resolved=True))
        after = self.session.store.read()
        self.assertEqual(after, {**before, 'revision': before['revision'] + 1, 'resolved': [note['thread_id']]})
        self.assertTrue(self.session.report()['comments'][0]['resolved'])
        saved = self.session.store.path.read_bytes()
        repeated = self.session.resolve_thread(self.request(id=note['thread_id'], resolved=True))
        self.assertEqual(repeated, result)
        self.assertEqual(self.session.store.path.read_bytes(), saved)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        self.assertEqual((self.repo / 'main.tex').read_bytes(), text)

    def test_replies_and_followups_keep_origin_status_until_author_reopens(self):
        note = self.note()
        self.session.resolve_thread(self.request(id=note['id'], resolved=True))
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Clarified in the new revision.'}], self.session.store.read()['revision'])
        self.session.update('save', self.request(comments={note['id']: 'One more question.'}))
        report = self.session.report()
        self.assertEqual({entry['thread_id'] for entry in [*report['comments'], *report['history']]}, {note['thread_id']})
        self.assertTrue(all(entry['resolved'] for entry in [*report['comments'], *report['history']]))
        self.session.resolve_thread(self.request(id=report['history'][0]['id'], resolved=False))
        report = self.session.report()
        self.assertFalse(any(entry['resolved'] for entry in [*report['comments'], *report['history']]))
        self.assertEqual(report['history'][0]['replies'][0]['text'], 'Clarified in the new revision.')

    def test_source_comments_and_new_rounds_preserve_status_and_previous_record(self):
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working', 'entry': ''}, 'first')
        identifier = library.jobs['first']['review']
        session = ReviewSession(library.directory(identifier))
        record = session.store.read()
        session.import_annotations([{'file': 'main.tex', 'quote': 'explanation', 'text': 'Clarify this unchanged wording.'}], record['revision'])
        note = session.report()['history'][0]
        session.resolve_thread({'revision': session.store.read()['revision'], 'id': note['thread_id'], 'resolved': True})
        before = session.store.path.read_bytes()
        path = self.repo / 'main.tex'
        path.write_text(path.read_text().replace('measured leaves', 'measured cells'))
        record = session.store.read()
        library.prepare({'repo': str(self.repo), 'base': record['result'], 'proposed': 'working',
                         'previous': identifier, 'previous_revision': record['revision'], 'entry': ''}, 'next')
        self.assertEqual(library.jobs['next']['status'], 'ready', library.jobs['next'])
        next_session = ReviewSession(library.directory(library.jobs['next']['review']))
        self.assertEqual(next_session.store.read()['resolved'], [note['thread_id']])
        self.assertTrue(next_session.report()['history'][0]['resolved'])
        self.assertEqual(next_session.store.read()['baseline'], self.base)
        self.assertEqual(session.store.path.read_bytes(), before)
        next_session.resolve_thread({'revision': next_session.store.read()['revision'], 'id': note['id'], 'resolved': False})
        self.assertEqual(session.store.path.read_bytes(), before)

    def test_invalid_or_stale_status_requests_preserve_the_record(self):
        note = self.note()
        before = self.session.store.path.read_bytes()
        for values in ({'id': 'missing', 'resolved': True}, {'resolved': True}, {'id': None, 'resolved': True},
                       {'id': note['id'], 'resolved': 1}, {'id': note['id'], 'resolved': True, 'revision': -1}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.session.resolve_thread(self.request(**values))
            self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_same_passage_in_a_new_round_creates_an_unresolved_independent_thread(self):
        path = self.repo / 'main.tex'
        path.write_text('One.\n');self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        path.write_text('Two.\n');self.commit()
        library = Library(self.root / 'library')
        library.prepare({'repo': str(self.repo), 'base': base, 'proposed': 'working', 'entry': ''}, 'first')
        identifier = library.jobs['first']['review']
        first = ReviewSession(library.directory(identifier))
        passage = first.snapshot['files'][0]['hunks'][0]['id']
        first.update('save', {'revision': 0, 'decisions': {}, 'comments': {passage: 'Old issue.'}})
        note = first.report()['comments'][0]
        first.resolve_thread({'revision': 1, 'id': passage, 'resolved': True})
        path.write_text('Six.\n')
        library.prepare({'repo': str(self.repo), 'previous': identifier, 'expected_revision': 2, 'proposed': 'working', 'entry': ''}, 'next')
        next_session = ReviewSession(library.directory(library.jobs['next']['review']))
        self.assertEqual(next_session.snapshot['files'][0]['hunks'][0]['id'], passage)
        next_session.update('save', {'revision': 0, 'decisions': {}, 'comments': {passage: 'A new issue.'}})
        report = next_session.report()
        self.assertTrue(report['history'][0]['resolved'])
        self.assertFalse(report['comments'][0]['resolved'])
        self.assertNotEqual(report['comments'][0]['thread_id'], note['thread_id'])

    def test_manual_source_save_keeps_the_origin_of_an_unaffected_current_note(self):
        note = self.note()
        self.session.resolve_thread(self.request(id=note['id'], resolved=True))
        second = self.file()['hunks'][1]
        proposed = self.session.snapshot['proposed']
        self.session.update('file', self.file_request(second['id'], 'We carefully expand the explanation.'))
        self.assertNotEqual(self.session.snapshot['proposed'], proposed)
        current = self.session.report()['comments'][0]
        self.assertEqual(current['thread_id'], note['thread_id'])
        self.assertTrue(current['resolved'])

    def test_legacy_origin_and_new_current_target_remain_independent(self):
        note = self.note()
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Old response.'}], self.session.store.read()['revision'])
        record = self.session.store.read()
        record['history'][0]['origin_id'] = note['id']
        record['comments'] = {note['id']: 'A separate current issue.'}
        self.session.store.commit(record)
        self.session.resolve_thread(self.request(id=note['id'], resolved=True))
        report = self.session.report()
        self.assertTrue(report['history'][0]['resolved'])
        self.assertFalse(report['comments'][0]['resolved'])
        self.session.resolve_thread(self.request(id=report['comments'][0]['thread_id'], resolved=True))
        self.assertTrue(self.session.report()['comments'][0]['resolved'])

    def test_v6_migration_preserves_exact_bytes_and_every_other_field(self):
        self.note()
        old = self.session.store.read()
        old.update(schema=6, revision=23)
        old.pop('resolved')
        home = self.root / 'old-library'
        path = home / 'reviews' / old['metadata']['id'] / 'review.json'
        atomic_json(path, old)
        original = path.read_bytes()
        self.assertEqual(upgrade(home), 1)
        self.assertEqual(ReviewStore(path.parent).read(), {**old, 'schema': 7, 'resolved': []})
        self.assertEqual((path.parent / 'migration-v6/review.json').read_bytes(), original)
        self.assertEqual(upgrade(home), 0)

    def test_migration_keeps_a_saved_current_followup_with_its_old_exchange(self):
        note = self.note()
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'First response.'}], self.session.store.read()['revision'])
        old = self.session.store.read()
        old['history'][0]['origin_id'] = note['id']
        old['comments'] = {note['id']: 'Saved follow-up.'}
        old.pop('resolved')
        for schema in (5, 6):
            with self.subTest(schema=schema):
                old['schema'] = schema
                home = self.root / f'old-{schema}-library'
                path = home / 'reviews' / old['metadata']['id'] / 'review.json'
                atomic_json(path, old)
                original = path.read_bytes()
                self.assertEqual(upgrade(home), 1)
                session = ReviewSession(path.parent)
                report = session.report()
                self.assertEqual(report['comments'][0]['thread_id'], report['history'][0]['thread_id'])
                self.assertEqual(report['history'][0]['id'], note['discussion_id'])
                self.assertEqual(report['history'][0]['replies'][0]['text'], 'First response.')
                self.assertEqual((path.parent / f'migration-v{schema}/review.json').read_bytes(), original)

    def test_migration_validates_every_record_and_archive_before_writing_any(self):
        home = self.root / 'old-library'
        old = self.session.store.read()
        old.update(schema=6)
        old.pop('resolved')
        first, second = [home / 'reviews' / identifier / 'review.json' for identifier in ('a' * 24, 'b' * 24)]
        atomic_json(first, old)
        invalid = copy.deepcopy(old)
        invalid['result'] = 'invalid'
        atomic_json(second, invalid)
        before = first.read_bytes()
        with self.assertRaises(ValueError):
            upgrade(home)
        self.assertEqual(first.read_bytes(), before)

        self.assertFalse((first.parent / 'migration-v6').exists())
        atomic_json(second, old)
        archive = second.parent / 'migration-v6/review.json'
        atomic_json(archive, {'original': 'other bytes'})
        with self.assertRaisesRegex(ValueError, 'original record changed'):
            upgrade(home)
        self.assertEqual(first.read_bytes(), before)
        self.assertFalse((first.parent / 'migration-v6').exists())
        archive.unlink()
        atomic_json(second.parent / 'transaction.json', {})
        with self.assertRaisesRegex(ValueError, 'interrupted manuscript save'):
            upgrade(home)
        self.assertEqual(first.read_bytes(), before)

    def test_import_preserves_current_followup_status_and_earlier_round_origins(self):
        note = self.note()
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Original response.'}], self.session.store.read()['revision'])
        record = self.session.store.read()
        record['comments'] = {note['id']: 'Current follow-up.'}
        record['resolved'] = [note['thread_id'], 'earlier-review:old-issue']
        self.session.store.commit(record)
        original = self.session.store.path.read_bytes()
        library = Library(self.root / 'library')
        identifier = library.import_review(self.directory)
        imported = ReviewSession(library.directory(identifier))
        report = imported.report()
        self.assertTrue(report['comments'][0]['resolved'])
        self.assertEqual(report['comments'][0]['thread_id'], report['history'][0]['thread_id'])
        self.assertEqual(report['history'][0]['id'], note['discussion_id'])
        self.assertEqual(report['history'][0]['replies'][0]['text'], 'Original response.')
        self.assertIn('earlier-review:old-issue', imported.store.read()['resolved'])
        self.assertEqual(self.session.store.path.read_bytes(), original)
