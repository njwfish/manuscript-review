"""Typeset immutable proposal versions; publish only the current generation."""
import threading
from .storage import FileLock, atomic_json, read_json


class Previews:
    def __init__(self, session):
        self.session = session
        self.lock = FileLock(session.directory / '.preview.lock')
        self.worker_lock = threading.Lock()
        self.pending = {}

    def queue(self, scope='round'):
        with self.worker_lock:
            if scope in self.pending:
                self.pending[scope] = True
                return
            self.pending[scope] = False
        def work():
            while True:
                with self.worker_lock:
                    self.pending[scope] = False
                try:
                    self.render(scope)
                except Exception:
                    with self.worker_lock:
                        del self.pending[scope]
                    raise
                with self.worker_lock:
                    if not self.pending[scope]:
                        del self.pending[scope]
                        return
        threading.Thread(target=work, daemon=True).start()

    def render(self, scope='round'):
        from .render_latex import render
        store = self.session.store
        with self.lock:
            with store.transaction():
                record = store.read()
                snapshot = self.session.comparison(record, scope)
                if not snapshot['entry']:
                    return
                output = store.directory / ('renders' if scope == 'round' else 'baseline-renders')
                manifest = read_json(output / 'manifest.json', {})
                status_key = 'preview_status' if scope == 'round' else 'baseline_preview_status'
                error_key = 'preview_error' if scope == 'round' else 'baseline_preview_error'
                if manifest.get('base') == snapshot['base'] and manifest.get('proposed') == snapshot['proposed']:
                    if record['metadata'].get(status_key) in ('queued', 'rendering'):
                        record['metadata'][status_key] = 'ready'
                        store.commit(record)
                    return
                generation = (snapshot['base'], snapshot['proposed'])
                record['metadata'][status_key] = 'rendering'
                store.commit(record)
            try:
                cache = store.directory / 'preview-cache' / '-'.join(generation)
                cache.mkdir(parents=True, exist_ok=True)
                render(cache, data_override=snapshot)
                passages = read_json(cache / 'renders/manifest.json')
                output.mkdir(exist_ok=True)
                for asset in (cache / 'renders').glob('*.svg'):
                    (output / asset.name).write_bytes(asset.read_bytes())
                result, error = 'ready', None
            except Exception as failure:
                result, error = 'error', str(failure)
                passages = {}
            with store.transaction():
                record = store.read()
                current = ((record['snapshot']['base'], record['snapshot']['proposed']) if scope == 'round'
                           else (record['baseline'], record['result']))
                if current == generation:
                    atomic_json(output / 'manifest.json', {'base': generation[0], 'proposed': generation[1], 'passages': passages})
                    record['metadata'].update({status_key: result, error_key: error})
                    store.commit(record)
