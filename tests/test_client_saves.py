import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which('node'), 'Node is needed only for client save checks.')
class ClientSaveTests(unittest.TestCase):
    def test_native_send_locks_input_before_flushing_and_releases_only_its_own_busy_state(self):
        script = r"""import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {hostMessage} from './manuscript_review/host.js';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const flush=app.slice(app.indexOf('window.flushReview='),app.indexOf("$('library').addEventListener"));
const listener=app.slice(app.indexOf("if(embedded)window.addEventListener('message'"),app.lastIndexOf('ready();'));
for(const fail of [false,true,'superseded']){
 let receive,release;const gate=new Promise(resolve=>{release=resolve;}),controls={inert:false},events=[],elements=new Map();
 const context={acquireVsCodeApi:()=>({}),hostMessage:event=>hostMessage(event,'vscode-webview://review'),setTimeout,clearTimeout,
  reviewProgress:()=>({total:0,complete:true}),CustomEvent:class{constructor(type,{detail}){Object.assign(this,{type,detail});}},
  window:{addEventListener:(_name,handler)=>{receive=handler;},dispatchEvent:event=>events.push(event)},
  document:{querySelectorAll:()=>[controls],body:{classList:{contains:()=>false,toggle(){}}},getElementById:id=>{
   if(!elements.has(id))elements.set(id,{className:'',textContent:'',querySelector:()=>null});return elements.get(id);}},
  request:async path=>{if(path==='/save')await gate;return {ok:!fail||path!=='/save',json:async()=>fail?{error:'Disk error'}:{revision:1}};}};
 vm.createContext(context);vm.runInContext(beginning+flush+listener+`data={revision:0,token:'test',scope:'round',files:[],history:[]};`,context);
 const message=data=>({origin:'vscode-webview://review',source:{parent:true},data});
 const pending=receive(message({type:'review-command',action:'flush',lock:true,id:'save'}));
 assert.equal(controls.inert,true);assert.equal(vm.runInContext('Boolean(editing&&reviewLock)',context),true);
 if(fail==='superseded'){await receive(message({type:'review-command',action:'unlock',id:'save'}));vm.runInContext("reviewLock='new';setBusy(true);",context);}
 release();await pending;assert.equal(events.at(-1).detail.ok,!fail);
 if(fail==='superseded'){assert.equal(vm.runInContext('reviewLock',context),'new');assert.equal(controls.inert,true);await receive(message({type:'review-command',action:'unlock',id:'new'}));}
 if(!fail){assert.equal(controls.inert,true);await receive(message({type:'review-command',action:'unlock',id:'save'}));}
 assert.equal(controls.inert,false);assert.equal(vm.runInContext('Boolean(editing||reviewLock)',context),false);
 vm.runInContext('editing=true',context);await receive(message({type:'review-command',action:'unlock',id:'save'}));
 assert.equal(vm.runInContext('editing',context),true,'unlock must preserve an unrelated operation');
}
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_native_comment_change_opens_its_round_and_saves_pending_notes_first(self):
        script = r"""import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {hostMessage} from './manuscript_review/host.js';
const app=readFileSync('manuscript_review/app.js','utf8');
const revision=app.slice(app.indexOf('async function showRevision'),app.indexOf('function renderDiscussion'));
const listener=app.slice(app.indexOf("if(embedded)window.addEventListener('message'"),app.lastIndexOf('ready();'));
for(const failed of [false,true]){
 let receive;const calls=[];
 const context={embedded:true,hostMessage:event=>hostMessage(event,'vscode-webview://review'),window:{addEventListener(name,handler){receive=handler;}},calls,
  saveNotes:()=>calls.push('notes'),saveDrafts:()=>calls.push('drafts'),save:()=>calls.push('decisions'),
  switchScope:async(scope,file)=>{calls.push(['scope',scope,file]);vm.runInContext("data.scope='round';locations=[[0,0,0]]",context);},
  render:()=>calls.push('render'),openComment:passage=>calls.push(['comment',passage]),status:(text,error)=>calls.push(['status',text,error])};
 vm.createContext(context);vm.runInContext(`let data={scope:'baseline',files:[{path:'main.tex',hunks:[{id:'passage',edits:[{id:'edit'}]}]}]},
  saving=Promise.resolve(),saveFailed=${failed},draftChanges=new Map(),noteChanges=new Map(),fileEditor=null,
  locations=[],active=0,passage=0,edit=0,commentId;`+revision+listener,context);
 await receive({origin:'vscode-webview://review',source:{parent:true},data:{type:'review-select',file:'main.tex',target:'passage',kind:'passage',note:'discussion'}});
 assert.deepEqual(calls.slice(0,3),['notes','drafts','decisions']);
 if(failed){assert.equal(vm.runInContext('data.scope',context),'baseline');assert.match(calls.at(-1)[1],/save error/);}
 else{assert.deepEqual(calls[3],['scope','round','main.tex']);assert.equal(vm.runInContext('commentId',context),'discussion');assert.deepEqual(calls.at(-1),['comment',true]);}
 const length=calls.length;await receive({origin:'https://pdf-resources.invalid',source:{},data:{type:'review-select',target:'passage'}});assert.equal(calls.length,length);
}
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_comment_navigation_saves_pending_input_and_preserves_it_on_failure(self):
        script = r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {currentFeedback,commentThreads,feedbackForPassage} from './manuscript_review/review_model.js';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const navigation=app.slice(app.indexOf('function commentNavigation'),app.indexOf('function renderDiscussion'));
