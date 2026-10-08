import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createRuntime} from '../src/runtime.mjs';

const reviewId = 'a'.repeat(24);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'manuscript-review-runtime-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    return directory;
}

async function synthetic(t, startup = '') {
    const directory = await temporary(t);
    const module = join(directory, 'runtime/manuscript_review');
    await mkdir(module, {recursive: true});
    await writeFile(join(module, '__init__.py'), '');
    await writeFile(join(module, '__main__.py'), `
import argparse, json, os, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--no-browser', action='store_true')
parser.add_argument('--home')
home = Path(parser.parse_args().home)
home.mkdir(parents=True, exist_ok=True)
(home / 'pid').write_text(str(os.getpid()))
revision = 3
opened = '${reviewId}'
jobs = {}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, value, status=200, mime='application/json'):
        content = json.dumps(value).encode() if mime == 'application/json' else value.encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def do_GET(self):
        if self.path == '/library-data':
            return self.reply({'token': 'library-secret', 'reviews': []})
        if self.path.startswith('/jobs/'):
            job = jobs[self.path[6:]]
            if job['pending']:
                job['pending'] -= 1
                return self.reply({'status': 'preparing'})
            return self.reply(job['result'])
        if self.path.startswith('/data'):
            return self.reply({'id': opened, 'token': 'review-secret', 'repo': str(home), 'revision': revision})
        if self.path.startswith('/editor'):
            return self.reply({'revision': revision, 'source': 'b' * 40, 'text': 'A sentence.'})
        if self.path == '/feedback.json':
            return self.reply({'history': [], 'token': 'review-secret'})
        if self.path.startswith('/assets/'):
            if self.path.endswith('missing.svg'):
                return self.reply({'error': 'not found'}, 404)
            if self.path.endswith('.svg'):
                return self.reply('<svg xmlns="http://www.w3.org/2000/svg"/>', mime='image/svg+xml')
            return self.reply('%PDF-1.4', mime='application/pdf')
        if self.path.startswith('/selected.patch'):
            return self.reply('--- old\\n+++ new\\n', mime='text/plain')
        return self.reply({'error': 'unknown request'}, 404)
    def do_POST(self):
        global revision, opened
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        library = self.path in ('/inspect', '/open', '/manuscript', '/update', '/prepare')
        token = 'library-secret' if library else 'review-secret'
        if self.headers.get('X-Review-Token') != token:
            return self.reply({'error': 'missing token'}, 403)
        if self.path == '/open':
            opened = body['id']
            return self.reply({'url': url})
        if self.path == '/inspect':
            return self.reply({'repo': body['repo']})
        if self.path in ('/manuscript', '/update', '/prepare'):
            name = 'b' * 24
            result = {'status': 'error', 'error': 'Cannot prepare this manuscript.'} if body.get('repo') == 'fail' else {'status': 'ready', 'review': '${reviewId}'}
            jobs[name] = {'pending': 100000 if body.get('repo') == 'wait' else 1, 'result': result}
            return self.reply({'job': name})
        if self.path == '/editor':
            return self.reply({'revision': revision, 'source': 'b' * 40, 'text': body['text']})
        if body.get('revision') != revision:
            return self.reply({'error': 'Review changed.', 'stale': True}, 409)
        revision += 1
        return self.reply({'revision': revision, 'entry': {'id': 'comment'}})

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
url = 'http://127.0.0.1:' + str(server.server_address[1]) + '/'
${startup || "print(json.dumps({'url': url, 'library_url': url}), flush=True)"}
server.serve_forever()
`);
    const home = join(directory, 'library');
    const runtime = createRuntime({extensionPath: directory, home});
    t.after(() => runtime.dispose());
    return {runtime, directory, home};
}

test('tokens stay in the extension host and ordered writes preserve explicit revisions', async t => {
    const {runtime, home} = await synthetic(t);
    const [one, two] = await Promise.all([runtime.start(), runtime.start()]);
    assert.deepEqual(one, two);
    assert.equal('token' in one, false);
    const opened = await runtime.open(reviewId);
    assert.equal('token' in opened, false);
    assert.deepEqual(runtime.review, {id: reviewId, url: one.url, repo: home, revision: 3});
    const [first, second] = await Promise.all([
        runtime.request('/note', {comment: 'First'}),
        runtime.request('/note', {comment: 'Second'})
    ]);
    assert.equal(first.revision, 4);
    assert.equal(second.revision, 5);
    assert.equal(runtime.review.revision, 5);
    await assert.rejects(runtime.request('/responses', {revision: 3, responses: []}), error => {
        assert.equal(error.status, 409);
        assert.equal(error.stale, true);
        return /Review changed/.test(error.message);
    });
    assert.equal((await runtime.data()).revision, 5);
    assert.equal((await runtime.request('/ui', {ui: {view: 'pdf'}})).revision, 6);
    const mutable = runtime.review;
    mutable.revision = 0;
    assert.equal(runtime.review.revision, 6);
});

