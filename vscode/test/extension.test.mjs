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
    builder.onResolve({filter:/^\.\/(runtime|comments|panel|decorations|agent|python|viewer-server|dispatch|sidebar)\.mjs$/},args=>({path:'test-'+args.path.slice(2,-4),external:true}));
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
  const editor={document:doc,viewColumn:1,selection:new Selection(new Position(0,0),new Position(0,1)),revealRange(range){this.revealed=range;}};
  const disposable=()=>({dispose(){}});
  function event(name){return callback=>{events[name]=callback;return disposable();};}
  const vscode={Uri:{file:uri},Selection,QuickPickItemKind:{Separator:-1},ViewColumn:{One:1},ProgressLocation:{Notification:15},TextEditorRevealType:{InCenterIfOutsideViewport:2},env:{clipboard:{async writeText(text){calls.push({kind:'clipboard',text});}}},
    RelativePattern:class{constructor(base,pattern){Object.assign(this,{base,pattern});}},
    commands:{registerCommand(name,callback){handlers.set(name,callback);return {dispose(){handlers.delete(name);}};},
      async executeCommand(name,...args){calls.push({kind:'command',name,args});if(name==='setContext')contexts.set(args[0],args[1]);}},
    workspace:{isTrusted:options.trusted??true,workspaceFolders:[{uri:uri(repo)}],textDocuments:[doc],
      getConfiguration:()=>({get:(key,fallback)=>options.config?.[key]??fallback}),
      getWorkspaceFolder:()=>({uri:uri(repo)}),
      async openTextDocument(requested){calls.push({kind:'document',file:requested.fsPath,content:requested.content,language:requested.language});if(requested.content!==undefined)return {uri:{scheme:'untitled'},getText:()=>requested.content};assert.equal(requested.fsPath,source);return doc;},
      createFileSystemWatcher(pattern){const watcher={pattern,onDidChange:event('record-change'),onDidCreate:event('record-create'),dispose(){this.disposed=true;}};watchers.push(watcher);return watcher;},
      onDidChangeTextDocument:event('document-change'),onDidSaveTextDocument:event('document-save')},
    window:{setStatusBarMessage(message){calls.push({kind:'status',message});},activeTextEditor:options.active===false?undefined:editor,visibleTextEditors:[editor],tabGroups:{activeTabGroup:{viewColumn:1}},
      registerTreeDataProvider(id,provider){calls.push({kind:'view',id,provider});return disposable();},
      createOutputChannel:()=>({appendLine:text=>output.push(text),dispose(){}}),
      async showErrorMessage(message){errors.push(message);},
      async showInformationMessage(message){calls.push({kind:'information',message});},
      async showInputBox(configuration){calls.push({kind:'input',configuration});return options.input;},
      async withProgress(configuration,action){calls.push({kind:'progress',configuration});return action();},
      async showOpenDialog(configuration){calls.push({kind:'folder',configuration});return options.folder?.map(uri);},
      registerUriHandler(handler){events.uri=handler.handleUri;return disposable();},
      async showQuickPick(items,configuration){calls.push({kind:'pick',items,configuration});return options.pick?.(items,configuration);},
      createQuickPick(){
        const handlers={},picker={onDidAccept:fn=>listen('accept',fn),onDidHide:fn=>listen('hide',fn),
          show(){calls.push({kind:'pick',items:this.items,configuration:{title:this.title}});const item=options.pick?.(this.items,{title:this.title});if(item===undefined)this.hide();else{this.selectedItems=[item];handlers.accept();}},
          hide(){handlers.hide();},dispose(){}};
        function listen(name,fn){handlers[name]=fn;return {dispose(){delete handlers[name];}};}return picker;
      },
      async showTextDocument(document,configuration){calls.push({kind:'show-source',document,configuration});this.activeTextEditor=editor;return editor;},
      onDidChangeVisibleTextEditors:event('visible-change'),onDidChangeActiveTextEditor:event('active-change'),onDidChangeTextEditorSelection:event('selection-change')},
    extensions:{getExtension(id){calls.push({kind:'extension',id});return options.workshop===false?undefined:{async activate(){calls.push({kind:'activate-workshop'});}};}}};
  let selected,panelCallbacks,commentsCallbacks,preparedRepo;
  const runtime={get review(){return selected?{...selected}:undefined;},
    async library(route,body){calls.push({kind:'library',route,body});if(route==='/import')return {review:reviewId};return route==='/inspect'
      ?{repo,base:'1'.repeat(40),head:'2'.repeat(40),entries:options.entries||['main.tex'],...options.inspect}: {reviews:typeof options.reviews==='function'?options.reviews(repo):options.reviews||[]};},
    async prepare(route,body){calls.push({kind:'prepare',route,body});if(body.repo)preparedRepo=body.repo;return route==='/clone'?{repo:options.clonedRepo}:{review:reviewId};},
    async open(id){calls.push({kind:'open',id});selected={id,repo:preparedRepo||repo,revision:1,feedback_path:record};return {files:options.files??[{edits:[{id:'edit'}]}]};},
    async data(){return {id:selected.id,repo:selected.repo,workspace:selected.workspace,workspace_version:selected.workspace_version,revision:selected.revision,base:'1'.repeat(40),proposed:'2'.repeat(40),base_label:'Starting draft',proposal_label:'Proposal',entry:'main.tex',files:options.files??[{edits:[{id:'edit'}]}],decisions:{},comments:{},history:[],resolved:[],drafts:options.drafts||{}};},
    async request(route,body,checkSource){await options.onRequestQueue?.(doc);if(route==='/apply')checkSource();calls.push({kind:'request',route,body});if(route==='/workspace'){selected.workspace=options.workspace||selected.repo;selected.workspace_version='2'.repeat(40);return {revision:1,workspace:selected.workspace,workspace_version:selected.workspace_version};}if(route==='/capture')return {revision:2};if(route==='/agent')return {message:'Sent in the background',discussion:body.id};if(route==='/apply')return {applied:true,revision:2};if(route==='/draft')return {revision:2};assert.equal(route,'/editor');
      await options.onProjectionRequest?.(doc,runtime);return {position:12,ranges:[],notes:[]};},
    async dispose(){calls.push({kind:'dispose-runtime'});}};
  const panel={setAgent(label){calls.push({kind:'panel-agent',label});},async flush(flushOptions){calls.push({kind:'flush',options:flushOptions});await options.onFlush?.(doc);return flushOptions?.lock?'lock':undefined;},unlock(id){if(id)calls.push({kind:'unlock',id});},async show(entry){calls.push({kind:'show-review',entry});options.onPanelShow?.(vscode);},
    async refresh(options){calls.push({kind:'panel-refresh',options});},changed(){calls.push({kind:'panel-change'});},dispose(){calls.push({kind:'dispose-panel'});}};
  const comments={setEnabled(enabled){calls.push({kind:'comments-enabled',enabled});},setAgent(label){calls.push({kind:'comment-agent',label});},async refresh(){calls.push({kind:'comments-refresh'});},async annotate(editor){await commentsCallbacks.onSource(editor.document);calls.push({kind:'annotate',editor});},
    async move(direction){calls.push({kind:'move',direction});},dispose(){calls.push({kind:'dispose-comments'});}};
  const {sourceFile,sourceDocument}=await import('../src/comments.mjs');
  let sidebarCallbacks;
  const adapters={
    'test-sidebar':{createSidebar(_vscode,_context,callbacks){sidebarCallbacks=callbacks;return {async refresh(){calls.push({kind:'sidebar-refresh'});},async show(){calls.push({kind:'sidebar-show'});},dispose(){}};},sidebarState:(...values)=>values},
    'test-dispatch':{agents:[{id:'codex',label:'Codex'},{id:'claude',label:'Claude Code'}],openAgent:async(_vscode,launch)=>{calls.push({kind:'open-agent',options:launch});options.onOpenAgent?.(_vscode,launch);return options.agentSent;}},
    'test-viewer-server':{createViewer(){return {start:async()=> 'http://127.0.0.1:23456',dispose:async()=>{calls.push({kind:'dispose-viewer'});}};}},
    'test-python':{async resolvePython(configured){calls.push({kind:'resolve-python',configured});await options.onResolvePython?.(configured);return configured||'/automatic/python';}},
    'test-agent':{createAgentTools(configuration){calls.push({kind:'create-agent-tools',configuration});return {launcher:'/stored/skills/manuscript-review/scripts/review-agent',command:"'/stored/skills/manuscript-review/scripts/review-agent'",skill:'/stored/skills/manuscript-review',async setup(){await options.onToolsSetup?.(configuration);calls.push({kind:'prepare-tools',python:'/python'});return {python:'/python',git:true,preview_tools:{},agents:[{id:'codex',name:'Codex'}]};},async install(agent){calls.push({kind:'install-skill',agent});return {message:'Skill installed.'};}};}},
    'test-runtime':{createRuntime(configuration){calls.push({kind:'create-runtime',configuration});return runtime;}},
    'test-panel':{createPanel(_vscode,_context,_runtime,callbacks){panelCallbacks=callbacks;return panel;}},
    'test-comments':{sourceFile,sourceDocument,createComments(_vscode,_runtime,callbacks){commentsCallbacks=callbacks;return comments;}},
    'test-decorations':{createDecorations(){return {setEnabled(enabled){calls.push({kind:'highlights-enabled',enabled});},update(){calls.push({kind:'decorate'});},focus(file,edit){calls.push({kind:'focus-source',file,edit});},reveal(){calls.push({kind:'reveal-source'});},clear(){calls.push({kind:'clear-decorations'});},dispose(){}};}}
  };
  const preferences=new Map([['commentAgent',options.agent],...(options.commentsEnabled===undefined?[]:[['commentsEnabled',options.commentsEnabled]])]);
  const module={exports:{}},context={globalState:{get:(key,fallback)=>preferences.has(key)?preferences.get(key):fallback,async update(key,value){preferences.set(key,value);}},extensionPath:'/test/extension',globalStorageUri:uri(path.join(directory,'storage')),extension:{packageJSON:{version:'0.1.2'}},subscriptions:[]};
  context.workspaceState=context.globalState;
  vm.runInNewContext(await bundle,{exports:module.exports,module,require:name=>name==='vscode'?vscode:adapters[name]||nativeRequire(name),process,AbortController,setTimeout,clearTimeout,console},{filename:'extension.cjs'});
  module.exports.activate(context);await new Promise(resolve=>setImmediate(resolve));t.after(()=>module.exports.deactivate());
  return {vscode,runtime,doc,editor,source,repo,calls,errors,contexts,events,watchers,deactivate:()=>module.exports.deactivate(),
    command:(name,...args)=>handlers.get('manuscriptReview.'+name)(...args),
    get sidebarCallbacks(){return sidebarCallbacks;},get panelCallbacks(){return panelCallbacks;},get commentsCallbacks(){return commentsCallbacks;}};
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
  assert.deepEqual(f.calls.filter(call=>call.kind==='request').map(call=>call.route),['/workspace']);
});

