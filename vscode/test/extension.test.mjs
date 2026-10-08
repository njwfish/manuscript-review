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
    builder.onResolve({filter:/^\.\/(runtime|comments|panel|decorations|agent)\.mjs$/},args=>({path:'test-'+args.path.slice(2,-4),external:true}));
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
  const vscode={Uri:{file:uri},Selection,ViewColumn:{One:1},ProgressLocation:{Notification:15},TextEditorRevealType:{InCenterIfOutsideViewport:2},env:{clipboard:{async writeText(text){calls.push({kind:'clipboard',text});}}},
    RelativePattern:class{constructor(base,pattern){Object.assign(this,{base,pattern});}},
    commands:{registerCommand(name,callback){handlers.set(name,callback);return {dispose(){handlers.delete(name);}};},
      async executeCommand(name,...args){calls.push({kind:'command',name,args});if(name==='setContext')contexts.set(args[0],args[1]);}},
    workspace:{isTrusted:options.trusted??true,workspaceFolders:[{uri:uri(repo)}],textDocuments:[doc],
      getConfiguration:()=>({get:(key,fallback)=>options.config?.[key]??fallback}),
      getWorkspaceFolder:()=>({uri:uri(repo)}),
      async openTextDocument(requested){calls.push({kind:'document',file:requested.fsPath,content:requested.content,language:requested.language});if(requested.content!==undefined)return {uri:{scheme:'untitled'},getText:()=>requested.content};assert.equal(requested.fsPath,source);return doc;},
      createFileSystemWatcher(pattern){const watcher={pattern,onDidChange:event('record-change'),onDidCreate:event('record-create'),dispose(){this.disposed=true;}};watchers.push(watcher);return watcher;},
      onDidChangeTextDocument:event('document-change')},
    window:{activeTextEditor:editor,visibleTextEditors:[editor],
      createOutputChannel:()=>({appendLine:text=>output.push(text),dispose(){}}),
      async showErrorMessage(message){errors.push(message);},
      async showInformationMessage(message){calls.push({kind:'information',message});},
      async showInputBox(configuration){calls.push({kind:'input',configuration});return options.input;},
      async withProgress(configuration,action){calls.push({kind:'progress',configuration});return action();},
      async showOpenDialog(configuration){calls.push({kind:'folder',configuration});return options.folder?.map(uri);},
      registerUriHandler(handler){events.uri=handler.handleUri;return disposable();},
      async showQuickPick(items,configuration){calls.push({kind:'pick',items,configuration});return options.pick?.(items,configuration);},
      async showTextDocument(document,configuration){calls.push({kind:'show-source',document,configuration});this.activeTextEditor=editor;return editor;},
      onDidChangeVisibleTextEditors:event('visible-change'),onDidChangeActiveTextEditor:event('active-change')},
    extensions:{getExtension(id){calls.push({kind:'extension',id});return options.workshop===false?undefined:{async activate(){calls.push({kind:'activate-workshop'});}};}}};
  let selected,panelCallbacks,commentsCallbacks;
  const runtime={get review(){return selected?{...selected}:undefined;},
    async library(route,body){calls.push({kind:'library',route,body});if(route==='/import')return {review:reviewId};return route==='/inspect'
      ?{repo,entries:options.entries||['main.tex'],...options.inspect}: {reviews:options.reviews||[]};},
    async prepare(route,body){calls.push({kind:'prepare',route,body});return route==='/clone'?{repo:options.clonedRepo}:{review:reviewId};},
    async open(id){calls.push({kind:'open',id});selected={id,repo,revision:1,feedback_path:record};return {files:options.files??[{edits:[{id:'edit'}]}]};},
    async data(){return {id:selected.id,revision:selected.revision,drafts:options.drafts||{}};},
    async request(route,body,checkSource){await options.onRequestQueue?.(doc);if(route==='/apply')checkSource();calls.push({kind:'request',route,body});if(route==='/apply')return {applied:true,revision:2};if(route==='/draft')return {revision:2};assert.equal(route,'/editor');
      await options.onProjectionRequest?.(doc,runtime);return {position:12,ranges:[],notes:[]};},
    async dispose(){calls.push({kind:'dispose-runtime'});}};
  const panel={async flush(){calls.push({kind:'flush'});await options.onFlush?.(doc);},async show(entry){calls.push({kind:'show-review',entry});options.onPanelShow?.(vscode);},
    async refresh(){calls.push({kind:'panel-refresh'});},changed(){calls.push({kind:'panel-change'});},dispose(){calls.push({kind:'dispose-panel'});}};
  const comments={async refresh(){calls.push({kind:'comments-refresh'});},async annotate(editor){calls.push({kind:'annotate',editor});},
    async move(direction){calls.push({kind:'move',direction});},dispose(){calls.push({kind:'dispose-comments'});}};
  const {sourceFile}=await import('../src/comments.mjs');
  const adapters={
    'test-agent':{createAgentTools(configuration){calls.push({kind:'create-agent-tools',configuration});return {launcher:'/stored/skills/manuscript-review/scripts/review-agent',command:"'/stored/skills/manuscript-review/scripts/review-agent'",async setup(){await options.onToolsSetup?.(configuration);calls.push({kind:'prepare-tools',python:'/python'});return {python:'/python',git:true,preview_tools:{},agents:[{id:'codex',name:'Codex'}]};},async install(agent){calls.push({kind:'install-skill',agent});return {message:'Skill installed.'};}};}},
    'test-runtime':{createRuntime(configuration){calls.push({kind:'create-runtime',configuration});return runtime;}},
    'test-panel':{createPanel(_vscode,_context,_runtime,callbacks){panelCallbacks=callbacks;return panel;}},
    'test-comments':{sourceFile,createComments(_vscode,_runtime,callbacks){commentsCallbacks=callbacks;return comments;}},
    'test-decorations':{createDecorations(){return {update(){calls.push({kind:'decorate'});},clear(){calls.push({kind:'clear-decorations'});},dispose(){}};}}
  };
  const module={exports:{}},context={extensionPath:'/test/extension',globalStorageUri:uri(path.join(directory,'storage')),extension:{packageJSON:{version:'0.1.2'}},subscriptions:[]};
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

