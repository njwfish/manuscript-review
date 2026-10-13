import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeReview} from '../src/native-review.mjs';

function fixture(options={}){
 const callbacks={},commands=new Map(),calls=[],errors=[],docs=new Map();
 const files=[{path:'main.tex',before:'A old then small sentence.',after:'A new then clear sentence.',edits:[{id:'first',old:'old',new:'new',from:2,to:5},{id:'second',old:'small',new:'clear',from:11,to:16}]}];
 if(options.multiple)files.push({path:'other.tex',before:'Old.',after:'New.',edits:[{id:'third',old:'Old',new:'New',from:0,to:3}]});
 for(const file of files){file.hunks=[{id:'passage-'+file.path,edits:file.edits}];docs.set(file.path,{text:file.after,isDirty:false,positionAt:x=>x,offsetAt:x=>x,getText(){return this.text;}});}
 const editor={document:docs.get('main.tex'),selection:{active:2},revealRange(){}};
 const runtime={review:{id:'review',revision:1},async data(){calls.push('data');return data;},async request(route,body){calls.push({route,body});await options.saving?.();this.review.revision++;data={...data,revision:this.review.revision,decisions:body.decisions};return {revision:this.review.revision};}};
 let data={id:'review',revision:1,decisions:{},comments:{thread:'Keep context.'},files};
 const disposable=()=>({dispose(){}}),status={hide(){this.visible=false;},show(){this.visible=true;},dispose(){}};
 const vscode={StatusBarAlignment:{Right:2},TextEditorRevealType:{InCenterIfOutsideViewport:2},TextEditorSelectionChangeKind:{Mouse:2,Keyboard:1},TextDocumentChangeReason:{Undo:1,Redo:2},
  EventEmitter:class{event=disposable;fire(){}dispose(){}},Selection:class{constructor(start,end){Object.assign(this,{start,end,active:end});}},Range:class{constructor(start,end){Object.assign(this,{start,end});}},CodeLens:class{constructor(range,command){Object.assign(this,{range,command});}},
  languages:{registerCodeLensProvider(_selector,provider){callbacks.provider=provider;return disposable();}},
  window:{activeTextEditor:editor,createStatusBarItem:()=>status,onDidChangeTextEditorSelection(fn){callbacks.selection=fn;return disposable();},onDidChangeActiveTextEditor(fn){callbacks.active=fn;return disposable();}},
  workspace:{onDidChangeTextDocument(fn){callbacks.change=fn;return disposable();}},commands:{registerCommand(name,fn){commands.set(name,fn);return disposable();}}};
 const sourceEdits={flush:async()=>options.flushing?.()},delivery={flush:async()=>{},refresh:async options=>{calls.push({delivery:options});for(const file of files){const doc=docs.get(file.path);doc.text=file.after;for(const edit of [...file.edits].reverse())if(data.decisions[edit.id]==='reject')doc.text=doc.text.slice(0,edit.from)+edit.old+doc.text.slice(edit.to);}}};
 let controls;
 function update(){const file=files.find(file=>docs.get(file.path)===editor.document);controls.update({document:editor.document,reviewId:data.id,file:file.path,revision:data.revision,text:editor.document.text,ranges:file.edits.map(edit=>({id:edit.id,from:edit.from,to:edit.to}))},data);}
 controls=createNativeReview(vscode,{runtime:()=>runtime,sourceEdits:()=>sourceEdits,delivery:()=>delivery,enabled:()=>options.enabled!==false,
  async onOpen({file,edit}){calls.push({open:[file,edit]});editor.document=docs.get(file);callbacks.active();editor.selection.active=files.find(item=>item.path===file).edits.find(item=>item.id===edit)?.from??0;update();return editor;},
  onChange:async()=>{calls.push('changed');update();},onFocus:(file,edit,_selected,mode)=>calls.push({focus:[file,edit],mode}),onMode:mode=>calls.push({mode}),onError:error=>errors.push(error.message)});
 update();calls.length=0;
 return {controls,doc:editor.document,editor,runtime,get data(){return data;},vscode,calls,errors,callbacks,status,decide:(...args)=>commands.get('manuscriptReview.decideSource')(...args),lenses:()=>callbacks.provider.provideCodeLenses(editor.document)};
}

test('native controls use the single source delivery owner and immediately advance',async()=>{
 const f=fixture(),lenses=f.lenses();assert.deepEqual(lenses.map(lens=>lens.command.title),['Accept','Reject','Comment']);
 await f.decide(...lenses[1].command.arguments);
 assert.deepEqual(f.calls.filter(call=>call.route||call.delivery||call==='changed'),[{route:'/save',body:{revision:1,decisions:{first:'reject'},comments:{thread:'Keep context.'}}},{delivery:{force:true}},'changed']);
 assert.equal(f.doc.text,'A old then clear sentence.');assert.equal(f.editor.selection.active,11);assert.deepEqual(f.errors,[]);
});

test('dirty, stale, disabled and mismatched source controls cannot decide another wording',async()=>{
 for(const change of [f=>f.doc.isDirty=true,f=>f.runtime.review.revision++,f=>f.runtime.review.id='other',f=>f.doc.text='Changed elsewhere.']){
  const f=fixture(),arguments_=f.lenses()[0].command.arguments;change(f);await f.decide(...arguments_);
  assert.equal(f.calls.some(call=>call.route),false);assert.equal(f.errors.length,1);
 }
 const f=fixture({enabled:false});assert.deepEqual(f.lenses(),[]);
});

