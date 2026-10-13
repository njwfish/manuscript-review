import json
import threading
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.storage import atomic_json


class PreviewTests(ReviewFixture):
    render_previews = True

    def test_edit_during_render_drains_the_latest_generation(self):
        r = self.session.store.read()
        r['snapshot']['entry'] = 'main.tex'
        r['metadata']['preview_status'] = 'queued'
        self.session.store.commit(r)
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def render(directory, data_override, source_cache):
            calls.append(data_override['proposed'])
            if len(calls) == 1:
                started.set()
                if not release.wait(5):
                    raise RuntimeError('The test did not release rendering.')
            atomic_json(directory / 'renders/manifest.json', {})
            if len(calls) == 2:
                finished.set()
        with patch('manuscript_review.render_latex.render', side_effect=render):
            self.session.previews.queue()
            self.assertTrue(started.wait(5))
            h = self.file()['hunks'][0]
            self.session.update('file', self.file_request(passage_id=h['id'], text='We score chosen cells.'))
            proposed = self.session.snapshot['proposed']
            release.set()
            self.assertTrue(finished.wait(5))
            # Acquire the worker's publish lock after its renderer returns.
            with self.session.previews.lock:
                manifest = json.loads((self.directory / 'renders/manifest.json').read_text())
            self.assertEqual(calls, [r['snapshot']['proposed'], proposed])
            self.assertEqual(manifest['proposed'], proposed)
            self.assertEqual(self.session.store.read()['metadata']['preview_status'], 'ready')

    def test_selected_generation_keeps_edit_ids_when_result_equals_base_and_invalidates_new_entry(self):
        r = self.session.store.read()
        r['snapshot']['entry'] = 'main.tex'
        self.session.store.commit(r)
        ids = [edit['id'] for file in r['snapshot']['files'] for edit in file['edits']]
        with patch.object(self.session.previews, 'queue'):
            self.session.update('save', self.request(decisions=dict.fromkeys(ids, 'reject')))
        r = self.session.store.read()
        from manuscript_review.comparison import read_blob
        self.assertEqual(read_blob(self.repo, r['result'], 'main.tex'), self.base_text)
        def render(directory, data_override, source_cache):
            self.assertEqual(data_override['proposed'], r['result'])
            self.assertEqual([edit['id'] for file in data_override['files'] for edit in file['edits']], ids)
            self.assertEqual(next(file for file in data_override['files'] if file['path'] == 'main.tex')['after'], self.base_text)
            atomic_json(directory / 'renders/manifest.json', {'documents': {'after': {'pdf': 'after.pdf', 'pages': [{}]}}})
        with patch('manuscript_review.render_latex.render_document', side_effect=render):
            self.session.previews.render('selected')
        preview = self.session.preview('selected')
        self.assertEqual(preview['preview_status'], 'ready')
        self.assertEqual(preview['proposal'], r['snapshot']['proposed'])
        self.assertEqual(preview['entry'], 'main.tex')
        r = self.session.store.read()
        r['snapshot']['entry'] = 'other.tex'
        self.session.store.commit(r)
        self.assertEqual(self.session.preview('selected')['documents'], {})
        self.assertEqual(self.session.preview('selected')['preview_status'], 'queued')

    def test_selected_render_never_publishes_stale_result(self):
        r = self.session.store.read()
        r['snapshot']['entry'] = 'main.tex'
        self.session.store.commit(r)
        def render(directory, data_override, source_cache):
            with patch.object(self.session.previews, 'queue'):
                self.session.update('save', self.request(decisions={self.file()['edits'][0]['id']: 'reject'}))
            atomic_json(directory / 'renders/manifest.json', {'documents': {'after': {'pdf': 'stale.pdf'}}})
        with patch('manuscript_review.render_latex.render_document', side_effect=render):
            self.session.previews.render('selected')
        self.assertFalse((self.directory / 'selected-renders/manifest.json').exists())
        self.assertEqual(self.session.preview('selected')['documents'], {})
