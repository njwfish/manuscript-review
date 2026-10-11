import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,realpath,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSourceDocuments,sourceScheme,snapshotFile} from '../src/source-documents.mjs';

const makeURI=value=>({...value,fsPath:value.path,toString(){return `${this.scheme}://${this.authority||''}${this.path}${this.query?'?'+this.query:''}`;}});
const fileURI=file=>makeURI({scheme:'file',path:file});

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'manuscript-review-source-'))),repo=path.join(root,'repo');
 await mkdir(repo);const file=path.join(repo,'main.tex');await writeFile(file,'Saved manuscript.\n');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const documents=[],opened=[],requests=[],providers=new Map();
 const saved={review:'a'.repeat(24),file:'main.tex',source:'b'.repeat(40),text:'Pinned manuscript 🧬.\r\n'};
 const runtime={review:{id:saved.review,repo},library:async(route,body)=>{requests.push({route,body});return {...saved};}};
 const vscode={Uri:{file:fileURI,from:makeURI},workspace:{textDocuments:documents,
  registerTextDocumentContentProvider(scheme,provider){providers.set(scheme,provider);return {dispose(){providers.delete(scheme);}};},
  async openTextDocument(uri){
   opened.push(uri);
   let document=documents.find(item=>item.uri.toString()===uri.toString());
   if(!document){const text=uri.scheme===sourceScheme?await providers.get(uri.scheme).provideTextDocumentContent(uri):'Saved manuscript.\n';document={uri,isDirty:false,isClosed:false,getText:()=>text};documents.push(document);}
   return document;
  }
 }};
 const sources=createSourceDocuments(vscode,async()=>runtime);t.after(()=>sources.dispose());
 return {root,repo,file,saved,runtime,vscode,sources,providers,documents,opened,requests};
}

test('working source stays native and an unsaved buffer survives a missing disk file',async t=>{
 const f=await fixture(t),document=await f.sources.open('main.tex');
 assert.equal(document.uri.scheme,'file');assert.equal(f.requests.length,0);
 document.isDirty=true;document.getText=()=> 'Exact author draft.';await rm(f.file);
 assert.equal(await f.sources.open('main.tex'),document);assert.equal(document.getText(),'Exact author draft.');assert.equal(f.requests.length,0);
});

test('deleted source opens as a read-only versioned document without creating a file',async t=>{
 const f=await fixture(t);await rm(f.file);
 const document=await f.sources.open('main.tex');
 assert.equal(document.uri.scheme,sourceScheme);assert.equal(document.getText(),f.saved.text);
 assert.equal(document.isDirty,false);assert.equal(snapshotFile(f.runtime.review,document),'main.tex');
 assert.equal(snapshotFile({id:'another'},document),null);
 assert.deepEqual(f.requests,[{route:'/source',body:{id:f.saved.review,file:'main.tex'}}]);
 await assert.rejects(realpath(f.file),error=>error.code==='ENOENT');
 f.saved.source='c'.repeat(40);f.runtime.review.revision=2;
 assert.equal(await f.sources.open('main.tex'),document,'refreshes must preserve the existing comment editor');
 assert.equal(f.requests.length,1,'unrelated decisions cannot recreate a pinned comment document');
 await writeFile(f.file,'Restored manuscript.');
 assert.equal(await f.sources.open('main.tex'),document,'restoring a file cannot discard an open comment editor');
 assert.equal(f.requests.length,1);
});

test('provider can reopen an old immutable tab independently of the active comparison',async t=>{
 const f=await fixture(t);f.runtime.review={id:'another',repo:f.repo};
 const uri=makeURI({scheme:sourceScheme,authority:f.saved.review,path:'/main.tex',query:'version='+f.saved.source});
 const document=await f.vscode.workspace.openTextDocument(uri);
 assert.equal(document.getText(),f.saved.text);
 assert.deepEqual(f.requests,[{route:'/source',body:{id:f.saved.review,file:'main.tex',version:f.saved.source}}]);
});

test('a file disappearing during native open falls back even when VS Code omits its error code',async t=>{
 const f=await fixture(t),open=f.vscode.workspace.openTextDocument;
 f.vscode.workspace.openTextDocument=async uri=>{
  if(uri.scheme==='file'){await rm(f.file);throw new Error('Unable to resolve nonexistent file');}
  return open(uri);
 };
 const document=await f.sources.open('main.tex');assert.equal(document.uri.scheme,sourceScheme);assert.equal(document.getText(),f.saved.text);
});

test('permission errors and escaped source paths are not disguised as saved-source fallbacks',async t=>{
 const f=await fixture(t);
 f.vscode.workspace.openTextDocument=async()=>{throw Object.assign(new Error('Permission denied'),{code:'EACCES'});};
 await assert.rejects(f.sources.open('main.tex'),/Permission denied/);
 await assert.rejects(f.sources.open('../outside.tex'),/in this manuscript/);
 const outside=path.join(f.root,'outside.tex');await writeFile(outside,'Outside source');await rm(f.file);await symlink(outside,f.file);
 await assert.rejects(f.sources.open('main.tex'),/outside this manuscript/);
 assert.equal(f.requests.length,0);
});

test('switching reviews while loading saved source cannot open an obsolete document',async t=>{
 const f=await fixture(t);await rm(f.file);
 f.runtime.library=async()=>{f.runtime.review={id:'another',repo:f.repo};return f.saved;};
 await assert.rejects(f.sources.open('main.tex'),/review changed/);assert.equal(f.opened.length,0);
});
