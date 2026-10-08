import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPanel} from '../src/panel.mjs';
import {createBridge} from '../../manuscript_review/host.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const uri = path => ({fsPath: path, toString: () => `file://${path}`});

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'manuscript-review-panel-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const assets = join(directory, 'dist/runtime/manuscript_review'), viewer = join(directory, 'dist/viewer');
    await mkdir(assets, {recursive: true}); await mkdir(viewer, {recursive: true});
    await writeFile(join(assets, 'index.html'), '<html><head><style>body{color:black}</style></head><body><script type="module" src="/app.js"></script></body></html>');
    await writeFile(join(viewer, 'viewer.html'), '<html><body>Local PDF viewer</body></html>');
    const panels = [], writes = [], downloads = [], sources = [], clipboard = [], dialogs = [];
    let changes = 0, destination;
    const vscode = {Uri: {file: uri}, ViewColumn: {Beside: 2},
        env: {clipboard: {async writeText(text) { clipboard.push(text); }}},
        workspace: {fs: {async writeFile(uri, bytes) { writes.push({uri, bytes}); }}},
        window: {
            async showSaveDialog(options) { dialogs.push(options); return destination; },
            createWebviewPanel(type, title, column, options) {
                let receive, closed, html = '';
                const panel = {type, title, column, options, messages: [], replacements: 0,
                    reveal() { this.revealed = true; },
                    onDidDispose(listener) { closed = listener; },
                    dispose() { if (!this.disposed) { this.disposed = true; closed(); } },
                    receive(message) { return receive(message); },
                    webview: {
                        cspSource: 'https://resources.invalid',
                        asWebviewUri(uri) { return {toString: () => `https://resources.invalid/${encodeURIComponent(uri.fsPath)}`}; },
                        onDidReceiveMessage(listener) { receive = listener; },
                        postMessage(message) { panel.messages.push(message); return Promise.resolve(!panel.disposed); },
                        set html(value) { html = value; panel.replacements++; }, get html() { return html; },
                    }};
                panels.push(panel); return panel;
            },
        }};
    const runtime = {review: {repo: join(directory, 'manuscript'), revision: 1, token: 'private-review-token'},
        async request() { return {revision: this.review.revision}; },
        async asset() { return {bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml;charset=utf-8'}; },
        async download(path) { downloads.push(path); return {bytes: Buffer.from('Exact export 🧬.\n')}; }};
    const panel = createPanel(vscode, {extensionPath: directory}, runtime, {
        onSource: message => { sources.push(message); }, onChange: () => changes++,
    });
    t.after(() => panel.dispose());
    return {panel, runtime, panels, assets, viewer, writes, downloads, sources, clipboard, dialogs,
        destination: value => { destination = value; }, changes: () => changes,
        async open(entry) { await panel.show(entry); const current = panels.at(-1); await current.receive({type: 'review-ready'}); return current; },
        async establish(current, revision = 1) {
            runtime.review.revision = revision;
            await current.receive({type: 'review-request', id: 'initial', action: 'request', path: '/data?scope=round'});
            current.messages.length = 0;
        }};
}

test('selection waits for readiness and only bundled client and viewer files are exposed', async t => {
    const f = await fixture(t), entry = {file: 'main.tex', target: {id: 'edit-1'}};
    await f.panel.show(entry); const p = f.panels[0];
    assert.deepEqual(p.messages, []);
    assert.deepEqual(p.options.localResourceRoots.map(root => root.fsPath), [f.assets, f.viewer]);
    const csp = p.webview.html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src https:\/\/resources.invalid;/);
    assert.match(csp, /frame-src https:\/\/resources.invalid;/);
    assert.doesNotMatch(csp.replaceAll('https://resources.invalid', ''), /unsafe-eval|script-src[^;]*unsafe-inline|https?:|localhost|127\.0\.0\.1/);
    assert.doesNotMatch(p.webview.html, /private-review-token/);
    assert.match(p.webview.html, /body class="vscode-review wide"/);
    assert.match(p.webview.html, new RegExp(encodeURIComponent(join(f.assets, 'app.js'))));
    await p.receive({type: 'review-ready'});
    assert.deepEqual(p.messages, [{type: 'review-select', file: 'main.tex', target: 'edit-1'}]);
    p.messages.length = 0;
    await p.receive({type: 'review-request', id: 'viewer', action: 'viewer', path: '/etc/passwd'});
    assert.deepEqual(p.messages[0], {type: 'review-response', id: 'viewer', ok: true,
        data: `https://resources.invalid/${encodeURIComponent(join(f.viewer, 'viewer.html'))}`});
});

