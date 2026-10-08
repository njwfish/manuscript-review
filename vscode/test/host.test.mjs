import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridge} from '../../manuscript_review/host.js';

let moduleNumber = 0;

async function host(t, embedded = false) {
    const messages = [], listeners = new Map(), keys=[];
    const body=new EventTarget();body.matches=()=>false;
    body.addEventListener('keydown',event=>{assert.equal(event.target.matches('textarea,input,select'),false);keys.push(event);});
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
        document: {body,createElement:name=>({tagName:name})},
        KeyboardEvent: class extends Event {constructor(type,options){super(type,options);Object.assign(this,{key:options.key,shiftKey:options.shiftKey,repeat:options.repeat});}},
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
    return {module, messages, api, emit, keys, body, state: () => state,
        reply: (message, data, ok = true) => emit('message', {
            origin:'https://host.invalid',source:{parentFrame:true},data: {type: 'review-response', id: message.id, ok, ...(ok ? {data} : {error: data})},
        })};
}

test('bridge pairs out-of-order responses and ignores unrelated and duplicate messages', async () => {
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; }, 'https://host.invalid');
    const first = call('request', {path: '/data?scope=round'});
    const second = call('asset', {path: '/assets/page.svg'});
    assert.notEqual(messages[0].id, messages[1].id);
    assert.equal(messages[0].action, 'request'); assert.equal(messages[1].action, 'asset');
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: 'unknown', ok: true, data: 'Ignored'}});
    receive({origin:'https://host.invalid',data: {type: 'review-changed', id: messages[0].id, ok: true, data: 'Ignored'}});
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[1].id, ok: true, data: '<svg/>'}});
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[1].id, ok: false, error: 'Duplicate'}});
    assert.equal(await second, '<svg/>');
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[0].id, ok: true, data: {revision: 4}}});
    assert.deepEqual(await first, {revision: 4});
});

test('bridge reports host errors without affecting another pending request', async () => {
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; }, 'https://host.invalid');
    const failed = call('source', {file: 'missing.tex'});
    const failedCheck = assert.rejects(failed, /Missing source file/);
    const healthy = call('copy', {text: 'Exact 🧬 text'});
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[0].id, ok: false, error: 'Missing source file'}});
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[1].id, ok: true}});
    await failedCheck; assert.equal(await healthy, undefined);
    const unspecified = call('request');
    const unspecifiedCheck = assert.rejects(unspecified, /could not complete this action/);
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[2].id, ok: false}});
    await unspecifiedCheck;
});

test('bridge times out an unanswered request and accepts subsequent replies', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const messages = []; let receive;
    const call = createBridge({postMessage: message => messages.push(message)}, listener => { receive = listener; }, 'https://host.invalid');
    const missing = call('request', {path: '/data'});
    const check = assert.rejects(missing, /did not respond/);
    t.mock.timers.tick(30_000); await check;
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[0].id, ok: true, data: 'Too late'}});
    const next = call('request', {path: '/data'});
    receive({origin:'https://host.invalid',data: {type: 'review-response', id: messages[1].id, ok: true, data: 'Current'}});
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
    h.reply(h.messages.at(-1), 'http://127.0.0.1:23456/viewer.html'); await setup;
    assert.equal(new URL(frame.src).searchParams.get('parentOrigin'),'https://host.invalid');
    const forged=h.module.copyText('Keep this pending');
    await h.emit('message',{origin:'http://127.0.0.1:23456',source:frame.contentWindow,data:{type:'review-response',id:h.messages.at(-1).id,ok:true,data:'Forged'}});
    h.reply(h.messages.at(-1),'Trusted');assert.equal(await forged,'Trusted');
    const count = h.messages.length;
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: {}, origin: 'http://127.0.0.1:23456'});
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'https://other.invalid'});
    assert.equal(h.messages.length, count);
    const loading = h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'http://127.0.0.1:23456'});
    assert.equal(h.messages.at(-1).path, '/assets/source.pdf');
    h.reply(h.messages.at(-1), 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4').toString('base64'));
    await loading;
    assert.deepEqual(packets[0], [{type: 'review-pdf', document: '/assets/source.pdf', data: Uint8Array.from(Buffer.from('%PDF-1.4')), marks, color: 'added', active: true}, 'http://127.0.0.1:23456']);
    frame.isConnected = false;
    await h.emit('message', {data: {type: 'review-pdf-ready'}, source: frame.contentWindow, origin: 'http://127.0.0.1:23456'});
    assert.equal(packets.length, 1);
});

test('PDF review keys target an Element and preserve review navigation modifiers',async t=>{
    const h=await host(t,true),frame={isConnected:true,src:'',contentWindow:{postMessage(){}}};
    const setup=h.module.pdfFrame(frame,{path:'/assets/source.pdf',marks:[],color:'added'});
    h.reply(h.messages.at(-1),'http://127.0.0.1:23456/viewer.html');await setup;
    const event={data:{type:'review-pdf-key',key:'A',shiftKey:true,repeat:false},source:frame.contentWindow,origin:'http://127.0.0.1:23456'};
    await h.emit('message',{...event,source:{}});await h.emit('message',{...event,origin:'https://other.invalid'});
    assert.equal(h.keys.length,0);
    await h.emit('message',event);
    assert.equal(h.keys[0].target,h.body);assert.equal(h.keys[0].key,'A');assert.equal(h.keys[0].shiftKey,true);
    for(const key of ['j','k','[',']','?'])await h.emit('message',{...event,data:{type:'review-pdf-key',key}});
    assert.deepEqual(h.keys.map(event=>event.key),['A','j','k','[',']','?']);
});

