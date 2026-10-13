"""Typeset immutable proposal versions; publish only the current generation."""
import threading
import hashlib
import json
from .storage import FileLock, atomic_json, read_json

PREVIEW_SCOPES = {
    'round': ('renders', 'preview_status', 'preview_error'),
    'baseline': ('baseline-renders', 'baseline_preview_status', 'baseline_preview_error'),
    'selected': ('selected-renders', 'selected_preview_status', 'selected_preview_error'),
}
PREVIEW_VERSIONS = {
    'round': {'base': 'base', 'proposed': 'proposed'},
    'baseline': {'base': 'baseline', 'proposed': 'result'},
    'selected': {'base': 'base', 'proposed': 'result', 'proposal': 'proposed', 'entry': 'entry'},
}


def preview_versions(state, scope):
    return {key: state[value] for key, value in PREVIEW_VERSIONS[scope].items()}


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
        from .render_latex import render, render_document, RENDER_VERSION
        store = self.session.store
        with self.lock:
            with store.transaction():
                record = store.read()
                snapshot = self.session.comparison(record, scope)
                if not snapshot['entry']:
                    return
                folder, status_key, error_key = PREVIEW_SCOPES[scope]
                output = store.directory / folder
                manifest = read_json(output / 'manifest.json', {})
                generation = preview_versions({**record['snapshot'], 'baseline': record['baseline'], 'result': record['result']}, scope)
                identity = {**generation, 'renderer': RENDER_VERSION}
                if all(manifest.get(key) == value for key, value in identity.items()):
                    if record['metadata'].get(status_key) in ('queued', 'rendering'):
                        record['metadata'][status_key] = 'ready'
                        store.patch({'metadata': record['metadata']})
                    return
                record['metadata'][status_key] = 'rendering'
                store.patch({'metadata': record['metadata']})
            try:
                key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:40]
                cache = store.directory / 'preview-cache' / (scope + '-' + key)
                cache.mkdir(parents=True, exist_ok=True)
                renderer = {'round': render, 'baseline': render, 'selected': render_document}[scope]
                renderer(cache, data_override=snapshot, source_cache=store.directory / 'preview-cache/sources')
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
                record = store.read(lambda record: {key: record[key] for key in ('metadata', 'baseline', 'result')}
                                    | {'snapshot': {key: record['snapshot'][key] for key in ('base', 'proposed', 'entry')}})
                current = preview_versions({**record['snapshot'], 'baseline': record['baseline'], 'result': record['result']}, scope)
                if current == generation:
                    atomic_json(output / 'manifest.json', {**identity, **rendered})
                    record['metadata'].update({status_key: result, error_key: error})
                    store.patch({'metadata': record['metadata']})