const selection=app.slice(app.indexOf('function sourceNoteTarget'),app.indexOf('function commentSelection'));
const opener=app.slice(app.indexOf('async function openEditor'),app.indexOf('async function loadEditor'));
const closer=app.slice(app.indexOf('function closeEditor'),app.indexOf('async function saveFile'));
for(const fail of [false,true,'missing','new']){
 const requests=[],elements=new Map(),visited=[];
 const context={currentFeedback,commentThreads,feedbackForPassage,setTimeout,clearTimeout,
 reviewProgress:()=>({total:0,complete:true}),updateProgress:()=>{},renderDiscussion:()=>{},
 document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{className:'',textContent:'',children:[],querySelector:()=>null,close(){this.open=false;}});return elements.get(id);},body:{classList:{contains:()=>false,remove:()=>{}}}},
 request:async(path,options)=>{const request=JSON.parse(options.body);requests.push([path,request]);
  if(path==='/draft'&&fail===true)return {ok:false,json:async()=>({error:'Disk error'})};
  return {ok:true,json:async()=>({revision:requests.length,...(path==='/note'?{entry:{id:fail==='new'?'new':'first',origin_id:fail==='new'?'new':'first',author:'user',kind:'source',file:'a.tex',line:fail==='new'?2:1,comment:request.comment,replies:[]}}:{})})};},
 visited,showFeedback:()=>{context.document.getElementById('feedback').open=true;}};
 vm.createContext(context);vm.runInContext(beginning+navigation+selection+opener+closer+`
 data={token:'test',revision:0,scope:'manuscript',files:[{path:'a.tex',hunks:[],edits:[]},{path:'b.tex',hunks:[],edits:[]}],history:[
  {id:'first',origin_id:'first',author:'user',kind:'source',file:'a.tex',line:1,comment:'Original comment',replies:[]},
  {id:'second',origin_id:'second',author:'agent',kind:'source',file:'b.tex',line:2,comment:'Imported feedback',replies:[{text:'Response'}]}]};
 const createFileEditor=path=>({range:id=>({start:0,end:5}),selection:()=>({start:0,end:5}),text:()=>path==='a.tex'?'Draft words':'Other words',position:()=>0,
  goTo:id=>visited.push([path,id]),focus:()=>{},addNote:()=>{},destroy:()=>{}});
 editorFile='a.tex';editorSource='a'.repeat(40);fileEditor=createFileEditor('a.tex');
 noteTarget={id:'first',marker:'first',file:'a.tex',comment:'Original comment'};
 setNoteText(noteTarget,'Keep my latest comment');
 drafts={'a.tex':{file:'a.tex',source:editorSource,text:'Draft words'}};retainDraft('a.tex',drafts['a.tex']);
 async function switchScope(scope){data.scope=scope;}
 async function loadEditor(){await Promise.resolve();editorFile=currentFile().path;editorSource='a'.repeat(40);fileEditor=createFileEditor(editorFile);}
 function render(){if(!fileEditor)openEditor();}
 function focusSelection(){}
 `,context);
 if(fail==='missing')vm.runInContext("data.history[1].file='absent.tex';data.history.push({...data.history[1],id:'third',origin_id:'third',file:'b.tex'});",context);
 if(fail==='new')vm.runInContext("delete noteTarget.id;noteTarget.marker='note-new';",context);
 await vm.runInContext(fail==='new'?"moveComment(1)":"showComment('second')",context);
 assert.equal(requests.find(([path])=>path==='/note')[1].comment,'Keep my latest comment');
 assert.equal(requests.find(([path])=>path==='/draft')[1].draft.text,'Draft words');
 assert.ok(requests.every(([path])=>path!=='/file'&&path!=='/apply'));
 assert.equal(vm.runInContext("drafts['a.tex'].text",context),'Draft words');
 if(fail==='missing'){assert.equal(vm.runInContext('commentId',context),'second');assert.equal(elements.get('feedback').open,true);await vm.runInContext('moveComment(1)',context);assert.equal(vm.runInContext('noteTarget.parent',context),'third');}
 else if(fail===true){assert.equal(vm.runInContext('editorFile',context),'a.tex');assert.equal(vm.runInContext('draftChanges.size',context),1);assert.equal(visited.length,0);}
 else{assert.equal(vm.runInContext('editorFile',context),'b.tex');assert.equal(vm.runInContext('noteTarget.parent',context),'second');assert.equal(vm.runInContext('commentId',context),'second');assert.ok(visited.some(([path,id])=>path==='b.tex'&&id==='second'));assert.equal(vm.runInContext('draftChanges.size',context),0);
  vm.runInContext(`data.scope='round';data.files[1].hunks=[{id:'target',edits:[{id:'change'}]}];locations=[[1,0,0]];
   render=()=>{};let opened;function openComment(passage){opened=passage;}`,context);
  await vm.runInContext("showRevision({...data.history.find(entry=>entry.id==='second'),target:{id:'target',kind:'passage'}})",context);
  assert.equal(vm.runInContext('fileEditor',context),null);assert.equal(vm.runInContext('opened',context),true);assert.equal(vm.runInContext('commentId',context),'second');
 }
 vm.runInContext('clearTimeout(uiTimer);clearTimeout(noteTimer);clearTimeout(draftTimer);',context);
 if(fail===true){vm.runInContext('saveFailed=false;draftChanges.clear();',context);await vm.runInContext("selectSourceNote('second')",context);assert.equal(vm.runInContext('noteTarget.id',context),'first');}
}
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_comment_save_refreshes_navigation_without_replacing_the_focused_field(self):
        script = r"""import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {currentFeedback,commentThreads,feedbackForPassage} from './manuscript_review/review_model.js';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const navigation=app.slice(app.indexOf('function commentNavigation'),app.indexOf('function renderDiscussion'));
const selector=app.slice(app.indexOf('function sourceCommentSelector'),app.indexOf('function renderSelection'));
const replaced=new Map(),textarea={value:'Author is still typing'};
class Element{constructor(tag){this.tag=tag;this.children=[];}append(...items){this.children.push(...items);}setAttribute(){}addEventListener(){}replaceWith(next){replaced.set(this,next);}}
const oldSelector=new Element('select'),oldNavigation=new Element('div'),host={querySelector:query=>query.startsWith('select')?oldSelector:oldNavigation};
const context={currentFeedback,commentThreads,feedbackForPassage,setTimeout,clearTimeout,document:{activeElement:textarea,createElement:tag=>new Element(tag),getElementById:()=>host}};
vm.createContext(context);vm.runInContext(beginning+navigation+selector+`
 data={files:[],history:[{id:'one',origin_id:'one',file:'main.tex',line:1,before:'First',comment:'First comment'},
 {id:'two',origin_id:'two',file:'main.tex',line:2,before:'Second',comment:'Just saved'}]};editorFile='main.tex';noteTarget={id:'two'};
 refreshCommentNavigation();`,context);
assert.equal(replaced.get(oldSelector).children.length,3);assert.equal(replaced.get(oldSelector).value,'two');
assert.equal(replaced.get(oldNavigation).children[0].textContent,'2 of 2');
assert.equal(replaced.get(oldNavigation).children[1].disabled,false);assert.equal(replaced.get(oldNavigation).children[2].disabled,true);
assert.equal(context.document.activeElement,textarea);assert.equal(textarea.value,'Author is still typing');
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_busy_render_does_not_prevent_the_editor_from_opening_when_loading_finishes(self):
        script = r"""import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync('manuscript_review/app.js','utf8');
