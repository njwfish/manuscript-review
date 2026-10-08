import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundle=build({entryPoints:[path.join(root,'src/extension.mjs')],bundle:true,write:false,platform:'node',format:'cjs',
  plugins:[{name:'test-adapters',setup(builder){
    builder.onResolve({filter:/^\.\/(runtime|comments|panel|decorations)\.mjs$/},args=>({path:'test-'+args.path.slice(2,-4),external:true}));
  }}],external:['vscode']}).then(result=>result.outputFiles[0].text);
const nativeRequire=createRequire(import.meta.url);
const reviewId='a'.repeat(24);

class Position {constructor(line,character){Object.assign(this,{line,character});}}
class Selection {constructor(start,end){Object.assign(this,{start,end});}}
const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});

async function fixture(t,options={}) {
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'manuscript-review-extension-')));
  const repo=path.join(directory,'manuscript');await mkdir(repo);
  const source=path.join(repo,'main.tex');await writeFile(source,'A manuscript sentence.\n');
  const record=path.join(directory,'review.json');await writeFile(record,'{"revision":1}');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const handlers=new Map(),contexts=new Map(),calls=[],errors=[],events={},watchers=[],output=[];
  const doc={uri:uri(source),version:1,text:'A manuscript sentence.\n',isDirty:false,languageId:'latex',
    getText(){return this.text;},positionAt(offset){const lines=this.text.slice(0,offset).split('\n');return new Position(lines.length-1,lines.at(-1).length);}};
  const editor={document:doc,selection:new Selection(new Position(0,0),new Position(0,1)),revealRange(range){this.revealed=range;}};
  const disposable=()=>({dispose(){}});
  function event(name){return callback=>{events[name]=callback;return disposable();};}
  const vscode={Uri:{file:uri},Selection,ViewColumn:{One:1},TextEditorRevealType:{InCenterIfOutsideViewport:2},
    RelativePattern:class{constructor(base,pattern){Object.assign(this,{base,pattern});}},
    commands:{registerCommand(name,callback){handlers.set(name,callback);return {dispose(){handlers.delete(name);}};},
      async executeCommand(name,...args){calls.push({kind:'command',name,args});if(name==='setContext')contexts.set(args[0],args[1]);}},
    workspace:{isTrusted:options.trusted??true,workspaceFolders:[{uri:uri(repo)}],textDocuments:[doc],
      getConfiguration:()=>({get:(key,fallback)=>options.config?.[key]??fallback}),
      getWorkspaceFolder:()=>({uri:uri(repo)}),
      async openTextDocument(requested){calls.push({kind:'document',file:requested.fsPath});assert.equal(requested.fsPath,source);return doc;},
      createFileSystemWatcher(pattern){const watcher={pattern,onDidChange:event('record-change'),onDidCreate:event('record-create'),dispose(){this.disposed=true;}};watchers.push(watcher);return watcher;},
      onDidChangeTextDocument:event('document-change')},
    window:{activeTextEditor:editor,visibleTextEditors:[editor],
      createOutputChannel:()=>({appendLine:text=>output.push(text),dispose(){}}),
      async showErrorMessage(message){errors.push(message);},
      async showQuickPick(items,configuration){calls.push({kind:'pick',items,configuration});return options.pick?.(items,configuration);},
      async showTextDocument(document,configuration){calls.push({kind:'show-source',document,configuration});this.activeTextEditor=editor;return editor;},
      onDidChangeVisibleTextEditors:event('visible-change'),onDidChangeActiveTextEditor:event('active-change')},
    extensions:{getExtension(id){calls.push({kind:'extension',id});return options.workshop===false?undefined:{async activate(){calls.push({kind:'activate-workshop'});}};}}};
  let selected,panelCallbacks,commentsCallbacks;
  const runtime={get review(){return selected?{...selected}:undefined;},
    async library(route,body){calls.push({kind:'library',route,body});return route==='/inspect'
      ?{repo,entries:options.entries||['main.tex']}: {reviews:options.reviews||[]};},
    async prepare(route,body){calls.push({kind:'prepare',route,body});return {review:reviewId};},
    async open(id){calls.push({kind:'open',id});selected={id,repo,revision:1,feedback_path:record};},
    async request(route,body){calls.push({kind:'request',route,body});assert.equal(route,'/editor');
      await options.onProjectionRequest?.(doc,runtime);return {position:12,ranges:[],notes:[]};},
    async dispose(){calls.push({kind:'dispose-runtime'});}};
  const panel={async flush(){calls.push({kind:'flush'});},async show(entry){calls.push({kind:'show-review',entry});options.onPanelShow?.(vscode);},
    async refresh(){calls.push({kind:'panel-refresh'});},changed(){calls.push({kind:'panel-change'});},dispose(){calls.push({kind:'dispose-panel'});}};
  const comments={async refresh(){calls.push({kind:'comments-refresh'});},async annotate(editor){calls.push({kind:'annotate',editor});},
    async move(direction){calls.push({kind:'move',direction});},dispose(){calls.push({kind:'dispose-comments'});}};
  const {sourceFile}=await import('../src/comments.mjs');
  const adapters={
    'test-runtime':{createRuntime(configuration){calls.push({kind:'create-runtime',configuration});return runtime;}},
    'test-panel':{createPanel(_vscode,_context,_runtime,callbacks){panelCallbacks=callbacks;return panel;}},
    'test-comments':{sourceFile,createComments(_vscode,_runtime,callbacks){commentsCallbacks=callbacks;return comments;}},
    'test-decorations':{createDecorations(){return {update(){calls.push({kind:'decorate'});},clear(){calls.push({kind:'clear-decorations'});},dispose(){}};}}
  };
  const module={exports:{}},context={extensionPath:'/test/extension',subscriptions:[]};
  vm.runInNewContext(await bundle,{exports:module.exports,module,require:name=>name==='vscode'?vscode:adapters[name]||nativeRequire(name),setTimeout,clearTimeout,console},{filename:'extension.cjs'});
  module.exports.activate(context);t.after(()=>module.exports.deactivate());
  return {vscode,runtime,doc,editor,source,repo,calls,errors,contexts,events,watchers,
    command:(name,...args)=>handlers.get('manuscriptReview.'+name)(...args),
    get panelCallbacks(){return panelCallbacks;},get commentsCallbacks(){return commentsCallbacks;}};
}

