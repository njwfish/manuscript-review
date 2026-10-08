import json
import threading
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.storage import atomic_json


class PreviewTests(ReviewFixture):
    def test_edit_during_render_drains_the_latest_generation(self):
        r = self.session.store.read()
        r['snapshot']['entry'] = 'main.tex'
        r['metadata']['preview_status'] = 'queued'
        self.session.store.commit(r)
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def render(directory, data_override):
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
            self.session.update('passage', self.request(passage_id=h['id'], text='We score chosen cells.'))
            proposed = self.session.snapshot['proposed']
            release.set()
            self.assertTrue(finished.wait(5))
            # Acquire the worker's publish lock after its renderer returns.
            with self.session.previews.lock:
                manifest = json.loads((self.directory / 'renders/manifest.json').read_text())
            self.assertEqual(calls, [r['snapshot']['proposed'], proposed])
            self.assertEqual(manifest['proposed'], proposed)
            self.assertEqual(self.session.store.read()['metadata']['preview_status'], 'ready')
