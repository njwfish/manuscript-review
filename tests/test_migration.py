import copy
import importlib.util
import json
from pathlib import Path
from test_review import ReviewFixture
from manuscript_review.comparison import stable_id, compare, enrich_snapshot
from manuscript_review.storage import atomic_json, ReviewStore
from manuscript_review.editing import selected_content
from manuscript_review.migrations.v5 import port_drafts, upgrade as upgrade_files

spec = importlib.util.spec_from_file_location('import_v1', Path(__file__).parents[1] / 'migrations/import_v1.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
discussion_spec = importlib.util.spec_from_file_location('upgrade_discussion', Path(__file__).parents[1] / 'migrations/upgrade_discussion.py')
discussion_upgrade = importlib.util.module_from_spec(discussion_spec)
discussion_spec.loader.exec_module(discussion_upgrade)
draft_spec = importlib.util.spec_from_file_location('upgrade_drafts', Path(__file__).parents[1] / 'migrations/upgrade_drafts.py')
draft_upgrade = importlib.util.module_from_spec(draft_spec)
draft_spec.loader.exec_module(draft_upgrade)


class MigrationTests(ReviewFixture):
    def test_v5_passage_drafts_include_rejected_deletions_at_both_ends(self):
        for before, after in [('First removed', 'First'), ('removed First', 'First')]:
            old = self.session.store.read()
            file = enrich_snapshot({'files': [compare('main.tex', before, after)]})['files'][0]
            old['snapshot']['files'] = [file]
            old['schema'] = 5
            old['decisions'] = {g['id']: 'reject' for g in file['edits']}
            old['drafts'] = {file['hunks'][0]['id']: 'Replacement'}
            current = port_drafts(old)
            self.assertEqual(current['drafts']['main.tex']['text'], 'Replacement')

    def test_v5_drafts_become_one_file_draft_and_keep_detached_words(self):
        old = self.session.store.read()
        old['schema'] = 5
        first, second = self.file()['hunks'][:2]
        old['drafts'] = {first['id']: ' First unfinished source. \n',
                         second['id']: ' Second unfinished source. \n', 'unmatched': ' Detached exact words. \n'}
        old['comments'] = {self.file()['edits'][0]['id']: 'Original note.'}
        home = self.root / 'v5-library'
        path = home / 'reviews' / old['metadata']['id'] / 'review.json'
        atomic_json(path, old)
        original = path.read_bytes()
        self.assertEqual(upgrade_files(home), 1)
        current = ReviewStore(path.parent).read()
        self.assertEqual({k: v for k, v in current.items() if k not in ('schema', 'drafts')},
                         {k: v for k, v in old.items() if k not in ('schema', 'drafts')})
        self.assertEqual(set(current['drafts']), {'main.tex', 'unmatched'})
        draft = current['drafts']['main.tex']
        self.assertEqual(draft['source'], old['result'])
        for identifier in (first['id'], second['id']):
            self.assertIn(old['drafts'][identifier], draft['text'])
        self.assertEqual(current['drafts']['unmatched']['text'], old['drafts']['unmatched'])
        self.assertIsNone(current['drafts']['unmatched']['file'])
        self.assertEqual((path.parent / 'migration-v5/review.json').read_bytes(), original)
        self.assertEqual(upgrade_files(home), 0)

    def test_v4_port_moves_drafts_verbatim_without_changing_other_review_content(self):
        old = self.session.store.read()
        old['schema'] = 4
        old.pop('drafts')
        old['ui'] = {'drafts': {self.file()['hunks'][0]['id']: ' Exact unfinished source. \n'}, 'positions': {'round': {'edit': 1}}}
        home = self.root / 'v4-library'
        path = home / 'reviews' / old['metadata']['id'] / 'review.json'
        atomic_json(path, old)
        original = path.read_bytes()
        expected = copy.deepcopy(old)
        expected['schema'] = 6
        expected['drafts'] = expected['ui'].pop('drafts')
        expected = port_drafts(expected)
        self.assertEqual(draft_upgrade.upgrade(home), 1)
        self.assertEqual(ReviewStore(path.parent).read(), expected)
        self.assertEqual((path.parent / 'migration-v4/review.json').read_bytes(), original)
        self.assertEqual(draft_upgrade.upgrade(home), 0)

    def test_v3_port_adds_only_authorship_and_keeps_ids_notes_replies_and_drafts(self):
        passage = self.file()['hunks'][0]
        self.session.update('save', self.request(comments={passage['id']: ' Original author note. \n'}))
        from manuscript_review.feedback import feedback_report
        record = self.session.store.read()
        note = feedback_report(record['snapshot'], record['decisions'], record['comments'], [])['comments'][0]
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Original agent reply.'}], record['revision'])
        record = self.session.store.read()
        from manuscript_review.history import round_id
        pending = self.file()['hunks'][1]['id']
        record['comments'][pending] = 'A current note that has not been answered.'
        pending_id = stable_id('discussion', [round_id(record['snapshot']), pending, record['comments'][pending]])
        record['ui'] = {'drafts': {passage['id']: 'Unfinished source'}, 'positions': {'round': {'active': 1}}}
        record['schema'] = 3
        record.pop('drafts')
        for entry in record['history']:
            entry.pop('author')
        original = copy.deepcopy(record)
        home = self.root / 'v3-library'
        path = home / 'reviews' / record['metadata']['id'] / 'review.json'
        atomic_json(path, record)
        original_bytes = path.read_bytes()
        expected = copy.deepcopy(record)
        expected['schema'] = 6
        expected['history'][0]['author'] = 'user'
        expected['drafts'] = expected['ui'].pop('drafts')
        expected = port_drafts(expected)
        self.assertEqual(discussion_upgrade.upgrade(home), 1)
        migrated = ReviewStore(path.parent).read()
        self.assertEqual(migrated, expected)
        exported = feedback_report(migrated['snapshot'], migrated['decisions'], migrated['comments'], migrated['history'])
        self.assertEqual(exported['comments'][0]['discussion_id'], pending_id)
        self.assertEqual(record, original)
        self.assertEqual((path.parent / 'migration-v3/review.json').read_bytes(), original_bytes)
        self.assertEqual(discussion_upgrade.upgrade(home), 0)

    def test_v3_upgrade_checks_all_records_before_replacing_any(self):
        home = self.root / 'v3-library'
        old = self.session.store.read()
        old['schema'] = 3
        first = home / 'reviews' / ('a' * 24) / 'review.json'
        invalid = home / 'reviews' / ('b' * 24) / 'review.json'
        atomic_json(first, old)
        atomic_json(invalid, {**old, 'result': 'invalid'})
        before = first.read_bytes()
        with self.assertRaises(ValueError):
            discussion_upgrade.upgrade(home)
        self.assertEqual(first.read_bytes(), before)
        self.assertFalse((first.parent / 'migration-v3').exists())

    def test_one_time_import_keeps_manual_source_decisions_and_verbatim_notes(self):
        snapshot = copy.deepcopy(self.session.snapshot)
        file = next(f for f in snapshot['files'] if f['path'] == 'main.tex')
        first, second = file['edits'][:2]
        original_id = stable_id('edit', [file['path'], *first['members']])
        choices = {member:'reject' for member in second['members']}
        note = '  Preserve this exact comment. \n'
        state = {'revision':9,'decisions':choices,'comments':{original_id:note},'revisions':{original_id:'custom cells'}}
        for f in snapshot['files']:
            for h in f['hunks']:
                for key in ('base_span','proposal_span','id','edits','grouped_segments','before','after','piece_ids'):
                    h.pop(key,None)
            f.pop('edits',None)
        snapshot['version']=1
        source=self.root/'retired';source.mkdir()
        atomic_json(source/'snapshot.json',snapshot);atomic_json(source/'state.json',state)
        before={p.name:p.read_bytes() for p in source.iterdir()}
        destination=self.root/'0123456789abcdef01234567'
        record=importer.import_v1(source,destination)
        ReviewStore(destination).read()
        current=next(f for f in record['snapshot']['files'] if f['path']=='main.tex')
        self.assertIn('custom cells',selected_content(current,record['decisions']))
        self.assertIn('retain the explanation',selected_content(current,record['decisions']))
        self.assertEqual(record['history'][0]['comment'],note)
        self.assertEqual(json.loads((destination/'migration-original/state.json').read_text()),state)
        self.assertEqual({p.name:p.read_bytes() for p in source.iterdir()},before)
        with self.assertRaises(ValueError):importer.import_v1(source,destination)
        with self.assertRaises(ValueError):ReviewStore(source).read()
