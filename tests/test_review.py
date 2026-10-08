import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from manuscript_review.comparison import build_snapshot, compare, enrich_snapshot, git, make_patch
from manuscript_review.editing import selected_content, passage_text
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json, new_record, ReviewStore


class ReviewFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo';self.repo.mkdir()
        for args in [('init', '-q'), ('config', 'user.name', 'Test'), ('config', 'user.email', 'test@localhost')]:
            git(self.repo, *args)
        self.base_text = 'We score all nodes.\n\nWe retain the explanation.\n\n\\[E=2\\]\n'
        (self.repo / 'main.tex').write_text(self.base_text)
        (self.repo / 'deleted.txt').write_text('Deleted source')
        self.commit()
        self.base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / 'main.tex').write_text(self.base_text.replace('all nodes', 'measured leaves').replace('retain', 'expand').replace('E=2', 'E=1'))
        (self.repo / 'deleted.txt').unlink()
        (self.repo / 'empty.txt').touch()
        self.commit()
        self.directory = self.root / 'review';self.directory.mkdir()
        snapshot = build_snapshot(self.repo, self.base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='')
        atomic_json(self.directory / 'review.json', new_record(snapshot, {'id': '0123456789abcdef01234567', 'preview_status': 'none', 'base_label': 'Base', 'proposal_label': 'Proposal'}))
        self.session = ReviewSession(self.directory)

    def commit(self):
        git(self.repo, 'add', '-A');git(self.repo, 'commit', '-qm', 'version')

    def tearDown(self):
        self.temp.cleanup()

    def file(self):
        return next(f for f in self.session.snapshot['files'] if f['path'] == 'main.tex')

    def request(self, **values):
        r = self.session.store.read()
        return {'revision': r['revision'], 'decisions': r['decisions'], 'comments': r['comments'], **values}