test('choosing among multiple root documents forwards the selected entry',async t=>{
  const f=await fixture(t,{entries:['paper.tex','supplement.tex'],pick:items=>items[1]});
  await f.command('open');
  assert.equal(f.calls.find(call=>call.kind==='prepare').body.entry,'supplement.tex');
  assert.equal(f.calls.filter(call=>call.kind==='pick').length,1);
});

test('initial annotation prepares comments without a round picker or taking native editor focus',async t=>{
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

test('a native Save captures the same review and refreshes without revealing source or focused panels',async t=>{
 const f=await fixture(t);await f.command('open');
 const shown=f.calls.filter(call=>call.kind==='show-source'||call.kind==='show-review').length;
 f.doc.text='Author saved wording.';f.doc.version++;
 await f.events['document-save'](f.doc);
 const request=f.calls.find(call=>call.kind==='request'&&call.route==='/capture');
 assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{file:'main.tex',text:f.doc.text,source:'2'.repeat(40)});
 assert.equal(f.calls.filter(call=>call.kind==='show-source'||call.kind==='show-review').length,shown);
 assert.equal(f.calls.some(call=>call.kind==='prepare'&&call.route==='/update'),false);
 assert.equal(f.runtime.review.id,reviewId);assert.deepEqual(f.errors,[]);
});

test('deactivation waits for the native Save capture before stopping its service',async t=>{
 const options={},f=await fixture(t,options);await f.command('open');
 let entered,release;const capturing=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 options.onRequestQueue=async()=>{entered();await gate;};
 f.doc.text='Saved before reload.';f.doc.version++;
 const saved=f.events['document-save'](f.doc);await capturing;
 const closing=f.deactivate();
 assert.equal(f.calls.some(call=>call.kind==='dispose-runtime'),false);
 release();await Promise.all([saved,closing]);
 assert.ok(f.calls.findIndex(call=>call.route==='/capture')<f.calls.findIndex(call=>call.kind==='dispose-runtime'));
});

test('the editing folder command opens B as a normal folder in another window',async t=>{
 const f=await fixture(t,{workspace:'/editing/sourceB'});await f.command('open');
 await f.command('editingFolder');
 const call=f.calls.find(call=>call.kind==='command'&&call.name==='vscode.openFolder');
 assert.equal(call.args[0].fsPath,'/editing/sourceB');assert.equal(call.args[1].forceNewWindow,true);
});

test('source navigation maps the exact dirty native buffer without saving it',async t=>{
  const f=await fixture(t);await f.command('open');
  f.doc.text='🧬 A dirty manuscript sentence.\n';f.doc.version++;f.doc.isDirty=true;
  await f.panelCallbacks.onSource({file:'main.tex',position:8});
  const request=f.calls.find(call=>call.kind==='request'&&call.route==='/editor');
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
  assert.deepEqual(f.calls.filter(call=>call.kind==='request').map(call=>call.route),['/workspace']);
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
  const f=await fixture(t,{commentsEnabled:false});const starts=f.calls.filter(call=>call.kind==='create-runtime').length;await f.command('livePDF');
  assert.equal(f.calls.filter(call=>call.kind==='create-runtime').length,starts);
  assert.equal(f.calls.find(call=>call.kind==='extension').id,'James-Yu.latex-workshop');
  assert.equal(f.calls.some(call=>call.kind==='activate-workshop'),true);
  assert.equal(f.calls.some(call=>call.kind==='command'&&call.name==='latex-workshop.synctex'),true);
});

test('review shortcuts and the comment context menu require the active manuscript source',async()=>{
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(manifest.contributes.keybindings.filter(binding=>!binding.when.includes('commentEditorFocused')).every(binding=>binding.when.includes('manuscriptReview.source')),true);
  const enter=manifest.contributes.keybindings.find(binding=>binding.key==='enter');assert.match(enter.when,/commentController == manuscript-review/);assert.match(enter.when,/!inComposition/);
  const actions=manifest.contributes.menus['comments/commentThread/context'];assert.equal(actions.find(item=>item.group==='inline@0').command,'manuscriptReview.sendComment');
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
  await f.sidebarCallbacks.load();await f.sidebarCallbacks.onAction('review');
  const comparison=f.calls.find(call=>call.kind==='prepare'&&call.route==='/prepare');
  assert.deepEqual(JSON.parse(JSON.stringify(comparison.body)),{repo:f.repo,base,base_label:'origin/main',proposed:'working',proposed_label:'Working files',entry:'main.tex'});
  assert.equal(f.calls.some(call=>call.kind==='pick'),false);
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,1);
});