test('opening an unchanged manuscript keeps annotation in the native editor',async t=>{
  const f=await fixture(t,{files:[]});await f.command('comment');
  assert.equal(f.calls.some(call=>call.kind==='show-review'),false);
  assert.equal(f.calls.find(call=>call.kind==='annotate').editor,f.editor);
  await f.command('focusedReview');
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,1);
});

test('cancelling the round picker quietly stops dependent commands',async t=>{
  const f=await fixture(t,{reviews:[{id:reviewId,repo:'placeholder'}]});
  f.runtime.library=async route=>route==='/inspect'?{repo:f.repo,entries:['main.tex']}:
    {reviews:[{id:reviewId,repo:f.repo,base_label:'Base',proposal_label:'Proposal'}]};
  await f.command('focusedReview');
  assert.deepEqual(f.errors,[]);
  assert.equal(f.calls.some(call=>call.kind==='show-review'||call.kind==='open'),false);
});

test('the picker names rounds consistently and avoids a duplicate manuscript entry',async t=>{
  const f=await fixture(t,{pick:items=>items[0]});
  f.runtime.library=async route=>route==='/inspect'?{repo:f.repo,entries:['main.tex']}:
    {reviews:[{id:reviewId,repo:f.repo,base_label:'B',proposal_label:'P'},
      {id:'b'.repeat(24),repo:f.repo,base_label:'B',proposal_label:'First'}]};
  await f.command('open');
  const items=f.calls.find(call=>call.kind==='pick').items;
  assert.deepEqual(Array.from(items,item=>item.label),['Round 2','Round 1']);
  assert.equal(items.length,2);
});

test('the focused round picker remains tied to the displayed manuscript',async t=>{
  const f=await fixture(t);await f.command('open');
  f.vscode.window.activeTextEditor={document:{...f.doc,uri:uri('/elsewhere/other.tex')}};
  await f.panelCallbacks.onCommand('rounds');
  assert.equal(f.calls.filter(call=>call.kind==='library'&&call.route==='/inspect').at(-1).body.repo,f.repo);
  await assert.rejects(async()=>f.panelCallbacks.onCommand('arbitrary'),/Unknown review command/);
});

test('focused Apply refuses dirty source and forwards the exact transaction once saved',async t=>{
  const f=await fixture(t);await f.command('open');f.doc.isDirty=true;
  const body={revision:1,decisions:{edit:'reject'},comments:{edit:'Keep the original.'}};
  await assert.rejects(f.panelCallbacks.onApply(body),/Save or discard/);
  assert.equal(f.calls.some(call=>call.kind==='request'&&call.route==='/apply'),false);
  f.doc.isDirty=false;assert.equal((await f.panelCallbacks.onApply(body)).applied,true);
  assert.equal(f.calls.find(call=>call.kind==='request'&&call.route==='/apply').body,body);
});