class ReviewTests(ReviewFixture):
    def test_applied_state_tracks_selected_wording_and_survives_notes(self):
        self.assertFalse(self.session.view()['applied'])
        accepted = {g['id']: 'accept' for f in self.session.snapshot['files'] for g in f['edits']}
        result = self.session.update('apply', self.request(decisions=accepted))
        self.assertTrue(result['applied'])
        self.assertTrue(ReviewSession(self.directory).view()['applied'])
        edit = self.file()['edits'][0]['id']
        self.session.update('save', self.request(comments={edit: 'A follow-up note'}))
        self.assertTrue(self.session.view()['applied'])
        rejected = {**accepted, edit: 'reject'}
        self.session.update('save', self.request(decisions=rejected))
        self.assertFalse(self.session.view()['applied'])
        self.session.update('apply', self.request())
        self.assertTrue(self.session.view()['applied'])

    def test_absent_files_require_an_apply_record(self):
        record = self.session.store.read()
        record['snapshot']['files'] = [f for f in record['snapshot']['files'] if f['status'] == 'deleted']
        self.session.store.commit(record)
        self.assertFalse(self.session.view()['applied'])
        self.session.update('apply', self.request())
        self.assertTrue(self.session.view()['applied'])

    def test_roundtrip_and_patch_including_absent_empty_and_eof(self):
        data = self.session.snapshot
        rejected = {g['id']: 'reject' for f in data['files'] for g in f['edits']}
        for f in data['files']:
            self.assertEqual(selected_content(f, {}), f['after'])
            self.assertEqual(selected_content(f, rejected), f['before'])
        self.session.update('apply', self.request(decisions=rejected))
        patch_file = self.root / 'selected.patch';patch_file.write_text(make_patch(data, {}))
        git(self.repo, 'apply', '--check', str(patch_file));git(self.repo, 'apply', str(patch_file))
        for f in data['files']:
            p = self.repo / f['path']
            self.assertEqual(p.read_text() if p.exists() else None, f['after'])
        self.assertEqual(git(self.repo, 'diff', '--cached', '--name-only'), b'')

    def test_continuous_replacement_and_spans(self):
        file = enrich_snapshot({'files': [compare('word.tex', 'The number of related cells matters.\n', 'The related-cell context matters.\n')]})['files'][0]
        self.assertEqual(len(file['edits']), 1)
        g = file['edits'][0]
        self.assertEqual((g['old'], g['new']), ('number of related cells', 'related-cell context'))
        for h in self.file()['hunks']:
            a,b=h['base_span'];c,d=h['proposal_span']
            self.assertEqual(self.file()['before'][a:b], h['before'])
            self.assertEqual(self.file()['after'][c:d], h['after'])

    def test_whole_passage_rebuilds_diff_and_preserves_unaffected_work(self):
        file = self.file();first,second,third=file['hunks']
        decision = {second['edits'][0]['id']: 'reject'}
        notes = {first['edits'][0]['id']: '  Keep this note. \n', second['id']: 'Another passage note'}
        self.session.update('save', self.request(decisions=decision, comments=notes))
        text = 'We score measured cells and their sisters.\n% Author note'
        result = self.session.update('passage', self.request(passage_id=first['id'], text=text))
        expected = text + '\n\nWe expand the explanation.\n\n\\[E=1\\]\n'
        self.assertEqual((self.repo / 'main.tex').read_text(), expected)
        current = self.session.store.read()
        self.assertEqual(current['decisions'][second['edits'][0]['id']], 'reject')
        self.assertEqual(current['comments'][second['id']], notes[second['id']])
        self.assertEqual(current['history'][0]['comment'], notes[first['edits'][0]['id']])
        self.assertIn('sisters', self.file()['hunks'][0]['after'])
        self.assertEqual(git(self.repo, 'show', self.session.snapshot['proposed'] + ':main.tex').decode(), self.file()['after'])
        self.assertNotIn('revisions', current)
        self.assertNotIn('measured leaves', self.session.selected_patch())
        self.assertTrue(current['history'][0]['target'])
        self.assertEqual(ReviewSession(self.directory).view()['revision'], result['revision'])
        self.assertFalse(result['data']['applied'])
        self.session.update('apply', self.request())
        self.assertEqual((self.repo / 'main.tex').read_text(), expected.replace('expand', 'retain'))

    def test_passage_save_preserves_working_source_after_choices_change(self):
        file = self.file()
        first, second, third = file['hunks']
        rejected = {g['id']: 'reject' for f in self.session.snapshot['files'] for g in f['edits']}
        self.session.update('apply', self.request(decisions=rejected))
        source = (self.repo / 'main.tex').read_text()
        outside = {second['edits'][0]['id']: 'accept', third['edits'][0]['id']: 'accept'}
        self.session.update('save', self.request(decisions={**rejected, **outside}))
        text = 'We score the author’s chosen cells.'
        saved = self.session.update('passage', self.request(passage_id=first['id'], text=text))
        self.assertEqual((self.repo / 'main.tex').read_text(), source.replace(first['before'], text))
        self.assertFalse(saved['data']['applied'])
        self.assertEqual({key: self.session.store.read()['decisions'][key] for key in outside}, outside)
        self.assertFalse((self.repo / 'empty.txt').exists())
        self.assertTrue((self.repo / 'deleted.txt').exists())
        self.session.update('apply', self.request())
        self.assertIn('We expand the explanation.', (self.repo / 'main.tex').read_text())
        self.assertIn('E=1', (self.repo / 'main.tex').read_text())

    def test_passage_save_leaves_unrelated_pending_changes_out_of_source(self):
        file = self.file()
        first, second, third = file['hunks']
        rejected = {g['id']: 'reject' for f in self.session.snapshot['files'] for g in f['edits']}
        self.session.update('apply', self.request(decisions=rejected))
        source = (self.repo / 'main.tex').read_text()
        self.session.update('save', self.request(decisions={}))
        text = 'We score selected observations.'
        self.session.update('passage', self.request(passage_id=first['id'], text=text))
        self.assertEqual((self.repo / 'main.tex').read_text(), source.replace(first['before'], text))
        current = self.session.store.read()
        self.assertNotIn(second['edits'][0]['id'], current['decisions'])
        self.assertNotIn(third['edits'][0]['id'], current['decisions'])

    def test_edit_again_and_return_passage_to_baseline_keeps_discussion(self):
        first = self.file()['hunks'][0]
        self.session.update('save', self.request(comments={first['id']: 'Passage note'}))
        for text in ('We score custom cells.', first['before']):
            h = self.file()['hunks'][0]
            self.session.update('passage', self.request(passage_id=h['id'], text=text))
        r = self.session.store.read()
        self.assertEqual(r['history'][0]['comment'], 'Passage note')
        self.assertIsNone(r['history'][0]['target'])
        self.assertEqual(len(self.file()['hunks']), 2)
        self.assertTrue((self.repo / 'main.tex').read_text().startswith(first['before']))

    def test_stale_or_missing_revision_retains_draft_without_writing(self):
        initial = self.request()
        self.session.update('save', {**initial, 'comments': {self.file()['edits'][0]['id']: 'A note'}})
        for request in (initial, {k:v for k,v in initial.items() if k != 'revision'}):
            with self.assertRaisesRegex(ValueError, 'another window'):
                ReviewSession(self.directory).update('save', request)
        self.assertEqual(self.session.store.read()['revision'], 1)
        self.assertEqual(len(list((self.directory / 'conflicting-drafts').glob('*.json'))), 2)

    def test_external_edit_staging_and_head_protect_source(self):
        first = self.file()['hunks'][0]
        path = self.repo / 'main.tex'
        path.write_text('Outside edit')
        before = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'outside'):
            self.session.update('passage', self.request(passage_id=first['id'], text='Manual text'))
        self.assertEqual(path.read_text(), 'Outside edit')
        self.assertEqual(self.session.store.path.read_bytes(), before)
        git(self.repo, 'add', 'main.tex')
        with self.assertRaisesRegex(ValueError, 'staged changes'):
            self.session.update('apply', self.request())
        git(self.repo, 'commit', '-qm', 'outside')
        with self.assertRaisesRegex(ValueError, 'HEAD changed'):
            self.session.update('apply', self.request())

    def test_interrupted_transaction_recovers_source_and_record(self):
        first = self.file()['hunks'][0]
        original = atomic_json
        def fail_record(path, value):
            if Path(path) == self.session.store.path:
                raise OSError('Simulated interrupted record commit')
            return original(path, value)
        with patch('manuscript_review.storage.atomic_json', side_effect=fail_record):
            with self.assertRaises(OSError):
                self.session.update('passage', self.request(passage_id=first['id'], text='Manually authored passage.'))
        self.assertTrue(self.session.store.journal.exists())
        recovered = ReviewSession(self.directory)
        self.assertFalse(recovered.store.journal.exists())
        self.assertEqual(recovered.store.read()['revision'], 1)
        self.assertTrue((self.repo / 'main.tex').read_text().startswith('Manually authored passage.'))
        self.assertIn('Manually authored', recovered.selected_patch())

    def test_recovery_refuses_intervening_external_write(self):
        r = self.session.store.read()
        r['revision'] += 1
        atomic_json(self.session.store.journal, {'record': r, 'files': [{'path':'main.tex','before':self.file()['after'],'after':'Manual'}]})
        (self.repo / 'main.tex').write_text('External')
        with self.assertRaisesRegex(ValueError, 'interrupted save'):
            ReviewSession(self.directory)
        self.assertEqual((self.repo / 'main.tex').read_text(), 'External')
        self.assertTrue(self.session.store.journal.exists())

    def test_recovery_refuses_new_staged_changes_and_keeps_the_journal(self):
        r = self.session.store.read()
        atomic_json(self.session.store.journal, {'record': r, 'files': [{'path': 'main.tex', 'before': self.file()['after'], 'after': 'Recovered source'}]})
        path = self.repo / 'main.tex'
        path.write_text(self.base_text)
        git(self.repo, 'add', 'main.tex')
        path.write_text(self.file()['after'])
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'staged changes'):
            ReviewSession(self.directory)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(self.session.store.journal.exists())