test('the boundary refuses source writes, arbitrary URLs, and unsafe assets', async t => {
    const {runtime} = await synthetic(t);
    await runtime.open(reviewId);
    for (const path of ['/apply', '/file', '/draft', '/explanations', '//example.com/', 'http://example.com/']) {
        await assert.rejects(runtime.request(path, {}), /unavailable/);
    }
    for (const path of ['/assets/../review.json', '/assets/a.svg?secret', '//example.com/a.pdf', '/assets/a%2f.svg']) {
        await assert.rejects(runtime.asset(path), /preview asset/);
    }
    await assert.rejects(runtime.library('/install-skill', {}), /unavailable/);
    assert.throws(() => runtime.data('arbitrary'), /comparison/);
    await assert.rejects(runtime.open('not-an-id'), /saved review/);
    assert.equal((await runtime.request('/editor?file=main.tex')).text, 'A sentence.');
    assert.equal((await runtime.request('/editor', {file: 'main.tex', text: 'Dirty 🧬 source.'})).text, 'Dirty 🧬 source.');
    assert.equal(runtime.review.revision, 3);
    assert.match(await runtime.request('/selected.patch'), /--- old/);
    assert.equal(JSON.parse((await runtime.download('/feedback.json')).bytes).token, undefined);
    assert.match((await runtime.download('/selected.patch?scope=round')).bytes.toString(), /--- old/);
    await assert.rejects(runtime.download('/selected.patch?scope=manuscript'), /review export/);
    await assert.rejects(runtime.download('/assets/a.svg'), /review export/);
    const svg = await runtime.asset('/assets/a.svg');
    assert.equal(svg.mime, 'image/svg+xml');
    assert.match(svg.bytes.toString(), /<svg/);
    await assert.rejects(runtime.asset('/assets/missing.svg'), error => error.status === 404);
});

test('queued operations cannot write an earlier review into a newly opened one', async t => {
    const {runtime} = await synthetic(t);
    await runtime.open(reviewId);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { entered = resolve; });
    const original = globalThis.fetch;
    const nextId = 'b'.repeat(24);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (String(url).endsWith('/open') && JSON.parse(options.body).id === nextId) {
            entered(); await gate;
        }
        return original(url, options);
    });
    const opening = runtime.open(nextId);
    await began;
    const oldWrite = runtime.request('/save', {revision: 3, comments: {old: 'Keep this in its own round.'}});
    const refused = assert.rejects(oldWrite, /review changed/);
    release(); await opening; await refused;
    assert.equal(runtime.review.id, nextId);
    assert.equal((await runtime.data()).revision, 3);
    assert.equal((await runtime.request('/note', {comment: 'New round note.'})).revision, 4);
});

test('preparation polls the existing job API and can be cancelled by disposal', async t => {
    const {runtime} = await synthetic(t);
    const job = await runtime.prepare('/manuscript', {repo: 'ready'});
    assert.deepEqual(job, {status: 'ready', review: reviewId});
    assert.equal(runtime.review, undefined);
    await assert.rejects(runtime.prepare('/update', {repo: 'fail'}), /Cannot prepare/);
    const waiting = runtime.prepare('/manuscript', {repo: 'wait'});
    const cancelled = assert.rejects(waiting, /stopped|aborted/);
    await delay(100);
    await runtime.dispose();
    await cancelled;
    await assert.rejects(runtime.library('/library-data'), /stopped/);
});