const opener=app.slice(app.indexOf('async function openEditor'),app.indexOf('async function loadEditor'));
const context={embedded:false};vm.createContext(context);vm.runInContext(`let editing=true,openingEditor=null,fileEditor=null,loads=0;
const data={scope:'manuscript'},currentFile=()=>({path:'main.tex'}),readOnly=()=>false;
async function loadEditor(){loads++;fileEditor={};}
`+opener,context);
await vm.runInContext('openEditor()',context);assert.equal(vm.runInContext('loads',context),0);
vm.runInContext('editing=false',context);await vm.runInContext('openEditor()',context);assert.equal(vm.runInContext('loads',context),1);
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_clearing_a_comment_during_creation_deletes_the_saved_note(self):
        script = r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const requests=[],elements=new Map();let acknowledge;
const context={reviewProgress:()=>({total:0,complete:true}),updateProgress:()=>{},setTimeout,clearTimeout,
document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{className:'',textContent:'',children:[],querySelector:()=>null,close(){this.open=false;}});return elements.get(id);},body:{classList:{contains:()=>false}}},
request:async(path,options)=>{const request=JSON.parse(options.body);requests.push([path,request]);
 if(path==='/note'&&!request.id)await new Promise(resolve=>acknowledge=resolve);
 return {ok:true,json:async()=>({revision:requests.length,entry:{id:'saved-note',file:'main.tex',comment:request.comment}})};}};