test('activation is lazy and an untrusted workspace cannot start the backend',async t=>{
  const f=await fixture(t,{trusted:false});
  assert.equal(f.calls.some(call=>call.kind==='create-runtime'),false);
  await f.command('open');
  assert.equal(f.calls.some(call=>call.kind==='create-runtime'),false);
  assert.match(f.errors[0],/Trust this workspace/);
});

test('a failed initial service can retry with corrected Python settings',async t=>{
  const options={config:{pythonPath:'/missing/python'}},f=await fixture(t,options);
  const library=f.runtime.library;let failed=false;
  f.runtime.library=async(...args)=>{if(!failed){failed=true;throw new Error('Cannot start Python.');}return library(...args);};
  await f.command('open');assert.match(f.errors[0],/Cannot start Python/);
  assert.equal(f.calls.filter(call=>call.kind==='dispose-runtime').length,1);
  options.config.pythonPath='/correct/python';await f.command('open');
  const starts=f.calls.filter(call=>call.kind==='create-runtime');
  assert.equal(starts.length,2);assert.equal(starts[1].configuration.python,'/correct/python');
  assert.equal(f.runtime.review.id,reviewId);
});

test('a saved-source pass pins its review revision and requires a reviewable diff',async t=>{
  const f=await fixture(t);await f.command('open');await f.command('reviewSavedChanges');
  const update=f.calls.find(call=>call.kind==='prepare'&&call.route==='/update');
  assert.deepEqual(JSON.parse(JSON.stringify(update.body)),{id:reviewId,expected_revision:1,require_changes:true});
});

test('opening a new manuscript uses its active root and leaves source unchanged',async t=>{
  const f=await fixture(t,{entries:['main.tex','supplement.tex']});
  await f.command('open');
  const preparation=f.calls.find(call=>call.kind==='prepare');
  assert.deepEqual(JSON.parse(JSON.stringify(preparation.body)),{repo:f.repo,entry:'main.tex'});assert.equal(preparation.route,'/manuscript');
  assert.equal(f.calls.filter(call=>call.kind==='create-runtime').length,1);
  assert.equal(f.calls.find(call=>call.kind==='create-runtime').configuration.extensionPath,path.join('/test/extension','dist'));
  assert.equal(f.contexts.get('manuscriptReview.active'),true);
  assert.equal(await readFile(f.source,'utf8'),'A manuscript sentence.\n');
  assert.equal(f.calls.some(call=>call.kind==='request'),false);
});

test('choosing among multiple root documents forwards the selected entry',async t=>{
  const f=await fixture(t,{entries:['paper.tex','supplement.tex'],pick:items=>items[1]});
  await f.command('open');
  assert.equal(f.calls.find(call=>call.kind==='prepare').body.entry,'supplement.tex');
  assert.equal(f.calls.filter(call=>call.kind==='pick').length,1);
});

test('initial annotation retains the native editor selection across review setup and webview focus',async t=>{
  const f=await fixture(t,{onPanelShow:vscode=>{vscode.window.activeTextEditor=undefined;}});
  await f.command('comment');
  assert.equal(f.calls.find(call=>call.kind==='annotate').editor,f.editor);
});