test('commit comparison refuses unsaved working files and cancelled endpoints',async t=>{
  const options={inspect:{references:[{name:'main',revision:'1'.repeat(40)}]},pick:items=>items[0]},f=await fixture(t,options);
  f.doc.isDirty=true;await f.command('compare');await f.sidebarCallbacks.load();
  await assert.rejects(f.sidebarCallbacks.onAction('review'),/Save or discard/);
  assert.equal(f.calls.some(call=>call.kind==='prepare'),false);
  assert.equal(f.errors.length,0);
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
  const options={active:false,commentsEnabled:false,config:{pythonPath:'/missing/python'},onToolsSetup:config=>{if(config.python==='/missing/python')throw new Error('Missing interpreter.');}},f=await fixture(t,options);
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

test('the sidebar registers on activation and the toolbar opens an unchanged manuscript',async t=>{
  const f=await fixture(t,{files:[]});
  assert.ok(f.sidebarCallbacks);
  assert.equal(f.calls.some(call=>call.kind==='sidebar-show'),false);
  await f.command('review',uri(f.source));
  assert.equal(f.runtime.review.id,reviewId);
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,1);
  assert.equal(await readFile(f.source,'utf8'),'A manuscript sentence.\n');
});

test('the toolbar follows its source resource in another editor group and reuses the active round',async t=>{
  const f=await fixture(t);await f.command('open');
  f.vscode.window.activeTextEditor=undefined;await f.command('review',uri(f.source));
  assert.equal(f.calls.filter(call=>call.kind==='open').length,1);
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,2);
  const other=path.join(f.repo,'../another/main.tex');await f.command('review',uri(other));
  assert.equal(f.calls.filter(call=>call.kind==='library'&&call.route==='/inspect').at(-1).body.repo,path.dirname(other));
});