test('startup refuses remote addresses and stops the process after failure', async t => {
    const {runtime, home} = await synthetic(t, "print(json.dumps({'url': 'https://example.com/', 'library_url': url}), flush=True)");
    await assert.rejects(runtime.start(), /invalid local address/);
    const pid = Number(await readFile(join(home, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('a missing Python executable reports the setup failure', async t => {
    const directory = await temporary(t);
    const runtime = createRuntime({extensionPath: directory, python: join(directory, 'missing-python')});
    t.after(() => runtime.dispose());
    await assert.rejects(runtime.start(), /Cannot start Python/);
    await assert.rejects(runtime.start(), /stopped/);
});

test('disposal terminates the backend and its child process group', async t => {
    if (process.platform === 'win32') return t.skip('The current Python service requires POSIX file locks.');
    const {runtime, home} = await synthetic(t, `
descendant = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
(home / 'descendant').write_text(str(descendant.pid))
print(json.dumps({'url': url, 'library_url': url}), flush=True)
`);
    await runtime.start();
    const pid = Number(await readFile(join(home, 'pid'), 'utf8'));
    const descendant = Number(await readFile(join(home, 'descendant'), 'utf8'));
    await runtime.dispose();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    // A killed descendant may briefly await reaping by init on Linux.
    for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(descendant, 0); } catch (error) {
            if (error.code === 'ESRCH') return;
            throw error;
        }
        await delay(20);
    }
    if (process.platform === 'linux') {
        assert.match(await readFile(`/proc/${descendant}/stat`, 'utf8'), /^\d+ \(.*\) Z /);
    } else assert.fail('The manuscript service left a descendant running.');
});

test('the bundled Python service preserves source while comments travel into the next round', async t => {
    const directory = await temporary(t);
    await mkdir(join(directory, 'runtime'), {recursive: true});
    await cp(join(sourceRoot, 'manuscript_review'), join(directory, 'runtime/manuscript_review'), {recursive: true});
    const repo = join(directory, 'manuscript');
    const home = join(directory, 'library');
    await mkdir(repo);
    const git = (...args) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
    git('init', '-q');
    git('config', 'user.name', 'Runtime Test');
    git('config', 'user.email', 'runtime@example.invalid');
    const file = join(repo, 'main.tex');
    await writeFile(file, 'An original sentence.\n');
    git('add', 'main.tex');
    git('commit', '-qm', 'Initial manuscript');
    const head = git('rev-parse', 'HEAD');
    const index = await readFile(join(repo, '.git/index'));
    const runtime = createRuntime({extensionPath: directory, home});
    t.after(() => runtime.dispose());
    const job = await runtime.prepare('/manuscript', {repo});
    const initial = await runtime.open(job.review);
    assert.equal(runtime.review.feedback_path, await realpath(join(home, 'reviews', job.review, 'review.json')));
    const editor = await runtime.request('/editor?file=main.tex');
    const note = await runtime.request('/note', {
        file: 'main.tex', source: editor.source, text: editor.text,
        start: 3, end: 11, comment: 'Please replace original with clearer.'
    });
    const recordPath = join(home, 'reviews', job.review, 'review.json');
    const beforeProjection = await readFile(recordPath);
    const dirty = await runtime.request('/editor', {file: 'main.tex', text: '🧬 ' + editor.text, point: 3});
    assert.equal(dirty.text, '🧬 ' + editor.text);
    assert.equal(dirty.position, 6);
    assert.deepEqual(dirty.notes, [{id: note.entry.id, from: 6, to: 14, note: true}]);
    assert.equal(dirty.revision, note.revision);
    assert.deepEqual(await readFile(recordPath), beforeProjection);
    assert.equal(await readFile(file, 'utf8'), editor.text);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.deepEqual(await readFile(join(repo, '.git/index')), index);
    await runtime.request('/responses', {responses: [{id: note.entry.id, text: 'I will refine this word.'}]});
    const withResponse = await runtime.data('manuscript');
    assert.equal(withResponse.history[0].replies[0].text, 'I will refine this word.');
    const prior = await readFile(join(home, 'reviews', job.review, 'review.json'));
    await writeFile(file, 'An clearer sentence.\n');
    const updated = await runtime.prepare('/update', {id: initial.id});
    assert.notEqual(updated.review, initial.id);
    const following = await runtime.open(updated.review);
    assert.equal(following.history[0].id, note.entry.id);
    assert.equal(following.history[0].replies[0].text, 'I will refine this word.');
    assert.ok(following.files[0].edits.length);
    assert.deepEqual(await readFile(join(home, 'reviews', job.review, 'review.json')), prior);
    assert.equal(await readFile(file, 'utf8'), 'An clearer sentence.\n');
});
