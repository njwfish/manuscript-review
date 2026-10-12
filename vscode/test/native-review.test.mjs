import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeReview} from '../src/native-review.mjs';

function fixture(options={}){
 const callbacks={},commands=new Map(),calls=[],errors=[];
 const doc={text:'A new sentence.',isDirty:false,positionAt:x=>x,offsetAt:x=>x,getText(){return this.text;}};
 const editor={document:doc,selection:{active:2}},runtime={review:{id:'review',revision:1},async request(route,body){calls.push({route,body});await options.saving?.();return {revision:++this.review.revision};}};
 const vscode={EventEmitter:class{event=()=>({dispose(){}});fire(){}dispose(){}},Range:class{constructor(start,end){Object.assign(this,{start,end});}},CodeLens:class{constructor(range,command){Object.assign(this,{range,command});}},
  languages:{registerCodeLensProvider(_selector,provider){callbacks.provider=provider;return {dispose(){}};}},
  window:{activeTextEditor:editor,onDidChangeTextEditorSelection(fn){callbacks.selection=fn;return {dispose(){}};},onDidChangeActiveTextEditor:()=>({dispose(){}})},
  workspace:{onDidChangeTextDocument:()=>({dispose(){}})},commands:{registerCommand(name,fn){commands.set(name,fn);return {dispose(){}};}}};
 const sourceEdits={flush:async()=>options.flushing?.()},delivery={flush:async()=>{},refresh:async options=>calls.push({delivery:options})};
 const controls=createNativeReview(vscode,{runtime:()=>runtime,sourceEdits:()=>sourceEdits,delivery:()=>delivery,enabled:()=>options.enabled!==false,
  onChange:async()=>calls.push('changed'),onFocus:(file,edit)=>calls.push({focus:[file,edit]}),onError:error=>errors.push(error.message)});
 const data={id:'review',revision:1,decisions:{},comments:{thread:'Keep context.'},files:[{path:'main.tex',edits:[{id:'edit',old:'old',new:'new'}]}]};
 controls.update({document:doc,file:'main.tex',revision:1,text:doc.text,ranges:[{id:'edit',from:2,to:5}]},data);
 return {controls,doc,editor,runtime,data,calls,errors,callbacks,decide:(...args)=>commands.get('manuscriptReview.decideSource')(...args),lenses:()=>callbacks.provider.provideCodeLenses(doc)};
}

test('current-edit controls save canonical choices and use the single native delivery owner',async()=>{
 const f=fixture(),lenses=f.lenses();assert.deepEqual(lenses.map(lens=>lens.command.title),['Accept','Reject']);
 await f.decide(...lenses[1].command.arguments);
 assert.deepEqual(f.calls,[{route:'/save',body:{revision:1,decisions:{edit:'reject'},comments:{thread:'Keep context.'}}},{delivery:{force:true}},'changed']);
 assert.equal(f.doc.text,'A new sentence.');assert.deepEqual(f.errors,[]);
});

test('dirty, stale, disabled and different-source controls cannot decide another wording',async()=>{
 for(const change of [f=>f.doc.isDirty=true,f=>f.runtime.review.revision++,f=>f.doc.text='Changed elsewhere.']){
  const f=fixture(),arguments_=f.lenses()[0].command.arguments;change(f);await f.decide(...arguments_);
  assert.equal(f.calls.length,0);assert.equal(f.errors.length,1);
 }
 const f=fixture({enabled:false});assert.deepEqual(f.lenses(),[]);
});

test('selection and decision remain pinned while pending source or canonical writes complete',async()=>{
 let f;f=fixture({flushing:()=>{f.runtime.review={id:'another',revision:1};}});
 await f.decide(...f.lenses()[0].command.arguments);assert.equal(f.calls.length,0);
 const other=fixture({saving:()=>{other.runtime.review.id='another';}});
 await other.decide(...other.lenses()[0].command.arguments);assert.equal(other.calls.some(call=>call.delivery),false);
 assert.equal(other.errors.length,1);
});

test('source focus synchronizes the open comparison once per selected edit',()=>{
 const f=fixture();f.callbacks.selection();f.callbacks.selection();
 assert.deepEqual(f.calls,[{focus:['main.tex','edit']}]);f.controls.clear();assert.deepEqual(f.lenses(),[]);f.controls.dispose();
});

test('opening review selects the current source change, or the next one in its file',()=>{
 const f=fixture(),selection={file:'main.tex',target:{id:'edit',kind:'edit'},source:true};
 assert.deepEqual(f.controls.selection(),selection);
 f.editor.selection.active=0;assert.deepEqual(f.lenses(),[]);assert.deepEqual(f.controls.selection(),selection);
 f.editor.selection.active=12;assert.deepEqual(f.controls.selection(),selection);
 f.doc.text='Another draft.';assert.equal(f.controls.selection(),undefined);
});
