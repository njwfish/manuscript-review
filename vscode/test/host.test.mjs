import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridge} from '../../manuscript_review/host.js';

let moduleNumber = 0;

async function host(t, embedded = false) {
    const messages = [], listeners = new Map();
    let state;
    const api = {
        postMessage: message => messages.push(message),
        setState: value => { state = value; },
        getState: () => state,
    };
    const globals = {
        acquireVsCodeApi: embedded ? () => api : undefined,
        addEventListener: (name, listener) => {
            const entries = listeners.get(name) || [];
            entries.push(listener); listeners.set(name, entries);
        },
        location: {origin: 'https://host.invalid'},
    };
    for (const [name, value] of Object.entries(globals)) {
        const original = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
        t.after(() => {
            if (original) Object.defineProperty(globalThis, name, original);
            else delete globalThis[name];
        });
    }
    const module = await import(new URL(`../../manuscript_review/host.js?test=${++moduleNumber}`, import.meta.url));
    const emit = (name, event) => Promise.all((listeners.get(name)||[]).map(listener => listener(event)));
    return {module, messages, api, emit, state: () => state,
        reply: (message, data, ok = true) => emit('message', {
            data: {type: 'review-response', id: message.id, ok, ...(ok ? {data} : {error: data})},
        })};
}

test('bridge pairs out-of-order responses and ignores unrelated and duplicate messages', async () => {
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; });
    const first = call('request', {path: '/data?scope=round'});
    const second = call('asset', {path: '/assets/page.svg'});
    assert.notEqual(messages[0].id, messages[1].id);
    assert.equal(messages[0].action, 'request'); assert.equal(messages[1].action, 'asset');
    receive({data: {type: 'review-response', id: 'unknown', ok: true, data: 'Ignored'}});
    receive({data: {type: 'review-changed', id: messages[0].id, ok: true, data: 'Ignored'}});
    receive({data: {type: 'review-response', id: messages[1].id, ok: true, data: '<svg/>'}});
    receive({data: {type: 'review-response', id: messages[1].id, ok: false, error: 'Duplicate'}});
    assert.equal(await second, '<svg/>');
    receive({data: {type: 'review-response', id: messages[0].id, ok: true, data: {revision: 4}}});
    assert.deepEqual(await first, {revision: 4});
});

test('bridge reports host errors without affecting another pending request', async () => {
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; });
    const failed = call('source', {file: 'missing.tex'});
    const failedCheck = assert.rejects(failed, /Missing source file/);
    const healthy = call('copy', {text: 'Exact 🧬 text'});
    receive({data: {type: 'review-response', id: messages[0].id, ok: false, error: 'Missing source file'}});
    receive({data: {type: 'review-response', id: messages[1].id, ok: true}});
    await failedCheck; assert.equal(await healthy, undefined);
    const unspecified = call('request');
    const unspecifiedCheck = assert.rejects(unspecified, /could not complete this action/);
    receive({data: {type: 'review-response', id: messages[2].id, ok: false}});
    await unspecifiedCheck;
});

test('bridge times out an unanswered request and accepts subsequent replies', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; });
    const missing = call('request', {path: '/data'});
    const check = assert.rejects(missing, /did not respond/);
    t.mock.timers.tick(30_000); await check;
    receive({data: {type: 'review-response', id: messages[0].id, ok: true, data: 'Too late'}});
    const next = call('request', {path: '/data'});
    receive({data: {type: 'review-response', id: messages[1].id, ok: true, data: 'Current'}});
    assert.equal(await next, 'Current');
    t.mock.timers.tick(30_000);
});

test('webview navigation state stays private and replaces the standalone saved position', async t => {
    const h = await host(t, true);
    const ui = {scope: 'round', positions: {round: {active: 2, passage: 3}}};
    const saved = await h.module.request('/ui', {method: 'POST', body: JSON.stringify({ui})});
    assert.equal(saved.ok, true); assert.deepEqual(h.state(), ui);
    assert.equal(h.messages.length, 0, 'navigation must not reach the service or saved record');
    const pending = h.module.request('/data?scope=round');
    const request = h.messages.at(-1);
    assert.equal(request.path, '/data?scope=round');
    h.reply(request, {status: 200, data: {revision: 8, ui: {scope: 'manuscript'}}});
    const result = await pending;
    assert.equal(result.ok, true); assert.deepEqual((await result.json()).ui, ui);
    h.api.setState(undefined);
    const fresh = h.module.request('/data?scope=baseline');
    h.reply(h.messages.at(-1), {status: 200, data: {ui: {active: 10}}});
    assert.deepEqual((await (await fresh).json()).ui, {});
});