test('both initially detached PDF panes remain registered when mounted together',async t=>{
    const h=await host(t,true),packets=[];
    const frames=['before','after'].map(side=>({isConnected:false,src:'',contentWindow:{postMessage:message=>packets.push({side,message})}}));
    const setups=frames.map((frame,index)=>h.module.pdfFrame(frame,{path:`/assets/${index}.pdf`,marks:[],color:'added'}));
    frames.forEach(frame=>{frame.isConnected=true;});
    await Promise.all(h.messages.slice().map(message=>h.reply(message,'http://127.0.0.1:23456/viewer.html')));await Promise.all(setups);
    const loading=frames.map(frame=>h.emit('message',{data:{type:'review-pdf-ready'},source:frame.contentWindow,origin:'http://127.0.0.1:23456'}));
    const assets=h.messages.filter(message=>message.action==='asset');assert.equal(assets.length,2);
    await Promise.all(assets.map(message=>h.reply(message,'data:application/pdf;base64,JVBERg==')));await Promise.all(loading);
    assert.equal(packets.length,2);
});

test('navigation reuses loaded PDF bytes and only sends new highlight locations',async t=>{
    const h=await host(t,true),packets=[],frame={isConnected:true,src:'',contentWindow:{postMessage:message=>packets.push(message)}};
    const setup=h.module.pdfFrame(frame,{path:'/assets/source.pdf',marks:[{page:1,bounds:null}],color:'added'});
    h.reply(h.messages.at(-1),'http://127.0.0.1:23456/viewer.html');await setup;
    const loading=h.emit('message',{data:{type:'review-pdf-ready'},source:frame.contentWindow,origin:'http://127.0.0.1:23456'});
    h.reply(h.messages.at(-1),'data:application/pdf;base64,JVBERg==');await loading;
    const source=frame.src,count=h.messages.length,marks=[{page:3,bounds:[.1,.2,.3,.4]}];
    await h.module.pdfFrame(frame,{path:'/assets/source.pdf',marks,color:'removed'});
    assert.equal(frame.src,source);assert.equal(h.messages.length,count);
    assert.deepEqual(packets.at(-1),{type:'review-pdf',document:'/assets/source.pdf',marks,color:'removed',active:true});
});

test('a pending PDF load uses the latest marks and an obsolete document failure cannot remove its replacement',async t=>{
    const h=await host(t,true),packets=[],frame={isConnected:true,src:'',contentWindow:{postMessage:message=>packets.push(message)},replaceWith(){throw new Error('Do not remove the newer PDF.');}};
    const setup=h.module.pdfFrame(frame,{path:'/assets/old.pdf',marks:[],color:'added'});
    h.reply(h.messages.at(-1),'http://127.0.0.1:23456/viewer.html');await setup;
    const loading=h.emit('message',{data:{type:'review-pdf-ready'},source:frame.contentWindow,origin:'http://127.0.0.1:23456'}),old=h.messages.at(-1);
    const next=h.module.pdfFrame(frame,{path:'/baseline-assets/new.pdf',marks:[{page:2,bounds:null}],color:'removed'}),fresh=h.messages.at(-1);
    await h.module.pdfFrame(frame,{path:'/baseline-assets/new.pdf',marks:[{page:4,bounds:null}],color:'removed'});
    h.reply(old,'Old asset failed.',false);h.reply(fresh,'data:application/pdf;base64,JVBERg==');await loading;await next;
    assert.equal(packets.length,1);assert.equal(packets[0].document,'/baseline-assets/new.pdf');
    assert.deepEqual(packets[0].marks,[{page:4,bounds:null}]);
});

test('an old viewer failure cannot replace a newly selected PDF while its bytes load',async t=>{
    const h=await host(t,true),packets=[],replacements=[];
    const frame={isConnected:true,src:'',contentWindow:{postMessage:message=>packets.push(message)},replaceWith:element=>replacements.push(element)};
    const setup=h.module.pdfFrame(frame,{path:'/assets/old.pdf',marks:[],color:'added'});
    h.reply(h.messages.at(-1),'http://127.0.0.1:23456/viewer.html');await setup;
    const loading=h.emit('message',{data:{type:'review-pdf-ready'},source:frame.contentWindow,origin:'http://127.0.0.1:23456'});
    h.reply(h.messages.at(-1),'data:application/pdf;base64,JVBERg==');await loading;
    const next=h.module.pdfFrame(frame,{path:'/baseline-assets/new.pdf',marks:[],color:'added'}),asset=h.messages.at(-1);
    const failure=document=>h.emit('message',{data:{type:'review-pdf-error',document,error:'PDF could not open.'},source:frame.contentWindow,origin:'http://127.0.0.1:23456'});
    await failure('/assets/old.pdf');assert.equal(replacements.length,0);
    h.reply(asset,'data:application/pdf;base64,JVBERg==');await next;assert.equal(packets.at(-1).document,'/baseline-assets/new.pdf');
    await failure('/baseline-assets/new.pdf');assert.equal(replacements.length,1);
    assert.equal(replacements[0].textContent,'PDF could not open.');
});
