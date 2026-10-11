import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.storage import ReviewStore, atomic_json, atomic_chunks
from manuscript_review.comparison import git, read_blob


class StateWriteTests(ReviewFixture):
    def test_commit_publishes_its_cache_before_a_concurrent_state_save_can_continue(self):
        store = self.session.store
        record = store.read()
        record['snapshot']['entry'] = 'main.tex'
        replaced, release, entered = threading.Event(), threading.Event(), threading.Event()
        write = store._write_record
        def waiting(path, value):
            result = write(path, value)
            if threading.current_thread().name == 'source-commit':
                replaced.set()
                if not release.wait(5):
                    raise RuntimeError('The test did not release cache publication.')
            return result
        def commit():
            threading.current_thread().name = 'source-commit'
            store.commit(record)
        def state():
            entered.set()
            store.patch({'ui': {'file': 'main.tex'}})
        with patch.object(store, '_write_record', side_effect=waiting), ThreadPoolExecutor(max_workers=2) as executor:
            committed = executor.submit(commit)
            self.assertTrue(replaced.wait(5))
            saved = executor.submit(state)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaises(TimeoutError):
                    saved.result(0.05)
            finally:
                release.set()
            committed.result(5)
            saved.result(5)
        expected = {**record, 'ui': {'file': 'main.tex'}}
        self.assertEqual(store.read(), expected)
        self.assertEqual(json.loads(store.path.read_text()), expected)

    def test_state_updates_reuse_source_bytes_and_preserve_every_other_field(self):
        before = self.session.store.read()
        ui = {'file': 'main.tex', 'edit': 'selection'}
        self.session.store.patch({'ui': ui})
        encoded = self.session.store.snapshot_json
        ui['file'] = 'Caller mutation'
        self.session.store.patch({'revision': before['revision'] + 1})
        self.assertIs(self.session.store.snapshot_json, encoded)
        current = self.session.store.read()
        self.assertEqual(current, {**before, 'revision': before['revision'] + 1,
                                   'ui': {'file': 'main.tex', 'edit': 'selection'}})
        self.assertEqual(json.loads(self.session.store.path.read_text()), current)
        self.assertEqual(ReviewStore(self.directory).read(), current)
        for fields in ({'snapshot': before['snapshot']}, {'schema': 6}, {'extra': 'value'}):
            with self.assertRaises(ValueError):
                self.session.store.patch(fields)
        self.assertEqual(self.session.store.read(), current)

    def test_external_record_replacement_invalidates_serialized_source_and_retains_new_state(self):
        self.session.store.patch({'ui': {'file': 'main.tex'}})
        current = self.session.store.read()
        current['snapshot']['entry'] = 'main.tex'
        current['metadata']['preview_error'] = 'An external update'
        current['revision'] += 1
        atomic_json(self.session.store.path, current)
        self.session.store.patch({'ui': {'file': 'empty.txt'}})
        self.assertEqual(ReviewStore(self.directory).read(), {**current, 'ui': {'file': 'empty.txt'}})
        archived = self.session.store.read()
        self.session.store.archive(archived)
        self.assertEqual(json.loads((self.directory / 'versions' / f'{current["revision"]:08d}.json').read_text()), archived)

    def test_failed_streamed_write_retains_record_cache_and_durable_contents(self):
        self.session.store.patch({'ui': {'file': 'main.tex'}})
        before = self.session.store.read()
        durable = self.session.store.path.read_bytes()
        encoded = self.session.store.snapshot_json
        def interrupted(path, chunks):
            def fail():
                yield next(iter(chunks))
                raise OSError('Interrupted record write')
            atomic_chunks(path, fail())
        with patch('manuscript_review.storage.atomic_chunks', side_effect=interrupted):
            with self.assertRaises(OSError):
                self.session.store.patch({'revision': before['revision'] + 1})
        self.assertEqual(self.session.store.path.read_bytes(), durable)
        self.assertEqual(self.session.store.read(), before)
        self.assertIs(self.session.store.snapshot_json, encoded)
        self.assertEqual(list(self.directory.glob('.review.json-*')), [])

    def test_unchanged_note_reuses_selected_commit_and_dirty_note_captures_exact_source(self):
        source = self.session.editor('main.tex')
        before = self.session.store.read()
        def save(text):
            return self.session.save_note({'revision': self.session.status()['revision'],
                'file': 'main.tex', 'source': source['source'], 'text': text,
                'start': 3, 'end': 8, 'comment': 'Keep these words.'})['entry']
        with patch('manuscript_review.session.source_version', side_effect=AssertionError('No new checkpoint needed.')):
            unchanged = save(source['text'])
        self.assertEqual(unchanged['anchor']['revision'], source['source'])
        reference = f'refs/manuscript-review/{before["metadata"]["id"]}/notes/{source["source"]}'
        self.assertEqual(git(self.repo, 'rev-parse', reference).decode().strip(), source['source'])
        dirty = 'An unsaved prefix.\n' + source['text']
        changed = save(dirty)
        with patch('manuscript_review.session.source_version', side_effect=AssertionError('This exact buffer is already pinned.')):
            repeated = save(dirty)
        self.assertEqual(repeated['anchor']['revision'], changed['anchor']['revision'])
        self.assertNotEqual(changed['anchor']['revision'], source['source'])
        self.assertEqual(read_blob(self.repo, changed['anchor']['revision'], 'main.tex'), dirty)
        self.assertEqual((self.repo / 'main.tex').read_text(), source['text'])
        current = ReviewStore(self.directory).read()
        self.assertEqual(current['snapshot'], before['snapshot'])
        for key in ('decisions', 'comments', 'drafts', 'resolved', 'baseline', 'result'):
            self.assertEqual(current[key], before[key])

    def test_warmed_unchanged_file_is_shared_with_comment_capture(self):
        self.session.update('save', self.request(decisions={}))
        source = self.session.editor('empty.txt')
        with patch('manuscript_review.session.document_file', side_effect=AssertionError('Already read this immutable file.')):
            self.session.save_note({'revision': source['revision'], 'file': 'empty.txt',
                'text': source['text'], 'source': source['source'], 'start': 0, 'end': 0,
                'comment': 'Keep this empty file.'})