test('cancelling the toolbar round picker preserves the existing review without opening it for another manuscript',async t=>{
  const f=await fixture(t);await f.command('open');const shown=f.calls.filter(call=>call.kind==='show-review').length;
  const other=path.join(f.repo,'../another'),library=f.runtime.library;
  f.runtime.library=(route,body)=>route==='/inspect'?{repo:other,entries:['main.tex']}:route==='/library-data'?{reviews:[{id:'b'.repeat(24),repo:other}]}:library(route,body);
  await f.command('review',uri(path.join(other,'main.tex')));
  assert.equal(f.runtime.review.id,reviewId);
  assert.equal(f.calls.filter(call=>call.kind==='show-review').length,shown);
  assert.equal(f.calls.filter(call=>call.kind==='open').length,1);
});


test('closing during interpreter discovery cannot start a review service afterwards',async t=>{
 let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{onResolvePython:()=>new Promise(resolve=>{release=resolve;entered();})});
 const opening=f.command('open');await started;const closing=f.deactivate();release();
 await Promise.all([opening,closing]);
 assert.equal(f.calls.some(call=>call.kind==='create-runtime'||call.kind==='show-review'),false);
 assert.deepEqual(f.errors,[]);
});

test('concurrent startup shares one interpreter discovery and the same executable',async t=>{
 let release,entered;
 const started=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{onResolvePython:()=>new Promise(resolve=>{release=resolve;entered();})});
 const opening=f.command('open');await started;const setup=f.command('setup');release();
 await Promise.all([opening,setup]);
 assert.equal(f.calls.filter(call=>call.kind==='resolve-python').length,1);
 assert.equal(f.calls.filter(call=>call.kind==='create-runtime').length,1);
 assert.equal(f.calls.find(call=>call.kind==='create-runtime').configuration.python,f.calls.find(call=>call.kind==='create-agent-tools').configuration.python);
 assert.deepEqual(f.errors,[]);
});