test('selection and decision remain pinned across pending canonical writes',async()=>{
 let f;f=fixture({flushing:()=>{f.runtime.review={id:'another',revision:1};}});
 await f.decide(...f.lenses()[0].command.arguments);assert.equal(f.calls.some(call=>call.route),false);
 const other=fixture({saving:()=>{other.runtime.review.id='another';}});
 await other.decide(...other.lenses()[0].command.arguments);assert.equal(other.calls.some(call=>call.delivery),false);assert.equal(other.errors.length,1);
});

test('focus synchronization is once per edit and mouse editing exits keyboard review',async()=>{
 const f=fixture();f.callbacks.selection();f.callbacks.selection();assert.equal(f.calls.filter(call=>call.focus).length,0);
 await f.controls.begin();assert.ok(f.calls.some(call=>call.focus&&call.mode));
 f.callbacks.selection({kind:f.vscode.TextEditorSelectionChangeKind.Mouse});assert.equal(f.calls.filter(call=>call.mode!==undefined).at(-1).mode,false);
 f.controls.clear();assert.deepEqual(f.lenses(),[]);f.controls.dispose();
});

test('same-file navigation uses the cached projection and wraps without a service read',async()=>{
 const f=fixture();await f.controls.begin();await f.controls.move(1);assert.equal(f.editor.selection.active,11);
 await f.controls.move(1);assert.equal(f.editor.selection.active,2);
 await f.controls.move(-1);assert.equal(f.editor.selection.active,11);assert.equal(f.calls.includes('data'),false);assert.equal(f.calls.some(call=>call.open),false);
});

test('rapid decisions serialize and advance across files without overwriting choices',async()=>{
 const f=fixture({multiple:true});await f.controls.begin();await Promise.all([f.controls.decide('accept'),f.controls.decide('reject'),f.controls.decide('accept')]);
 assert.deepEqual(f.data.decisions,{first:'accept',second:'reject',third:'accept'});assert.deepEqual(f.errors,[]);assert.equal(f.status.text,'Reviewed');
 assert.equal(f.calls.filter(call=>call.mode!==undefined).at(-1).mode,false);
});

test('passage and file choices preserve other files and reset restores a single undecided edit',async()=>{
 const f=fixture({multiple:true});await f.controls.decide('reject','passage');assert.deepEqual(f.data.decisions,{first:'reject',second:'reject'});
 await f.controls.move(-1);await f.controls.decide('reset');assert.deepEqual(f.data.decisions,{first:'reject'});
 await f.controls.decide('accept','file');assert.deepEqual(f.data.decisions,{first:'accept',second:'accept'});assert.deepEqual(f.errors,[]);
});

test('moving the cursor during a saved decision cancels automatic advance',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=fixture({saving:async()=>{entered();await gate;}}),pending=f.controls.decide('accept');await started;
 f.editor.selection.active=0;f.callbacks.selection({kind:f.vscode.TextEditorSelectionChangeKind.Keyboard});release();await pending;
 assert.equal(f.editor.selection.active,0);assert.deepEqual(f.errors,[]);
});

test('native Undo and explicit editing leave focused mode while retaining highlights',async()=>{
 const f=fixture();await f.controls.begin();f.callbacks.change({reason:f.vscode.TextDocumentChangeReason.Undo});
 assert.equal(f.calls.filter(call=>call.mode!==undefined).at(-1).mode,false);assert.equal(f.lenses().length,3);
});


test('switching to unrelated native source restores ordinary typing',async()=>{
 const f=fixture();await f.controls.begin();f.vscode.window.activeTextEditor={document:{},selection:{active:0}};f.callbacks.active();
 assert.equal(f.calls.filter(call=>call.mode!==undefined).at(-1).mode,false);assert.equal(f.controls.selection(),undefined);
});

test('editing while a decision saves cancels automatic navigation',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=fixture({saving:async()=>{entered();await gate;}});await f.controls.begin();const pending=f.controls.decide('accept');await started;
 f.controls.edit();release();await pending;assert.equal(f.editor.selection.active,2);
});

test('queued keyboard decisions never migrate into another review',async()=>{
 let release,entered,once=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=fixture({flushing:async()=>{if(once){once=false;entered();await gate;}}});
 const moving=f.controls.move(1);await started;const choosing=f.controls.decide('accept');
 f.controls.clear();f.runtime.review.id='another';release();await Promise.allSettled([moving,choosing]);
 assert.equal(f.calls.some(call=>call.route==='/save'),false);
});


test('leaving review cancels queued choices as well as pending auto-advance',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=fixture({saving:async()=>{entered();await gate;}});await f.controls.begin();const first=f.controls.decide('accept');await started;
 const second=f.controls.decide('reject');f.controls.edit();release();await Promise.all([first,second]);
 assert.deepEqual(f.data.decisions,{first:'accept'});assert.equal(f.editor.selection.active,2);
});

test('a same-revision projection refresh does not falsely refuse a pinned decision',async()=>{
 let f;f=fixture({flushing:()=>f.controls.update({document:f.doc,reviewId:'review',revision:1,file:'main.tex',text:f.doc.text,ranges:[{id:'first',from:2,to:5},{id:'second',from:11,to:16}]},{...f.data})});
 await f.controls.decide('reject');assert.deepEqual(f.data.decisions,{first:'reject'});assert.deepEqual(f.errors,[]);
});