test('Apply and comparison protect unsaved manuscript dependencies as well as commentable source',async t=>{
  const f=await fixture(t);await f.command('open');
  const dependency={uri:uri(path.join(f.repo,'macros.sty')),isDirty:true};
  f.vscode.workspace.textDocuments.push(dependency);
  await assert.rejects(f.panelCallbacks.onApply({revision:1}),/Save or discard/);
  await f.command('reviewSavedChanges');
  assert.equal(f.calls.some(call=>call.kind==='request'&&call.route==='/apply'),false);
  assert.equal(f.calls.some(call=>call.kind==='prepare'&&call.route==='/update'),false);
  assert.match(f.errors[0],/Save or discard/);
});

test('typing while focused input flushes stops a saved-source comparison',async t=>{
  const options={},f=await fixture(t,options);await f.command('open');
  options.onFlush=doc=>{doc.isDirty=true;};await f.command('reviewSavedChanges');
  assert.equal(f.calls.some(call=>call.kind==='prepare'&&call.route==='/update'),false);
  assert.match(f.errors[0],/Save or discard/);
});

test('typing while Apply waits in the service queue stops the source write',async t=>{
  const options={},f=await fixture(t,options);await f.command('open');
  options.onRequestQueue=doc=>{doc.isDirty=true;};
  await assert.rejects(f.panelCallbacks.onApply({revision:1}),/Save or discard/);
  assert.equal(f.calls.some(call=>call.kind==='request'&&call.route==='/apply'),false);
});

test('source typing retains decorations until the new projection is ready',async t=>{
  const f=await fixture(t);await f.command('open');
  const clears=f.calls.filter(call=>call.kind==='clear-decorations').length;
  f.events['document-change']({document:f.doc});
  assert.equal(f.calls.filter(call=>call.kind==='clear-decorations').length,clears);
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
  assert.match(f.errors[0],/Save or discard your manuscript edits/);
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

test('native comparison chooses pinned commits and the saved working tree',async t=>{
  const base='1'.repeat(40),f=await fixture(t,{inspect:{references:[{name:'origin/main',revision:base,subject:'Starting manuscript'}],commits:[{subject:'Revision',short:'2222222',date:'2026-10-08',revision:'2'.repeat(40)}]},pick:items=>items[0]});
  await f.command('compare');
  const comparison=f.calls.find(call=>call.kind==='prepare'&&call.route==='/prepare');
  assert.deepEqual(JSON.parse(JSON.stringify(comparison.body)),{repo:f.repo,base,base_label:'origin/main',proposed:'working',entry:'main.tex'});
  assert.deepEqual(f.calls.filter(call=>call.kind==='pick').map(call=>call.configuration.title),['Compare from','Compare to']);
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,1);
});

test('commit comparison refuses unsaved working files and cancelled endpoints',async t=>{
  const options={inspect:{references:[{name:'main',revision:'1'.repeat(40)}]},pick:items=>items[0]},f=await fixture(t,options);
  f.doc.isDirty=true;await f.command('compare');
  assert.match(f.errors[0],/Save or discard/);
  assert.equal(f.calls.some(call=>call.kind==='prepare'),false);
  f.doc.isDirty=false;options.pick=()=>undefined;await f.command('compare');
  assert.equal(f.errors.length,1);assert.equal(f.calls.some(call=>call.kind==='prepare'),false);
});

test('GitHub clone opens the cloned folder without preparing a review in the old workspace',async t=>{
  const f=await fixture(t,{input:'https://github.com/author/manuscript',folder:['/chosen'],clonedRepo:'/chosen/manuscript'});
  await f.command('clone');
  const clone=f.calls.find(call=>call.kind==='prepare');
  assert.equal(clone.route,'/clone');assert.deepEqual(JSON.parse(JSON.stringify(clone.body)),{url:'https://github.com/author/manuscript',directory:'/chosen'});
  assert.equal(f.calls.find(call=>call.name==='vscode.openFolder').args[0].fsPath,'/chosen/manuscript');
  assert.equal(f.calls.some(call=>call.kind==='open'),false);
});

test('Setup installs the extension skill using the exact backend interpreter',async t=>{
  const f=await fixture(t,{pick:items=>items.find(item=>item.agent==='codex')});await f.command('setup');
  assert.equal(f.calls.find(call=>call.kind==='prepare-tools').python,'/python');
  assert.equal(f.calls.find(call=>call.kind==='install-skill').agent,'codex');
  assert.equal(f.calls.find(call=>call.kind==='information').message,'Skill installed.');
  assert.equal(f.runtime.review,undefined);
});

test('the native library groups rounds by manuscript before opening its history',async t=>{
  const f=await fixture(t,{pick:items=>items[0]});
  const library=f.runtime.library;
  f.runtime.library=(route,body)=>route==='/library-data'?{reviews:[
    {id:reviewId,repo:f.repo,created:'2026-10-08',base_label:'B',proposal_label:'P'},
    {id:'b'.repeat(24),repo:f.repo,created:'2026-10-07',base_label:'B',proposal_label:'First'}]}:library(route,body);
  await f.command('library');
  const picks=f.calls.filter(call=>call.kind==='pick');
  assert.equal(picks[0].items.length,1);assert.equal(picks[0].items[0].repo,f.repo);
  assert.deepEqual(Array.from(picks[1].items,item=>item.label),['Round 2','Round 1']);
  assert.equal(f.runtime.review.id,reviewId);
});

test('saved drafts open an exact native editor copy without changing source or clearing the draft',async t=>{
  const f=await fixture(t,{drafts:{'main.tex':{text:'A retained draft.\n',source:'1'.repeat(40)}},pick:items=>items[0]});
  await f.command('open');await f.command('sourceDrafts');
  const document=f.calls.find(call=>call.kind==='document');
  assert.equal(document.content,'A retained draft.\n');assert.equal(document.language,'latex');
  assert.equal(f.calls.some(call=>call.kind==='request'&&call.route==='/draft'),false);
  assert.equal(await readFile(f.source,'utf8'),'A manuscript sentence.\n');
});

test('discarding a saved draft pins the review revision and refreshes native comments',async t=>{
  const f=await fixture(t,{drafts:{'main.tex':{text:'A retained draft.\n',source:'1'.repeat(40)}},pick:items=>typeof items[0]==='string'?items[1]:items[0]});
  await f.command('open');await f.command('sourceDrafts');
  const discard=f.calls.find(call=>call.kind==='request'&&call.route==='/draft');
  assert.deepEqual(JSON.parse(JSON.stringify(discard.body)),{revision:1,id:'main.tex',draft:null});
  assert.equal(f.calls.some(call=>call.kind==='panel-refresh'),true);
});

test('agent result links open the exact round after saving pending focused comments',async t=>{
  const f=await fixture(t),nextId='b'.repeat(24);
  await f.events.uri({path:'/review/'+nextId});
  assert.equal(f.runtime.review.id,nextId);
  assert.ok(f.calls.findIndex(call=>call.kind==='flush')<f.calls.findIndex(call=>call.kind==='open'));
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,1);
  await f.events.uri({path:'/review/../../outside'});assert.equal(f.calls.filter(call=>call.kind==='open').length,1);
});