vm.createContext(context);vm.runInContext(beginning+`
data={token:'test',revision:0,scope:'manuscript',files:[],history:[]};
const target={file:'main.tex',marker:'temporary',comment:''};
setNoteText(target,'Typed then erased');saveNotes();`,context);
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(vm.runInContext('target.comment',context),'Typed then erased');
vm.runInContext("setNoteText(target,'');saveNotes();",context);
acknowledge();await vm.runInContext('saving',context);
assert.deepEqual(requests.filter(([path])=>path==='/note').map(([,r])=>[r.id??null,r.comment]),[[null,'Typed then erased'],['saved-note','']]);
assert.equal(vm.runInContext('data.history.length',context),0);
assert.equal(vm.runInContext('noteChanges.size',context),0);
vm.runInContext('clearTimeout(uiTimer);clearTimeout(noteTimer);',context);
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_source_editor_preserves_newlines_and_tracks_changes(self):
        script = r"""import assert from 'node:assert/strict';
import {createSourceState} from './frontend/editor.js';
import {EditorView} from '@codemirror/view';
for (const newline of ['\n', '\r\n']) {
  const source = `First α😀 line.${newline}Second old line.${newline}`;
  const start = source.indexOf('old');
  const state = createSourceState(source, [{id:'edit',from:start,to:start+3}], start);
  assert.equal(state.sliceDoc(),source);
  assert.equal(state.sliceDoc(state.selection.main.head,state.selection.main.head+3),'old');
  const changed=state.update({changes:{from:state.selection.main.head,to:state.selection.main.head+3,insert:'new words'}}).state;
  assert.equal(changed.sliceDoc(),source.replace('old','new words'));
  const marks=changed.facet(EditorView.decorations).find(value=>typeof value!=='function');
  marks.between(0,changed.doc.length,(from,to)=>assert.equal(changed.sliceDoc(from,to),'new words'));
  const pasted=state.facet(EditorView.clipboardInputFilter).reduce((input,filter)=>filter(input,state),'new\nwords');
  const multiline=state.update({changes:{from:state.selection.main.head,to:state.selection.main.head+3,insert:pasted}}).state;
  assert.equal(multiline.doc.lines,state.doc.lines+1);
  assert.equal(multiline.sliceDoc(),source.replace('old',`new${newline}words`));
}
const mixed='First\r\nSecond\nThird\r\n';
assert.equal(createSourceState(mixed,[],0).sliceDoc(),mixed);
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_failed_draft_blocks_leaving_even_after_choices_save_succeeds(self):
        script = r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const flush=app.slice(app.indexOf('window.flushReview='),app.indexOf("$('library').addEventListener"));
const requests=[],elements=new Map();let fail=true;
const context={window:{},reviewProgress:()=>({total:0,complete:true}),document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{className:'',textContent:'',children:[],querySelector:()=>null,close(){this.open=false;},hidden:true});return elements.get(id);},body:{classList:{contains:()=>false}}},setTimeout,clearTimeout,
request:async(path,options)=>{requests.push([path,JSON.parse(options.body)]);if(path==='/draft'&&fail===true)return {ok:false,json:async()=>({error:'Transient disk error'})};return {ok:true,json:async()=>({revision:0})};}};
vm.createContext(context);vm.runInContext(beginning+'\n'+flush+`
data={token:'test',revision:0,scope:'round',files:[],history:[]};drafts={passage:{file:'passage',source:'a'.repeat(40),text:'Unsaved manuscript words'}};
draftChanges.set('passage',drafts.passage);`,context);
await assert.rejects(context.window.flushReview(),/could not be saved/);
assert.equal(vm.runInContext('draftChanges.size',context),1);
assert.equal(vm.runInContext('drafts.passage.text',context),'Unsaved manuscript words');
assert.deepEqual(requests.map(([path])=>path),['/draft','/save']);
fail=false;await context.window.flushReview();
assert.equal(vm.runInContext('draftChanges.size',context),0);
assert.equal(requests.at(-1)[0],'/ui');
assert.equal(requests.filter(([path])=>path==='/draft').at(-1)[1].draft.text,'Unsaved manuscript words');
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)