test('webview requests preserve explicit revisions and HTTP error responses', async t => {
    const h = await host(t, true);
    const body = {revision: 7, comment: 'Keep α😀 wording.', file: 'main.tex'};
    const pending = h.module.request('/note', {method: 'POST', body: JSON.stringify(body)});
    assert.deepEqual(h.messages.at(-1).body, body);
    h.reply(h.messages.at(-1), {status: 409, data: {error: 'Review changed.', stale: true}});
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), {error: 'Review changed.', stale: true});
    const changed = h.module.request('/data?scope=round');
    h.reply(h.messages.at(-1), {status: 409, data: {error: 'Conflict'}});
    assert.deepEqual(await (await changed).json(), {error: 'Conflict'});
});

test('webview assets respect disconnected images and retain an error description', async t => {
    const h = await host(t, true);
    const image = {isConnected: true, src: 'Previous'};
    const pending = h.module.imageSource(image, '/assets/page.svg');
    assert.equal(h.messages.at(-1).action, 'asset');
    h.reply(h.messages.at(-1), 'data:image/svg+xml;base64,PHN2Zy8+');
    await pending; assert.equal(image.src, 'data:image/svg+xml;base64,PHN2Zy8+');
    const removed = {isConnected: true, src: 'Previous'};
    const late = h.module.imageSource(removed, '/assets/other.svg');
    removed.isConnected = false;
    h.reply(h.messages.at(-1), 'data:image/svg+xml;base64,TGF0ZQ==');
    await late; assert.equal(removed.src, 'Previous');
    const failure = h.module.imageSource(image, '/assets/missing.svg');
    h.reply(h.messages.at(-1), 'Preview not found', false);
    await failure; assert.equal(image.alt, 'Preview not found');
});

test('webview source, clipboard, export, and flush messages use the existing bridge', async t => {
    const h = await host(t, true);
    for (const [action, values, operation] of [
        ['source', {file: 'main.tex', position: 12}, () => h.module.openSource({file: 'main.tex', position: 12})],
        ['copy', {text: 'Exact α😀 words'}, () => h.module.copyText('Exact α😀 words')],
        ['export', {path: '/feedback.json'}, () => h.module.exportFile('/feedback.json')],
    ]) {
        const pending = operation();
        const message = h.messages.at(-1);
        assert.deepEqual(message, {type: 'review-request', id: message.id, action, ...values});
        h.reply(message, 'Complete'); assert.equal(await pending, 'Complete');
    }
    h.emit('review-flushed', {detail: {id: 'flush-1', ok: false, error: 'Unsaved comment'}});
    assert.deepEqual(h.messages.at(-1), {type: 'review-flushed', id: 'flush-1', ok: false, error: 'Unsaved comment'});
});

test('standalone transport, saved navigation, and image URLs stay unchanged', async t => {
    const h = await host(t);
    const calls = [], response = {ok: true, json: async () => ({ui: {scope: 'manuscript'}})};
    t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return response; });
    const options = {method: 'POST', headers: {'X-Review-Token': 'local-token'}, body: JSON.stringify({ui: {active: 3}})};
    assert.equal(await h.module.request('/ui', options), response);
    assert.equal(await h.module.request('/data?scope=round'), response);
    assert.deepEqual(calls, [['/ui', options], ['/data?scope=round', {}]]);
    assert.deepEqual(await response.json(), {ui: {scope: 'manuscript'}});
    const image = {};
    await h.module.imageSource(image, '/assets/page.svg');
    assert.equal(image.src, '/assets/page.svg'); assert.equal(h.messages.length, 0);
});

test('PDF frames receive immutable bytes only after their own authenticated readiness message', async t => {
    const h = await host(t, true), packets = [];
    const frame = {isConnected: true, src: '', contentWindow: {postMessage: (...args) => packets.push(args)}};
    const marks = [{page: 2, bounds: [0.1, 0.2, 0.3, 0.4]}, {page: 3, bounds: null}];
    const setup = h.module.pdfFrame(frame, {path: '/assets/source.pdf', marks, color: 'added'});
    h.reply(h.messages.at(-1), 'https://assets.invalid/viewer.html'); await setup;
    assert.equal(new URL(frame.src).searchParams.get('parentOrigin'), 'https://host.invalid');
    const count = h.messages.length;
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: {}, origin: 'https://assets.invalid'});
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'https://other.invalid'});
    assert.equal(h.messages.length, count);
    const loading = h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'https://assets.invalid'});
    assert.equal(h.messages.at(-1).path, '/assets/source.pdf');
    h.reply(h.messages.at(-1), 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4').toString('base64'));
    await loading;
    assert.deepEqual(packets[0], [{type: 'review-pdf', document: '/assets/source.pdf', data: Uint8Array.from(Buffer.from('%PDF-1.4')), marks, color: 'added', active: true}, 'https://assets.invalid']);
    frame.isConnected = false;
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'https://assets.invalid'});
    assert.equal(packets.length, 1);
});