test('Setup opens the bundled guide without relying on package metadata filename casing',async t=>{
  const f=await fixture(t,{pick:items=>items[0]});await f.command('setup');
  assert.equal(f.calls.find(call=>call.name==='markdown.showPreview').args[0].fsPath,path.join('/test/extension','dist/README.md'));
});

test('Setup can retry a failed interpreter without opening the library',async t=>{
  const options={config:{pythonPath:'/missing/python'},onToolsSetup:config=>{if(config.python==='/missing/python')throw new Error('Missing interpreter.');}},f=await fixture(t,options);
  await f.command('setup');assert.match(f.errors[0],/Missing interpreter/);
  options.config.pythonPath='/correct/python';await f.command('setup');
  assert.equal(f.calls.filter(call=>call.kind==='create-agent-tools').length,2);
  assert.equal(f.calls.some(call=>call.kind==='library'),false);
});

test('an exact agent result link waits for an existing Open operation then selects its own round',async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{onFlush:async()=>{entered();await gate;}}),nextId='b'.repeat(24);
  const opening=f.command('open');await began;
  const result=f.events.uri({path:'/review/'+nextId});release();await opening;await result;
  assert.equal(f.runtime.review.id,nextId);
  assert.deepEqual(f.calls.filter(call=>call.kind==='open').map(call=>call.id),[reviewId,nextId]);
});

test('saved review import selects the imported round through the shared library operation',async t=>{
  const f=await fixture(t,{folder:['/exports/review.json']});await f.command('import');
  assert.equal(f.calls.find(call=>call.kind==='library'&&call.route==='/import').body.source,'/exports/review.json');
  assert.equal(f.runtime.review.id,reviewId);assert.equal(f.calls.some(call=>call.kind==='show-review'),true);
});

test('an unrelated command error cannot dispose the healthy runtime while Open is pending',async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{workshop:false,onFlush:async()=>{entered();await gate;}});
  const opening=f.command('open');await began;await f.command('livePDF');
  assert.match(f.errors[0],/Install LaTeX Workshop/);
  assert.equal(f.calls.some(call=>call.kind==='dispose-runtime'),false);
  release();await opening;assert.equal(f.runtime.review.id,reviewId);
});
