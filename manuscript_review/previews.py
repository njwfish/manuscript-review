"""Typeset immutable proposal versions; publish only the current generation."""
import threading
from .storage import FileLock, atomic_json, read_json


def preview_assets(passages):
    """Keep display assets and diagnostics, without duplicating manuscript source."""
    return {key: {side: {name: value for name, value in entry.items() if name != 'context'}
                  for side, entry in passage.items()} for key, passage in passages.items()}


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
        from .render_latex import render, RENDER_VERSION
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
                if (manifest.get('base'), manifest.get('proposed'), manifest.get('renderer')) == (snapshot['base'], snapshot['proposed'], RENDER_VERSION):
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
                render(cache, data_override=snapshot, source_cache=store.directory / 'preview-cache/sources')
                rendered = read_json(cache / 'renders/manifest.json')
                output.mkdir(exist_ok=True)
                for asset in (cache / 'renders').iterdir():
                    if asset.suffix in ('.svg', '.pdf'):
                        (output / asset.name).write_bytes(asset.read_bytes())
                failures = [document[key] for document in rendered.get('documents', {}).values()
                            for key in ('error', 'excerpt_error') if document.get(key)]
                available = any(document.get('pages') for document in rendered.get('documents', {}).values()) or any(
                    side.get('asset') for passage in rendered.get('passages', {}).values() for side in passage.values())
                result, error = ('error' if failures and not available else 'ready'), '\n'.join(failures) or None
            except Exception as failure:
                result, error = 'error', str(failure)
                rendered = {}
            with store.transaction():
                record = store.read()
                current = ((record['snapshot']['base'], record['snapshot']['proposed']) if scope == 'round'
                           else (record['baseline'], record['result']))
                if current == generation:
                    atomic_json(output / 'manifest.json', {'base': generation[0], 'proposed': generation[1], 'renderer': RENDER_VERSION, **rendered})
                    record['metadata'].update({status_key: result, error_key: error})
                    store.commit(record)