test('flush waits for readiness and an exact acknowledgement before refresh replaces the page', async t => {
    const f = await fixture(t); await f.panel.show(); const p = f.panels[0];
    const refresh = f.panel.refresh(); assert.equal(p.replacements, 1); assert.deepEqual(p.messages, []);
    await p.receive({type: 'review-ready'}); await Promise.resolve();
    const command = p.messages.find(message => message.type === 'review-command');
    assert.equal(command.action, 'flush');
    await p.receive({type: 'review-flushed', id: 'wrong', ok: true});
    assert.equal(p.replacements, 1);
    await p.receive({type: 'review-flushed', id: command.id, ok: true}); await refresh;
    assert.equal(p.replacements, 2); await p.receive({type: 'review-ready'});
});

test('a second target requested before readiness replaces the pending selection', async t => {
    const f = await fixture(t);
    await f.panel.show({file: 'first.tex', target: {id: 'first'}}); const p = f.panels[0];
    const showing = f.panel.show({file: 'second.tex', target: {id: 'second'}});
    assert.deepEqual(p.messages, []);
    await p.receive({type: 'review-ready'}); await showing;
    assert.deepEqual(p.messages, [{type: 'review-select', file: 'second.tex', target: 'second'}]);
    assert.equal(p.replacements, 1);
});

test('an unready page times out without sending a save command or replacing its contents', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = await fixture(t); await f.panel.show(); const p = f.panels[0];
    const flushing = f.panel.flush(), failed = assert.rejects(flushing, /did not load/);
    t.mock.timers.tick(30_000); await failed;
    assert.deepEqual(p.messages, []); assert.equal(p.replacements, 1);
});

test('failed flush, readiness errors, and timeouts preserve the existing page', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = await fixture(t), p = await f.open();
    const refresh = f.panel.refresh(), failed = assert.rejects(refresh, /Keep my unsaved comment/);
    await Promise.resolve();
    const command = p.messages.at(-1);
    await p.receive({type: 'review-flushed', id: command.id, ok: false, error: 'Keep my unsaved comment'});
    await failed; assert.equal(p.replacements, 1);
    const missing = f.panel.flush(), timedOut = assert.rejects(missing, /did not finish saving/);
    await Promise.resolve(); t.mock.timers.tick(30_000); await timedOut;
    assert.equal(p.replacements, 1);
    p.dispose(); await f.panel.show(); const next = f.panels.at(-1);
    const loading = f.panel.flush(), loadingFailed = assert.rejects(loading, /Source could not load/);
    await next.receive({type: 'review-ready', error: 'Source could not load'}); await loadingFailed;
    assert.equal(next.replacements, 1);
    assert.equal(next.messages.some(message => message.type === 'review-command'), false);
});

test('closing a panel rejects its outstanding save and ignores its delayed messages', async t => {
    const f = await fixture(t), p = await f.open();
    const saving = f.panel.flush(), closed = assert.rejects(saving, /focused review closed/);
    await Promise.resolve(); const command = p.messages.at(-1); p.dispose(); await closed;
    const next = await f.open();
    await p.receive({type: 'review-flushed', id: command.id, ok: true});
    await p.receive({type: 'review-request', id: 'closed-write', action: 'copy', text: 'Old panel'});
    assert.deepEqual(next.messages, []); assert.deepEqual(f.clipboard, []);
});