test('comment dispatch saves the note and starts the selected CLI without touching tabs or editor focus',async t=>{
 const f=await fixture(t,{agent:'claude'});await f.command('open');f.doc.isDirty=true;
 const before=f.vscode.window.activeTextEditor;
 assert.equal(await f.commentsCallbacks.onAgent('saved-comment'),true);
 const request=f.calls.find(call=>call.kind==='request'&&call.route==='/agent');
 assert.equal(request.body.id,'saved-comment');assert.equal(request.body.revision,f.runtime.review.revision);
 assert.equal(request.body.agent,'claude');assert.equal(f.doc.isDirty,true);
 assert.ok(f.calls.findIndex(call=>call.kind==='flush')<f.calls.indexOf(request));
 assert.equal(f.vscode.window.activeTextEditor,before);assert.equal(f.calls.some(call=>call.kind==='open-agent'||call.kind==='show-source'),false);
});

test('repeated sends may run independently after each background handoff',async t=>{
 const f=await fixture(t);await f.command('open');
 await f.commentsCallbacks.onAgent('first');await f.commentsCallbacks.onAgent('second');
 assert.deepEqual(f.calls.filter(call=>call.kind==='request'&&call.route==='/agent').map(call=>call.body.id),['first','second']);
});

test('review highlights switch off independently of comments and remain off across source refreshes',async t=>{
 const f=await fixture(t);await f.command('open');await f.command('toggleHighlights');
 assert.equal(f.calls.filter(call=>call.kind==='highlights-enabled').at(-1).enabled,false);
 assert.equal(f.calls.filter(call=>call.kind==='comments-enabled').at(-1).enabled,true);
 await f.command('refresh');assert.equal(f.calls.filter(call=>call.kind==='highlights-enabled').at(-1).enabled,false);
 await f.command('toggleHighlights');assert.equal(f.calls.filter(call=>call.kind==='highlights-enabled').at(-1).enabled,true);
});

