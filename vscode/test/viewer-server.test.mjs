import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {createViewer} from '../src/viewer-server.mjs';

test('the isolated viewer serves bundled assets, rejects traversal and stops with the extension',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'manuscript-pdf-server-')),root=path.join(directory,'viewer');
 await mkdir(root);await writeFile(path.join(root,'viewer.html'),'<html>Bundled viewer</html>');
 await writeFile(path.join(root,'font.wasm'),Buffer.from([0,97,115,109]));await writeFile(path.join(directory,'private.txt'),'Private source');
 await symlink(path.join(directory,'private.txt'),path.join(root,'outside.txt'));
 const viewer=createViewer(root);t.after(async()=>{await viewer.dispose();await rm(directory,{recursive:true,force:true});});
 const [origin,other]=await Promise.all([viewer.start(),viewer.start()]);assert.equal(origin,other);assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const response=await fetch(origin+'/viewer.html?parentOrigin=vscode-webview%3A%2F%2Freview');
 assert.equal(response.status,200);assert.equal(await response.text(),'<html>Bundled viewer</html>');
 const policy=response.headers.get('content-security-policy');assert.match(policy,/frame-ancestors vscode-webview: vscode-file:/);assert.match(policy,/img-src 'self' blob: data:/);
 assert.equal((await fetch(origin+'/font.wasm')).headers.get('content-type'),'application/wasm');
 assert.equal((await fetch(origin+'/viewer.html',{method:'HEAD'})).headers.get('content-length'),'27');
 for(const file of ['/','/outside.txt','/%2e%2e/private.txt','/missing'])assert.equal((await fetch(origin+file)).status,404);
 assert.equal((await fetch(origin+'/viewer.html',{method:'POST'})).status,405);
 assert.equal(await new Promise(resolve=>request(origin+'/viewer.html',{headers:{Host:'other.test'}},response=>{response.resume();resolve(response.statusCode);}).end()),403);
 assert.equal(await new Promise(resolve=>request(origin+'/viewer.html',{headers:{Host:'127.0.0.1:34567'}},response=>{response.resume();resolve(response.statusCode);}).end()),200);
 await viewer.dispose();await assert.rejects(fetch(origin+'/viewer.html'));await assert.rejects(viewer.start(),/has closed/);
});
