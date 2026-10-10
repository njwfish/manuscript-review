import copy
import json
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.comparison import compare, enrich_snapshot, build_snapshot, git
from manuscript_review.library import Library
from manuscript_review.server import review_payload
from manuscript_review.storage import ReviewStore, atomic_json, read_json
from manuscript_review.render_latex import RENDER_VERSION


class InteractiveDataTests(ReviewFixture):
    def test_large_unselected_files_retain_edit_identity_without_transferring_source(self):
        data = self.session.view()
        large = enrich_snapshot({'files': [compare('generated.json', None, 'x' * 100_000)]})['files'][0]
        data['files'].append(large)
        payload = review_payload(data)
        summary = payload['files'][-1]
        self.assertFalse(summary['loaded'])
        self.assertEqual([edit['id'] for edit in summary['edits']], [edit['id'] for edit in large['edits']])
        self.assertEqual(summary['hunks'][0]['edits'][0]['id'], large['edits'][0]['id'])
        self.assertNotIn('before', summary)
        self.assertNotIn('new', summary['edits'][0])
        self.assertLess(len(json.dumps(payload)), len(json.dumps(data)) / 10)
        self.assertEqual(review_payload(data, 'generated.json')['files'][-1], large)
        data['comments'][large['edits'][0]['id']] = 'Keep this note and its exact context.'
        self.assertEqual(review_payload(data)['files'][-1], large)

    def test_cached_record_reads_are_independent_and_detect_external_replacements(self):
        original = self.session.store.read()
        with patch('manuscript_review.storage.read_json', wraps=read_json) as read:
            changed = self.session.store.read()
            changed['snapshot']['files'][0]['before'] = 'Discarded local mutation.'
            self.assertEqual(self.session.store.read(), original)
            self.assertEqual(read.call_count, 0)
        external = ReviewStore(self.directory)
        updated = external.read()
        updated['revision'] += 1
        external.commit(updated)
        self.assertEqual(self.session.store.read()['revision'], updated['revision'])

    def test_library_summaries_invalidate_after_a_note_only_save(self):
        library = Library(self.root / 'library')
        record = self.session.store.read()
        record['metadata'].update(repo=str(self.repo), created=record['snapshot']['created'])
        directory = library.reviews / record['metadata']['id']
        directory.mkdir()
        atomic_json(directory / 'review.json', record)
        with patch.object(ReviewStore, 'read', wraps=None, side_effect=lambda: copy.deepcopy(record)) as read:
            first = library.listing()
            first[0]['skipped'].append('Local caller mutation')
            second = library.listing()
            self.assertEqual(read.call_count, 1)
            self.assertNotIn('Local caller mutation', second[0]['skipped'])
        record['comments'][record['snapshot']['files'][0]['edits'][0]['id']] = 'New feedback.'
        record['revision'] += 1
        atomic_json(directory / 'review.json', record)
        self.assertEqual(library.listing()[0]['comments'], 1)

    def test_status_and_previews_do_not_rebuild_or_transfer_the_comparison(self):
        record = self.session.store.read()
        record['snapshot']['entry'] = 'main.tex'
        record['metadata']['preview_status'] = 'ready'
        self.session.store.commit(record)
        atomic_json(self.directory / 'renders/manifest.json', {
            'base': record['snapshot']['base'], 'proposed': record['snapshot']['proposed'],
            'renderer': RENDER_VERSION, 'passages': {'one': {'after': {'asset': 'after-one.svg'}}}, 'documents': {}})
        self.assertEqual(self.session.status()['revision'], record['revision'])
        with patch.object(self.session.store, 'read', side_effect=AssertionError('Unchanged status should use its summary.')):
            self.assertEqual(self.session.preview()['preview_status'], 'ready')
            self.assertEqual(self.session.preview()['passages']['one']['after']['asset'], 'after-one.svg')
        record['metadata']['preview_error'] = 'A failed excerpt.'
        record['metadata']['preview_status'] = 'error'
        self.session.store.commit(record)
        self.assertEqual(self.session.preview()['preview_status'], 'error')
        self.assertEqual(self.session.preview()['preview_error'], 'A failed excerpt.')
        record['snapshot']['proposed'] = self.base
        self.session.store.commit(record)
        self.assertEqual(self.session.preview()['passages'], {})
        self.assertEqual(self.session.preview()['preview_status'], 'queued')

    def test_batch_git_reads_keep_unusual_names_empty_files_and_skip_binary_modes(self):
        name = 'space and\ttab.tex'
        (self.repo / name).write_text('Old wording.\n')
        (self.repo / 'binary.dat').write_bytes(b'old\0bytes')
        self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / name).write_text('New wording.\n')
        (self.repo / 'binary.dat').write_bytes(b'new\0bytes')
        (self.repo / 'link.tex').symlink_to(name)
        (self.repo / 'blank.tex').touch()
        self.commit()
        snapshot = build_snapshot(self.repo, base, 'HEAD', text_only=True)
        files = {file['path']: file for file in snapshot['files']}
        self.assertEqual(files[name]['before'], 'Old wording.\n')
        self.assertEqual(files[name]['after'], 'New wording.\n')
        self.assertIsNone(files['blank.tex']['before'])
        self.assertEqual(files['blank.tex']['after'], '')
        self.assertEqual(set(snapshot['skipped']), {'binary.dat', 'link.tex'})

    def test_rendered_source_context_is_not_duplicated_in_interactive_payloads(self):
        data = self.session.view()
        data['files'][0]['hunks'][0]['rendered'] = {'after': {'asset':'source.svg', 'context':'x'*200_000}}
        payload = review_payload(data)
        self.assertEqual(payload['files'][0]['hunks'][0]['rendered'], {'after':{'asset':'source.svg'}})
        self.assertIn('context', data['files'][0]['hunks'][0]['rendered']['after'])

    def test_nested_repositories_ignored_and_temporary_folders_are_excluded_without_filetype_rules(self):
        (self.repo / 'research').mkdir()
        (self.repo / 'tmp').mkdir()
        (self.repo / 'nested').mkdir()
        (self.repo / '.scratch').mkdir()
        for name in ('research/analysis.py','research/measurements.json','tmp/scratch.txt','nested/copied.txt','.scratch/test.txt','ignored.log'):
            (self.repo / name).write_text('Project content.')
        self.commit()
        # A nested checkout boundary and ignore rules can apply even to content
        # that was mistakenly committed in the outer repository.
        (self.repo / 'nested/.git').mkdir()
        (self.repo / '.gitignore').write_text('ignored.log\n')
        snapshot = build_snapshot(self.repo, self.base, 'HEAD', text_only=True)
        paths = {file['path'] for file in snapshot['files']}
        self.assertIn('research/analysis.py', paths)
        self.assertIn('research/measurements.json', paths)
        self.assertFalse(paths & {'tmp/scratch.txt','nested/copied.txt','.scratch/test.txt','ignored.log'})
        self.assertTrue({'tmp/scratch.txt','nested/copied.txt','.scratch/test.txt','ignored.log'} <= set(snapshot['skipped']))