test('a comment sent while navigation waits cannot move silently into another round',async t=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 const options={pick:items=>items[0]},f=await fixture(t,options);await f.command('open');
 options.onFlush=async()=>{entered();await gate;};
 const navigation=f.events.uri({path:'/review/'+'b'.repeat(24)});await began;
 const sending=assert.rejects(f.commentsCallbacks.onAgent('retained-comment'),/review changed/i);
 release();await navigation;await sending;
 assert.equal(f.calls.some(call=>call.kind==='open-agent'),false);
});

test('focused review dims context and entering the manuscript editor reveals it',async t=>{
 const f=await fixture(t);await f.command('open');f.panelCallbacks.onFocus('main.tex','edit');
 assert.equal(f.calls.at(-1).kind,'focus-source');
 f.events['selection-change']({textEditor:f.editor});assert.equal(f.calls.at(-1).kind,'reveal-source');
});


test('native save-and-send flushes focused drafts before saving the comment and refreshes afterward',async t=>{
 const f=await fixture(t,{pick:items=>items[0]});await f.command('open');
 await f.commentsCallbacks.onAgent(undefined,async()=>{f.calls.push({kind:'save-comment'});return 'new-comment';});
 const flush=f.calls.findLastIndex(call=>call.kind==='flush'),save=f.calls.findIndex(call=>call.kind==='save-comment'),refresh=f.calls.findIndex(call=>call.kind==='panel-refresh');
 assert.ok(flush<save&&save<refresh&&refresh<f.calls.findIndex(call=>call.kind==='request'&&call.route==='/agent'));
 assert.equal(f.calls.find(call=>call.kind==='request'&&call.route==='/agent').body.id,'new-comment');
 assert.equal(f.calls[refresh].options.flushed,true);
 assert.equal(f.calls[flush].options.lock,true);assert.ok(f.calls.findIndex(call=>call.kind==='unlock')>refresh);
});

test('a failed native comment save releases the pane and never opens an agent',async t=>{
 const f=await fixture(t,{pick:items=>items[0]});await f.command('open');
 await assert.rejects(f.commentsCallbacks.onAgent(undefined,async()=>{throw new Error('Comment was not saved.');}),/not saved/);
 assert.equal(f.calls.at(-1).kind,'unlock');assert.equal(f.calls.some(call=>call.kind==='open-agent'),false);
});

test('an overlapping native send cannot unlock the first comment save',async t=>{
 const f=await fixture(t,{pick:items=>items[0]});await f.command('open');
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 const first=f.commentsCallbacks.onAgent(undefined,async()=>{entered();await gate;return 'first-comment';});await began;
 await assert.rejects(f.commentsCallbacks.onAgent(undefined,async()=> 'second-comment'),/comment is still being sent/);
 assert.equal(f.calls.some(call=>call.kind==='unlock'),false);
 release();await first;assert.equal(f.calls.filter(call=>call.kind==='unlock').length,1);
 assert.equal(f.calls.find(call=>call.kind==='request'&&call.route==='/agent').body.id,'first-comment');
});

test('saved threads restore with new-comment controls disabled without opening focused review',async t=>{
 const f=await fixture(t,{commentsEnabled:false,reviews:repo=>[{id:reviewId,repo,workspace:repo}]});
 assert.equal(f.runtime.review.id,reviewId);assert.equal(f.contexts.get('manuscriptReview.source'),true);assert.equal(f.contexts.get('manuscriptReview.commentsEnabled'),false);
 assert.equal(f.calls.find(call=>call.kind==='comments-enabled').enabled,false);
 assert.equal(f.calls.some(call=>call.kind==='show-review'),false);
 assert.equal(f.calls.some(call=>call.kind==='prepare'),false);
 const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.ok(manifest.contributes.keybindings.find(binding=>binding.command==='manuscriptReview.comment').when.includes('manuscriptReview.commentsEnabled'));
 assert.ok(manifest.contributes.keybindings.filter(binding=>['manuscriptReview.previousComment','manuscriptReview.nextComment'].includes(binding.command)).every(binding=>!binding.when.includes('manuscriptReview.commentsEnabled')));
});

