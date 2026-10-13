import {spawn} from 'node:child_process';
import {join,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

const identifier = /^[a-f0-9]{24}$/;
const libraryWrites = new Set(['/inspect', '/source', '/agent-models', '/prepare', '/manuscript', '/update', '/open', '/clone', '/fetch', '/import']);
const reviewWrites = new Set(['/editor', '/capture', '/authoring', '/delivery', '/agents', '/note', '/thread', '/save', '/apply', '/draft', '/agent']);
const reviewReads = new Set(['/editor', '/delivery', '/agents']);
const libraryReads = new Set(['/inspect', '/source', '/agent-models', '/open']);

function localURL(value) {
    if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d*\/$/.test(value)) {
        throw new Error('The manuscript service returned an invalid local address.');
    }
    const url = new URL(value);
    if (!url.port) throw new Error('The manuscript service requires a local port.');
    return url.href;
}

function reviewRoute(path, writing) {
    if (writing) return reviewWrites.has(path);
    return path === '/status' || path === '/summary' || path === '/previews?scope=selected'
        || /^\/data\?scope=round(?:&file=[^#]*)?$/.test(path);
}

function publicData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const {token, ...result} = value;
    if (result.data) result.data = publicData(result.data);
    return result;
}

/** The caller must establish workspace trust before starting this local service. */
export function createRuntime({extensionPath, python = 'python3', home = '', output}) {
    let child, exited, starting, libraryURL, libraryToken, reviewToken, selected;
    let stopped = false, stopping, queue = Promise.resolve(), selectionEpoch = 0, serviceGeneration = 0, openIntent = 0;
    let controller = new AbortController();
    const log = text => output?.appendLine(text);
    const serialized = operation => {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    };
    const reading = async operation => {await queue;return operation();};

    async function send(url, path, token, body, timeout = 30_000) {
        if (stopped) throw new Error('The manuscript service has stopped.');
        const generation = serviceGeneration;
        const headers = {};
        if (body !== undefined) {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('A request needs an object.');
            headers['Content-Type'] = 'application/json';
            headers['X-Review-Token'] = token;
        }
        let response;
        try {
            response = await fetch(new URL(path, url), {
                method: body === undefined ? 'GET' : 'POST', headers,
                body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])
            });
        } catch (error) {
            if (stopped) throw new Error('The manuscript service has stopped.');
            throw new Error('Cannot reach the manuscript service.', {cause: error});
        }
        const value = response.headers.get('content-type')?.startsWith('application/json')
            ? await response.json() : await response.text();
        if (generation !== serviceGeneration) throw new Error('The manuscript service restarted. Refresh before continuing.');
        if (!response.ok) {
            const error = new Error(value.error || `The manuscript service refused this request (${response.status}).`);
            error.status = response.status;
            error.stale = Boolean(value.stale);
            if(value.capture)error.capture=value.capture;
            throw error;
        }
        return value;
    }

    async function stopProcess(processChild, completion) {
        if (!processChild?.pid) return;
        const signal = name => {
            try {
                if (process.platform === 'win32') processChild.kill(name);
                else process.kill(-processChild.pid, name);
            } catch (error) {
                if (error.code !== 'ESRCH') log(`Cannot stop the manuscript service: ${error.message}`);
            }
        };
        signal('SIGTERM');
        await Promise.race([completion, delay(2000, undefined, {ref: false})]);
        signal('SIGKILL');
        await completion;
    }

    async function stop(){stopped=true;controller.abort();await stopProcess(child,exited);}

    function dispose() {
        stopping ??= stop();
        return stopping;
    }

    async function launch() {
        if (stopped) throw new Error('The manuscript service has stopped.');
        controller = new AbortController();
        const generation = ++serviceGeneration;
        const args = ['-m', 'manuscript_review', '--no-browser'];
        if (home) args.push('--home', home);
        child = spawn(python, args, {
            cwd: extensionPath, env: {...process.env, PATH: [process.env.PATH,join(homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'].filter(Boolean).join(delimiter), PYTHONPATH: join(extensionPath, 'runtime')},
            stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
        });
        exited = new Promise(resolve => {
            child.once('error', resolve);
            child.once('exit', resolve);
        });
        const processChild=child,completion=exited;
        const stdout = createInterface({input: child.stdout});
        const stderr = createInterface({input: child.stderr});
        stderr.on('line', log);
        exited.then(() => {
            stdout.close();
            stderr.close();
            if (!stopped && generation === serviceGeneration) {
                log('The manuscript service stopped. Open or Refresh to restart it.');
                controller.abort();
                starting = undefined;libraryURL = libraryToken = reviewToken = undefined;
                void stopProcess(processChild,completion);
            }
        });
        try {
            const startup = await new Promise((resolve, reject) => {
                function settle(callback, value) {
                    clearTimeout(timer);
                    controller.signal.removeEventListener('abort', onAbort);
                    child.off('error', onError);
                    child.off('exit', onExit);
                    stdout.off('line', onLine);
                    callback(value);
                }
                const timer = setTimeout(() => settle(reject, new Error('The manuscript service did not start in time.')), 15_000);
                const onAbort = () => settle(reject, new Error('The manuscript service has stopped.'));
                const onError = error => settle(reject, new Error(`Cannot start Python: ${error.message}`, {cause: error}));
                const onExit = () => settle(reject, new Error('The manuscript service stopped during startup.'));
                function onLine(line) {
                    let value;
                    try { value = JSON.parse(line); } catch { log(line); return; }
                    if (value && typeof value === 'object' && 'library_url' in value) {
                        try {
                            localURL(value.url);
                            value.library_url = localURL(value.library_url);
                            settle(resolve, value);
                        } catch (error) { settle(reject, error); }
                    }
                }
                controller.signal.addEventListener('abort', onAbort, {once: true});
                child.once('error', onError);
                child.once('exit', onExit);
                stdout.on('line', onLine);
                if (controller.signal.aborted) onAbort();
            });
            stdout.on('line', log);
            libraryURL = startup.library_url;
            const info = await send(libraryURL, '/library-data');
            if (typeof info.token !== 'string' || !info.token) throw new Error('The manuscript service did not provide a library token.');
            libraryToken = info.token;
            if(selected){
                const result = await send(libraryURL, '/open', libraryToken, {id:selected.id});
                const url = localURL(result.url);
                const value = await send(url, '/summary');
                selected = {...selected, url};
                updateReview(value);
                if(!reviewToken){const data=await send(url, '/data?scope=round');updateReview(data);}
            }
            return {...publicData(info), url: libraryURL};
        } catch (error) {
            if(generation===serviceGeneration){controller.abort();child.kill();await exited;starting=undefined;}
            throw error;
        }
    }

    function start() {
        if (stopped) return Promise.reject(new Error('The manuscript service has stopped.'));
        if(!starting){const task=launch();starting=task;void task.catch(()=>{if(starting===task)starting=undefined;});}
        return starting;
    }

    async function library(path, body) {
        const writing = body !== undefined;
        if (!(writing ? libraryWrites.has(path) : path === '/library-data' || /^\/jobs\/[a-f0-9]{24}$/.test(path))) {
            throw new Error('This library operation is unavailable in VS Code.');
        }
        await start();
        return (writing && !libraryReads.has(path) ? serialized : reading)(async () => publicData(await send(libraryURL, path, libraryToken, body)));
    }

    function updateReview(value) {
        if (!Number.isInteger(value?.revision) || value.revision >= selected.revision) {
            if (Number.isInteger(value?.revision)) selected = {...selected, revision: value.revision};
            for (const key of ['workspace', 'workspace_version', 'feedback_path'])
                if (typeof value?.[key] === 'string') selected = {...selected, [key]: value[key]};
            if (value?.source_cursors) selected = {...selected, source_cursors: value.source_cursors};
        }
        if (typeof value?.token === 'string' && value.token) reviewToken = value.token;
        if (value?.data) updateReview(value.data);
        return publicData(value);
    }

    async function open(id, {beforeSelect=async()=>{},canSelect=()=>true}={}) {
        if (!identifier.test(id)) throw new Error('Choose a saved review.');
        const intent=++openIntent;
        await start();
        const epoch=selectionEpoch;
        const result=await library('/open',{id});
        const url=localURL(result.url);
        let value=await send(url,'/data?scope=round');
        if(value.id!==id||typeof value.repo!=='string'||!Number.isInteger(value.revision)||typeof value.token!=='string'||!value.token)
            throw new Error('The manuscript service returned an invalid review.');
        // Preparing another checkout never transfers ownership of current input.
        await serialized(async()=>{
            value=await send(url,'/data?scope=round');
            const checkout=await send(url,'/workspace',value.token,{revision:value.revision});
            if(selected?.id===id)updateReview({...value,...checkout});
        });
        while(true){
            await beforeSelect();
            value=await send(url,'/data?scope=round');
            const committed=await serialized(()=>{
                if(intent!==openIntent||epoch!==selectionEpoch)throw new Error('The manuscript review changed while opening this comparison.');
                if(!canSelect()||selected?.id===id&&selected.revision>value.revision)return false;
                selected={id,url,repo:value.repo,revision:value.revision};reviewToken=value.token;
                selectionEpoch++;
                updateReview(value);
                return true;
            });
            if(committed)return publicData(value);
        }
    }

    async function request(path, body, checkSource) {
        if (!reviewRoute(path, body !== undefined)) throw new Error('This review operation is unavailable in VS Code.');
        if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) throw new Error('A request needs an object.');
        if (path === '/apply' && typeof checkSource !== 'function') throw new Error('Apply requires a source editor check.');
        const expectedReview=selected?.id,epoch=selectionEpoch;
        await start();
        return (body !== undefined && !reviewReads.has(path) ? serialized : reading)(async () => {
            if (!selected) throw new Error('Open a manuscript review first.');
            if(selected.id!==expectedReview || epoch!==selectionEpoch)throw new Error('The manuscript review changed. Return to the original review before continuing.');
            const requestBody = body === undefined ? undefined : {revision: selected.revision, ...body};
            if (path === '/apply') checkSource();
            const value = await send(selected.url, path, reviewToken, requestBody);
            if(selected?.id!==expectedReview || epoch!==selectionEpoch)throw new Error('The manuscript review changed. Return to the original review before continuing.');
            return updateReview(value);
        });
    }

    function data(file) {
        return request(`/data?scope=round${file ? '&file='+encodeURIComponent(file) : ''}`);
    }

    async function prepare(path, body) {
        if (!['/manuscript', '/update', '/prepare', '/clone', '/fetch'].includes(path)) throw new Error('Choose a manuscript preparation operation.');
        const result = await library(path, body);
        if (!identifier.test(result.job)) throw new Error('The manuscript service returned an invalid preparation job.');
        const deadline = Date.now() + (['/clone', '/fetch'].includes(path) ? 320_000 : 120_000);
        while (!stopped && Date.now() < deadline) {
            const job = await library(`/jobs/${result.job}`);
            if (job.status === 'ready') return job;
            if (job.status === 'error') throw new Error(job.error || 'Could not prepare the manuscript review.');
            if (!['preparing', 'loading'].includes(job.status)) throw new Error('The manuscript service returned an invalid preparation status.');
            await delay(200, undefined, {signal: controller.signal});
        }
        throw new Error(stopped ? 'The manuscript service has stopped.' : 'Preparing the manuscript review took too long.');
    }

    async function resource(path, mime) {
        await start();
        if (!selected) throw new Error('Open a manuscript review first.');
        const response = await fetch(new URL(path, selected.url), {
            redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
        });
        if (!response.ok) {
            const error = new Error(`The manuscript preview is unavailable (${response.status}).`);
            error.status = response.status;
            throw error;
        }
        if (!response.headers.get('content-type')?.startsWith(mime)) throw new Error('The manuscript preview has an unexpected format.');
        return {bytes: Buffer.from(await response.arrayBuffer()), mime};
    }

    async function asset(path) {
        if (!/^\/selected-assets\/[A-Za-z0-9_-]+\.pdf$/.test(path)) throw new Error('Choose a manuscript preview asset.');
        return resource(path, 'application/pdf');
    }

    return {start, library, open, data, request, prepare, asset, dispose,
        get review() { return selected ? {...selected} : undefined; }};
}