test('a delayed response from a closed panel cannot post into its replacement', async t => {
    const f = await fixture(t), p = await f.open(), asset = deferred();
    f.runtime.asset = () => asset.promise;
    const response = p.receive({type: 'review-request', id: 'old-asset', action: 'asset', path: '/assets/page.svg'});
    p.dispose(); const next = await f.open();
    asset.resolve({bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml'}); await response;
    assert.deepEqual(next.messages, []); assert.deepEqual(p.messages, []);
});

test('an old pending write cannot deliver its queued watcher invalidation into a new panel', async t => {
    const f = await fixture(t), p = await f.open(); await f.establish(p);
    const write = deferred(); f.runtime.request = () => write.promise;
    const response = p.receive({type: 'review-request', id: 'old-save', action: 'request', path: '/save', body: {revision: 1}});
    f.panel.changed(3); p.dispose(); await f.panel.show(); const next = f.panels.at(-1);
    write.resolve({revision: 2}); await response;
    assert.deepEqual(next.messages, []);
    await next.receive({type: 'review-ready'});
});

test('an own write acknowledgement suppresses its watcher event while an external change invalidates the panel', async t => {
    const f = await fixture(t), p = await f.open(); await f.establish(p);
    const write = deferred(); f.runtime.request = () => write.promise;
    const response = p.receive({type: 'review-request', id: 'save', action: 'request', path: '/save', body: {revision: 1, comments: {edit: 'My latest words'}}});
    f.panel.changed(2); assert.deepEqual(p.messages, []);
    write.resolve({revision: 2}); await response;
    assert.equal(f.changes(), 1); assert.equal(p.messages.some(message => message.type === 'review-changed'), false);
    assert.deepEqual(p.messages[0].data, {status: 200, data: {revision: 2}});
    f.panel.changed(3); assert.equal(p.messages.at(-1).type, 'review-changed');
});

test('out-of-order watcher events cannot hide a newer external revision during an own write', async t => {
    const f = await fixture(t), p = await f.open(); await f.establish(p, 5);
    const write = deferred(); f.runtime.request = () => write.promise;
    const response = p.receive({type: 'review-request', id: 'save', action: 'request', path: '/save', body: {revision: 5}});
    f.panel.changed(7); f.panel.changed(6);
    write.resolve({revision: 6}); await response;
    assert.equal(p.messages.filter(message => message.type === 'review-changed').length, 1);
});

test('an external revision during the initial data request remains queued until the page is ready', async t => {
    const f = await fixture(t); await f.panel.show(); const p = f.panels[0], loading = deferred();
    f.runtime.request = () => loading.promise;
    const response = p.receive({type: 'review-request', id: 'initial', action: 'request', path: '/data?scope=round'});
    f.panel.changed(2); loading.resolve({revision: 1}); await response;
    assert.equal(p.messages.some(message => message.type === 'review-changed'), false);
    await p.receive({type: 'review-ready'});
    assert.equal(p.messages.filter(message => message.type === 'review-changed').length, 1);
});

test('a delayed watcher notification for an older acknowledged revision does not mark the panel stale', async t => {
    const f = await fixture(t), p = await f.open(); await f.establish(p, 7);
    f.panel.changed(6); assert.deepEqual(p.messages, []);
});

test('a flush queued for a closed panel never sends a command to a new unready panel', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = await fixture(t), p = await f.open();
    const flushing = f.panel.flush().then(() => null, error => error);
    p.dispose(); const next = await f.open();
    t.mock.timers.tick(30_000); const error = await flushing;
    assert.equal(next.messages.some(message => message.type === 'review-command'), false);
    assert.match(error?.message || '', /focused review closed/);
});

test('cancelled exports write nothing and accepted exports preserve exact bytes', async t => {
    const f = await fixture(t), p = await f.open();
    await p.receive({type: 'review-request', id: 'cancel', action: 'export', path: '/feedback.json'});
    assert.deepEqual(f.writes, []); assert.deepEqual(f.downloads, ['/feedback.json']);
    assert.equal(f.dialogs[0].defaultUri.fsPath, join(f.runtime.review.repo, 'manuscript-feedback.json'));
    f.destination(uri(join(f.runtime.review.repo, 'chosen.patch')));
    await p.receive({type: 'review-request', id: 'export', action: 'export', path: '/selected.patch?scope=round'});
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].bytes.toString(), 'Exact export 🧬.\n');
    assert.equal(f.dialogs[1].defaultUri.fsPath, join(f.runtime.review.repo, 'manuscript-selected.patch'));
    assert.equal(p.messages.every(message => !JSON.stringify(message).includes('private-review-token')), true);
});

test('PDF iframe messages cannot impersonate responses from the extension host', async () => {
    let receive; const messages = [];
    const bridge = createBridge({postMessage: message => messages.push(message)}, handler => { receive = handler; });
    const request = bridge('asset', {path: '/assets/page.pdf'});
    receive({source: {iframe: true}, data: {type: 'review-response', id: messages[0].id, ok: true, data: 'Forged'}});
    receive({source: null, data: {type: 'review-response', id: messages[0].id, ok: true, data: 'Trusted'}});
    assert.equal(await request, 'Trusted');
});