test('a late sidebar inspection cannot overwrite a newly opened round',async t=>{
 const f=await fixture(t);let release,entered,first=true;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),library=f.runtime.library;
 f.runtime.library=async(route,body)=>{
  if(route==='/inspect'&&first){first=false;entered();await gate;return {repo:'/stale/manuscript',base:'3'.repeat(40),entries:[]};}
  return library(route,body);
 };
 const stale=f.sidebarCallbacks.load();await started;
 await f.command('open');release();await stale;
 const [comparison,data]=await f.sidebarCallbacks.load();
 assert.equal(comparison.info.repo,f.repo);assert.equal(comparison.base.revision,data.base);assert.equal(comparison.proposed.revision,data.proposed);
});

test('a sidebar inspection failure cannot dispose the runtime owned by a pending Open',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{onFlush:async()=>{entered();await gate;}}),library=f.runtime.library;
 const opening=f.command('open');await started;
 let failing=true;f.runtime.library=async(route,body)=>{if(failing&&route==='/inspect'){failing=false;throw new Error('Inspection failed.');}return library(route,body);};
 await assert.rejects(f.sidebarCallbacks.load(),/Inspection failed/);
 assert.equal(f.calls.some(call=>call.kind==='dispose-runtime'),false);
 release();await opening;assert.equal(f.runtime.review.id,reviewId);assert.deepEqual(f.errors,[]);
});

test('opening another sidebar repository prepares its pair instead of reusing the current review',async t=>{
 const f=await fixture(t,{pick:items=>items[0]});await f.command('open');await f.sidebarCallbacks.load();
 const library=f.runtime.library;f.runtime.library=(route,body)=>route==='/inspect'
  ?{repo:'/another/paper',workspace:'/another/paper',base:'3'.repeat(40),entries:['paper.tex']}:library(route,body);
 await f.sidebarCallbacks.onAction('repository');await f.sidebarCallbacks.load();await f.sidebarCallbacks.onAction('review');
 assert.equal(f.calls.findLast(call=>call.kind==='prepare').body.repo,'/another/paper');
});

test('Apply refuses a stale sidebar even after pending saves have flushed',async t=>{
 const f=await fixture(t);await f.command('open');await f.sidebarCallbacks.load();
 await assert.rejects(f.sidebarCallbacks.onAction('apply',{review:reviewId,revision:0,folder:f.repo}),/review changed/i);
 assert.equal(f.calls.some(call=>call.route==='/apply'),false);
 await assert.rejects(f.sidebarCallbacks.onAction('apply',{review:'b'.repeat(24),revision:1,folder:f.repo}),/review changed/i);
 assert.equal(f.calls.some(call=>call.route==='/apply'),false);
});

test('Apply stays pinned to its review while a panel save is pending',async t=>{
 const options={},f=await fixture(t,options);await f.command('open');await f.sidebarCallbacks.load();
 options.onFlush=()=>f.runtime.open('b'.repeat(24));
 await assert.rejects(f.sidebarCallbacks.onAction('apply',{review:reviewId,revision:1,folder:f.repo}),/review changed/i);
 assert.equal(f.calls.some(call=>call.route==='/apply'),false);
});


test('Review changes rechecks its displayed round when queued navigation completes',async t=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 const options={},f=await fixture(t,options);await f.command('open');await f.sidebarCallbacks.load();
 options.onFlush=async()=>{entered();await gate;};
 const opening=f.events.uri({path:'/review/'+'b'.repeat(24)});await began;
 const pending=assert.rejects(f.sidebarCallbacks.onAction('review',{review:reviewId,folder:f.repo}),/(review|comparison) changed/i);
 release();await opening;await pending;
 assert.equal(f.runtime.review.id,'b'.repeat(24));
});