test('source navigation maps the exact dirty native buffer without saving it',async t=>{
  const f=await fixture(t);await f.command('open');
  f.doc.text='🧬 A dirty manuscript sentence.\n';f.doc.version++;f.doc.isDirty=true;
  await f.panelCallbacks.onSource({file:'main.tex',position:8});
  const request=f.calls.find(call=>call.kind==='request');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{file:'main.tex',text:f.doc.text,point:8});
  assert.deepEqual(f.editor.selection.start,new Position(0,12));assert.equal(f.doc.isDirty,true);
  assert.equal(await readFile(f.source,'utf8'),'A manuscript sentence.\n');
});

test('a buffer change during source mapping is rejected before moving the editor',async t=>{
  const f=await fixture(t,{onProjectionRequest:doc=>{doc.version++;doc.text='Changed during mapping.';}});
  await f.command('open');
  await assert.rejects(f.panelCallbacks.onSource({file:'main.tex',position:3}),/source.*changed/i);
  assert.equal(f.calls.some(call=>call.kind==='show-source'),false);
});

test('source navigation refuses symlinks leaving the manuscript repository',async t=>{
  const f=await fixture(t);await f.command('open');
  const external=path.join(path.dirname(f.repo),'outside.tex');await writeFile(external,'Outside text.');
  await symlink(external,path.join(f.repo,'escape.tex'));
  await assert.rejects(f.panelCallbacks.onSource({file:'escape.tex'}),/outside this manuscript/);
  assert.equal(f.calls.some(call=>call.kind==='request'),false);
});

test('reviewing saved changes refuses unsaved manuscript buffers',async t=>{
  const f=await fixture(t);await f.command('open');f.doc.isDirty=true;
  await f.command('reviewSavedChanges');
  assert.match(f.errors[0],/Save your manuscript files/);
  assert.equal(f.calls.some(call=>call.kind==='prepare'&&call.route==='/update'),false);
});

test('saved-change review requests a nonempty round against the exact reviewed revision',async t=>{
  const f=await fixture(t);await f.command('open');await f.command('reviewSavedChanges');
  const update=f.calls.find(call=>call.kind==='prepare'&&call.route==='/update');
  assert.deepEqual(JSON.parse(JSON.stringify(update.body)),{id:reviewId,expected_revision:1,require_changes:true});
  assert.equal(await readFile(f.source,'utf8'),'A manuscript sentence.\n');
});

test('live source PDF navigation delegates to Workshop without starting the review service',async t=>{
  const f=await fixture(t);await f.command('livePDF');
  assert.equal(f.calls.some(call=>call.kind==='create-runtime'),false);
  assert.equal(f.calls.find(call=>call.kind==='extension').id,'James-Yu.latex-workshop');
  assert.equal(f.calls.some(call=>call.kind==='activate-workshop'),true);
  assert.equal(f.calls.some(call=>call.kind==='command'&&call.name==='latex-workshop.synctex'),true);
});

test('review shortcuts and the comment context menu require the active manuscript source',async()=>{
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(manifest.contributes.keybindings.every(binding=>binding.when.includes('manuscriptReview.source')),true);
  const action=manifest.contributes.menus['editor/context'].find(action=>action.command==='manuscriptReview.comment');
  assert.match(action.when,/manuscriptReview\.source/);
});

test('native source context is reset when focus moves outside the reviewed manuscript',async t=>{
  const f=await fixture(t);await f.command('open');
  assert.equal(f.contexts.get('manuscriptReview.source'),true);
  const external={document:{...f.doc,uri:uri('/elsewhere/code.js')}};
  f.vscode.window.activeTextEditor=external;f.events['active-change'](external);
  assert.equal(f.contexts.get('manuscriptReview.source'),false);
});

test('the record watcher handles atomic replacement create events',async t=>{
  const f=await fixture(t);await f.command('open');
  assert.equal(typeof f.events['record-create'],'function');
});

test('concurrent Open commands share one review-selection operation',async t=>{
  const f=await fixture(t);await Promise.all([f.command('open'),f.command('open')]);
  assert.equal(f.calls.filter(call=>call.kind==='library'&&call.route==='/inspect').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='open').length,1);
});

test('source navigation is cancelled if the selected review changes during projection',async t=>{
  const f=await fixture(t,{onProjectionRequest:(_doc,runtime)=>runtime.open('b'.repeat(24))});
  await f.command('open');
  await assert.rejects(f.panelCallbacks.onSource({file:'main.tex',position:3}),/review.*changed/i);
  assert.equal(f.calls.some(call=>call.kind==='show-source'),false);
});
