import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createAgentTools} from '../src/agent.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),"manuscript-review-agent's tools-"));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const extensionPath=path.join(directory,'extension'),storagePath=path.join(directory,'stored tools');
 const runtime=path.join(extensionPath,'dist/runtime');
 await mkdir(runtime,{recursive:true});
 for(const file of ['manuscript_review','skills/manuscript-review','README.md','ARCHITECTURE.md','LICENSE','docs'])
  await cp(path.join(source,file),path.join(runtime,file),{recursive:true,filter:file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')});
 await mkdir(path.join(runtime,'vscode'));await cp(path.join(source,'vscode/README.md'),path.join(runtime,'vscode/README.md'));
 return {directory,extensionPath,storagePath,runtime};
}

test('the extension launcher runs the bundled core from any directory after the VSIX is replaced',async t=>{
 const f=await fixture(t),tools=createAgentTools({...f,version:'0.1.2'});
 const launcher=await tools.prepare(python);await rm(f.extensionPath,{recursive:true});
 const home=path.join(f.directory,'isolated library');
 const result=execFileSync(launcher,['--home',home,'list'],{cwd:tmpdir(),encoding:'utf8'});
 assert.deepEqual(JSON.parse(result),[]);
 assert.equal(await tools.prepare(python),launcher);
 assert.match(await readFile(path.join(f.storagePath,'skills/manuscript-review/SKILL.md'),'utf8'),/name: manuscript-review/);
});

test('an extension update keeps earlier engine files and updates the linked skill launcher',async t=>{
 const f=await fixture(t),older=createAgentTools({...f,version:'0.1.1'}),newer=createAgentTools({...f,version:'0.1.2'});
 await older.prepare(python);const launcher=await newer.prepare(python);
 assert.equal(older.launcher,launcher);
 const shell=await readFile(launcher,'utf8');
 assert.ok(shell.includes(path.join(f.storagePath,'tools/0.1.2').replaceAll("'","'\"'\"'")));
 assert.match(await readFile(path.join(f.storagePath,'tools/0.1.1/manuscript_review/agent.py'),'utf8'),/def main/);
 assert.match(await readFile(path.join(f.storagePath,'ARCHITECTURE.md'),'utf8'),/review record/);
});

test('skill installation uses the prepared engine and refuses unsupported agents before dispatch',async t=>{
 const f=await fixture(t);
 await writeFile(path.join(f.runtime,'manuscript_review/agent.py'),`import json, sys\nprint(json.dumps({'arguments': sys.argv[1:]}))\n`);
 const tools=createAgentTools({...f,version:'0.1.2'});
 await assert.rejects(tools.install('codex'),/Open Setup/);
 await tools.prepare(python);
 const result=await tools.install('codex');
 assert.deepEqual(result.arguments,['install-skill','--agent','codex','--source',path.join(f.storagePath,'skills/manuscript-review')]);
 await assert.rejects(tools.install('../elsewhere'),/Choose Codex/);
});

test('Setup provides commands and documentation without opening an incompatible review library',async t=>{
 const f=await fixture(t),library=path.join(f.directory,'old library/reviews','a'.repeat(24));await mkdir(library,{recursive:true});
 const original='{"schema":5}';await writeFile(path.join(library,'review.json'),original);
 const tools=createAgentTools({...f,python,version:'0.1.2'}),status=await tools.setup();
 assert.equal(status.python,python);
 assert.equal(await readFile(path.join(library,'review.json'),'utf8'),original);
 const result=execFileSync(tools.launcher,['--home',path.dirname(path.dirname(library)),'setup'],{encoding:'utf8'});
 assert.equal(JSON.parse(result).python,python);
 for(const file of ['docs/INSTALL.md','docs/USAGE.md','vscode/README.md'])assert.ok((await readFile(path.join(f.storagePath,file),'utf8')).length);
});

test('an extension refresh leaves the active launcher executable throughout publication',async t=>{
 const f=await fixture(t),first=createAgentTools({...f,version:'0.1.1'}),next=createAgentTools({...f,version:'0.1.2'});
 const launcher=await first.prepare(python),run=promisify(execFile);
 const results=await Promise.all([next.prepare(python),...Array.from({length:12},()=>run(launcher,['--version']))]);
 for(const result of results.slice(1))assert.match(result.stdout,/^\d+\.\d+\.\d+\s*$/);
});
