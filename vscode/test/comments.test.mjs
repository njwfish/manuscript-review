import assert from 'node:assert/strict';
import test from 'node:test';
import {createComments} from '../src/comments.mjs';

class Position {
  constructor(line,character){Object.assign(this,{line,character});}
  compareTo(other){return this.line-other.line||this.character-other.character;}
}
class Range {
  constructor(start,end){Object.assign(this,{start,end});}
  contains(position){return this.start.compareTo(position)<=0&&this.end.compareTo(position)>=0;}
}
class Selection extends Range {
  constructor(anchor,active){super(anchor.compareTo(active)<=0?anchor:active,anchor.compareTo(active)<=0?active:anchor);Object.assign(this,{anchor,active});}
  get isEmpty(){return this.start.compareTo(this.end)===0;}
}
const uri=file=>({scheme:'file',fsPath:file,toString:()=>`file://${file}`});

function document(file,text) {
  return {uri:uri(`/manuscript/${file}`),version:1,isDirty:false,text,
    get lineCount(){return this.text.split('\n').length;},
    getText(){return this.text;},
    positionAt(offset){const lines=this.text.slice(0,offset).split('\n');return new Position(lines.length-1,lines.at(-1).length);},
    offsetAt(position){return this.text.split('\n').slice(0,position.line).reduce((n,line)=>n+line.length+1,0)+position.character;},
    lineAt(line){const text=this.text.split('\n')[line].replace(/\r$/,'');return {text,isEmptyOrWhitespace:!text.trim(),range:new Range(new Position(line,0),new Position(line,text.length))};},
    change(text){this.text=text;this.version++;this.isDirty=true;}};
}

const source=(id,file='main.tex',comment='Please clarify this.',extra={})=>({id,origin_id:id,
  file,line:1,author:'user',kind:'source',comment,before:'selected words',replies:[],target:null,...extra});

function fixture(history=[source('root')]) {
  const documents=[document('main.tex','First selected words.'),document('other.tex','Other selected words.')];
  const handlers=new Map(),created=[],errors=[],requests=[],opened=[],projections=[],sent=[];
  const controller={dispose(){this.disposed=true;},createCommentThread(uri,range,comments){
    const thread={uri,range,comments,dispose(){this.disposed=true;}};created.push(thread);return thread;}};
  const vscode={Uri:{file:uri},Range,Selection,CommentMode:{Preview:0,Editing:1},
    CommentThreadCollapsibleState:{Collapsed:0,Expanded:1},CommentThreadState:{Unresolved:0,Resolved:1},TextEditorRevealType:{InCenterIfOutsideViewport:2},
    comments:{createCommentController:()=>controller},commands:{registerCommand(name,handler){
      handlers.set(name,handler);return {dispose(){handlers.delete(name);}};}},
    workspace:{textDocuments:documents,async openTextDocument(uri){
      const result=documents.find(document=>document.uri.toString()===uri.toString());
      if(!result)throw Object.assign(new Error('Missing file'),{code:'ENOENT'});return result;}},
    window:{visibleTextEditors:[],async showErrorMessage(message){errors.push(message);},async showQuickPick(choices){return choices.find(choice=>choice.label==='All');},async showTextDocument(document){
      opened.push(document.uri.fsPath);
      const editor={document,selection:new Selection(new Position(0,0),new Position(0,0)),revealRange(range){this.revealed=range;}};
      this.activeTextEditor=editor;return editor;}}};
  const data={id:'review',revision:1,base:'base',proposed:'proposal',history,resolved:[],comments:{},decisions:{},files:[]};
  let beforeProjection,failNote=false,noteNumber=0,changes=0;
  const runtime={review:{id:'review',repo:'/manuscript',revision:1},async data(){return {...structuredClone(data),id:runtime.review.id};},
    async request(route,body){
      requests.push({route,body});
      if(route==='/editor') {
        await beforeProjection?.(body);
        const from=body.text.indexOf('selected words');
        return {revision:data.revision,source:'selected-source',text:body.text,
          notes:data.history.filter(entry=>entry.file===body.file).map(entry=>{
            const start=body.text.indexOf(entry.before);return {id:entry.id,from:start,to:start+entry.before.length};
          }),
          ranges:[{id:'edit',from,to:from+14}],passages:[{id:'passage',from,to:from+14}]};
      }
      assert.equal(body.revision,data.revision,'every write checks the current revision');
      if(route==='/note') {
        if(failNote)throw new Error('The review changed. Your comment is retained.');
        let entry;
        if(body.id) {
          entry=data.history.find(entry=>entry.id===body.id);
          entry.comment=body.comment;
          if(!body.comment.trim())data.history=data.history.filter(item=>item!==entry);
        } else {
          const parent=data.history.find(entry=>entry.id===body.parent);
          entry=source(`note-${++noteNumber}`,body.file,body.comment,{origin_id:parent?.origin_id||`note-${noteNumber}`});
          data.history.push(entry);
        }
        data.revision++;return {revision:data.revision,entry};
      }
      if(route==='/save') {data.comments=body.comments;data.revision++;return {revision:data.revision};}
      if(route==='/thread') {
        const entry=data.history.find(entry=>entry.id===body.id),origin=entry?.origin_id||body.id;
        data.resolved=body.resolved?[...new Set([...data.resolved,origin])]:data.resolved.filter(id=>id!==origin);
        data.revision++;return {revision:data.revision,resolved:data.resolved};
      }
      throw new Error('Unexpected write: '+route);
    }};
  Object.defineProperty(runtime.review,'revision',{get:()=>data.revision,set:value=>{data.revision=value;},configurable:true});
  let openDocument=async file=>{const target=uri((runtime.review.workspace||runtime.review.repo)+'/'+file);return vscode.workspace.textDocuments.find(document=>document.uri.toString()===target.toString())||vscode.workspace.openTextDocument(target);};
  const comments=createComments(vscode,()=>runtime,{openDocument:file=>openDocument(file),onChange:()=>changes++,onReview:entry=>entry,onProjection:(projection,data)=>projections.push({projection,data}),onAgent:async(id,save,sourceUri)=>{assert.equal(sourceUri.fsPath,documents[0].uri.fsPath);if(save)id=await save();if(!id)return false;sent.push(id);return true;}});
  const editor={document:documents[0],selection:new Selection(new Position(0,6),new Position(0,20))};
  return {comments,vscode,runtime,data,documents,created,requests,errors,opened,editor,controller,projections,sent,
    command:(name,...args)=>handlers.get(`manuscriptReview.${name}`)(...args),
    beforeProjection:handler=>beforeProjection=handler,openDocument:handler=>openDocument=handler,failNote:value=>failNote=value,changes:()=>changes};
}

test('typing projects only changed buffers and reuses review data and unchanged comment locations',async t=>{
 const f=fixture([source('main'),source('other','other.tex')]);
 const reads=t.mock.method(f.runtime,'data');
 await f.comments.refresh();assert.equal(reads.mock.callCount(),1);assert.equal(f.requests.length,2);
 for(let index=0;index<5;index++){
  f.documents[0].change(`Prefix ${index}\nFirst selected words.`);
  await f.comments.refresh({sourceOnly:true});
 }
 assert.equal(reads.mock.callCount(),1);assert.equal(f.requests.length,7);
 assert.equal(f.requests.slice(2).every(request=>request.body.file==='main.tex'),true);
 assert.equal(f.created.length,2);assert.equal(f.created[0].range.start.line,1);
 f.comments.dispose();
});

test('unchanged source refreshes reuse document versions without reading whole buffers',async t=>{
 const f=fixture([source('main'),source('other','other.tex')]);
 await f.comments.refresh();
 const reads=f.documents.map(document=>t.mock.method(document,'getText'));
 const count=f.requests.length;
 for(let i=0;i<20;i++)await f.comments.refresh({sourceOnly:true});
 assert.equal(f.requests.length,count);
 assert.deepEqual(reads.map(read=>read.mock.callCount()),[0,0]);
 // An undo still changes the native document version, even with identical text.
 f.documents[0].change(f.documents[0].text);
 await f.comments.refresh({sourceOnly:true});
 assert.equal(f.requests.length,count+1);
 assert.equal(reads[1].mock.callCount(),0);
 f.comments.dispose();
});

test('cancelling a conflicted comment edit restores the latest saved wording',async()=>{
 const f=fixture();await f.comments.refresh();
 const comment=f.created[0].comments[0];
 await f.command('editComment',comment);comment.body='My unsaved change';
 f.data.history[0].comment='Edited in another interface';f.data.revision++;
 await f.comments.refresh();
 assert.equal(comment.conflict,true);assert.equal(comment.body,'My unsaved change');
 await f.command('cancelComment',comment);
 assert.equal(comment.body,'Edited in another interface');
 assert.equal(comment.savedBody,comment.body);assert.equal(comment.conflict,false);
 assert.equal(comment.mode,f.vscode.CommentMode.Preview);
 f.comments.dispose();
});

test('a saved comment remains current when typing interrupts its source refresh',async()=>{
 for(const current of [false,true]){
  const f=fixture(current?[]:undefined);
  if(current){
   f.data.files=[{path:'main.tex',hunks:[{id:'passage',before:'selected words',after:'selected words',line:1,edits:[{id:'edit',old:'selected words',new:'selected words'}]}],edits:[{id:'edit'}]}];
   f.data.comments={edit:'Current note'};
  }
  await f.comments.refresh();
  const comment=f.created[0].comments[0];
  await f.command('editComment',comment);comment.body='My saved correction';
  f.beforeProjection(()=>f.documents[0].change(f.documents[0].text+'!'));
  assert.equal(await f.command('saveComment',comment),true);
  assert.equal(comment.entry.comment,'My saved correction');
  await f.command('editComment',comment);comment.body='Another unfinished edit';
  await f.command('cancelComment',comment);
  assert.equal(comment.body,'My saved correction');
  assert.equal(comment.editRevision,f.data.revision);
  f.comments.dispose();
 }
});

test('carried discussion origins cannot move unfinished replies into another round',async()=>{
 const f=fixture();await f.comments.refresh();
 const original=f.created[0];original.input='Unfinished reply in the first round';
 original.collapsibleState=f.vscode.CommentThreadCollapsibleState.Expanded;
 f.runtime.review.id='following-round';f.data.revision++;
 await f.comments.refresh();
 assert.equal(f.created.length,2);
 const following=f.created[1];
 assert.equal(original.reviewState.reviewId,'review');assert.equal(original.label,'Other review');
 assert.equal(following.reviewState.reviewId,'following-round');
 assert.equal(await f.command('reply',{thread:original,text:original.input}),false);
 assert.equal(f.data.history.length,1);
 f.runtime.review.id='review';f.data.revision++;
 await f.comments.refresh();
 assert.equal(f.created.length,2);assert.equal(original.label,undefined);
 assert.equal(original.input,'Unfinished reply in the first round');
 assert.equal(original.collapsibleState,f.vscode.CommentThreadCollapsibleState.Expanded);
 assert.equal(following.label,'Other review');
 assert.equal(await f.command('reply',{thread:original,text:original.input}),true);
 f.comments.dispose();
});

test('overlapping typing refreshes coalesce and publish only the newest buffer',async()=>{
 const f=fixture();await f.comments.refresh();
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 f.beforeProjection(async()=>{entered();await gate;});
 f.documents[0].change('First prefix selected words.');
 const first=f.comments.refresh({sourceOnly:true});await began;
 const pending=[];
 for(let index=0;index<10;index++){
  f.documents[0].change(`Newest ${index}\nselected words.`);
  pending.push(f.comments.refresh({sourceOnly:true}));
 }
 assert.equal(pending.every(value=>value===first),true);
 release();await first;
 assert.equal(f.requests.length,3);
 assert.equal(f.projections.at(-1).projection.text,'Newest 9\nselected words.');
 assert.equal(f.created[0].range.start.line,1);f.comments.dispose();
});

test('a delayed projection cannot publish an earlier comparison after the review advances',async()=>{
 const f=fixture();await f.comments.refresh();f.projections.length=0;
 const thread=f.created[0];f.documents[0].change('Prefix selected words.');
 let release,entered,held=false;
 const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});
 const request=f.runtime.request;
 f.runtime.request=async(route,...args)=>{
  const result=await request(route,...args);
  if(route==='/editor'&&!held){held=true;entered();await gate;}
  return result;
 };
 const refreshing=f.comments.refresh({sourceOnly:true});await began;
 f.data.revision++;f.data.history[0].comment='Updated feedback.';
 release();await refreshing;
 assert.equal(f.projections.length,1);assert.equal(f.projections[0].data.revision,2);
 assert.equal(thread.reviewState.data.revision,2);assert.equal(thread.comments[0].body,'Updated feedback.');
 assert.equal(f.created.length,1);f.comments.dispose();
});

test('a newer lazy file response refreshes the comparison before publishing source',async()=>{
 const f=fixture();f.data.files=[{path:'main.tex',loaded:false,edits:[],hunks:[]}];
 const data=f.runtime.data;let reads=0;
 f.runtime.data=async(...args)=>{
  if(++reads===2){f.data.revision++;f.data.files[0].loaded=true;}
  return data(...args);
 };
 await f.comments.refresh();
 assert.equal(reads,3);assert.equal(f.projections.length,1);
 assert.equal(f.projections[0].data.revision,2);assert.equal(f.created.length,1);
 f.comments.dispose();
});

test('comments on removed source remain navigable beside comments on working files',async()=>{
 const f=fixture([source('archived','main.tex'),source('working','other.tex')]);
 f.documents[0].uri={scheme:'manuscript-review-source',authority:'review',path:'/main.tex',fsPath:'/main.tex',toString:()=> 'manuscript-review-source://review/main.tex?version=pinned'};
 f.openDocument(async file=>f.documents[file==='main.tex'?0:1]);
 await f.comments.refresh();assert.equal(f.created.length,2);
 assert.equal(f.projections.length,2);assert.equal(f.created[0].uri.scheme,'manuscript-review-source');
 assert.equal(await f.comments.move(1),true);assert.equal(await f.comments.move(1),true);
 assert.equal(f.opened.length,2);assert.deepEqual(f.errors,[]);
 await f.command('reply',{thread:f.created[0],text:'This should apply to its replacement file.'});
 assert.equal(f.data.history.at(-1).origin_id,'archived');
 f.comments.dispose();
});

test('projects exact dirty-buffer UTF-16 spans and groups roots with responses and follow-ups',async()=>{
  const f=fixture([source('root','main.tex','Initial feedback',{author:'agent',replies:[{id:'reply',text:'Addressed.'}]}),
    source('follow','main.tex','One more question.',{origin_id:'root'})]);
  f.documents[0].change('🙂 Prefix\nBefore selected words.');
  await f.comments.refresh();
  assert.equal(f.created.length,1);
  assert.equal(f.created[0].comments.length,3);
  assert.deepEqual(f.created[0].comments.map(comment=>comment.author.name),['Agent','Agent','You']);
  assert.deepEqual(f.created[0].reviewState.range.start,new Position(1,7));
  assert.deepEqual(f.created[0].range.start,f.created[0].range.end);
  assert.equal(f.requests[0].body.text,'🙂 Prefix\nBefore selected words.');
  assert.equal(f.documents[0].isDirty,true);
  assert.equal(f.requests.every(request=>request.route==='/editor'),true);
  f.comments.dispose();
});

test('paragraph comments use a point at the following break while navigation and replies retain the original quotation',async()=>{
  const text='🙂 '+ 'A long manuscript sentence. '.repeat(18)+'selected words.';
  const selected=text.slice(8,text.length-1),f=fixture([source('root','main.tex','Please clarify.',{before:selected})]);
  f.documents[0].change(text+'\r\n\r\nAnother paragraph.');
  await f.comments.refresh();
  const thread=f.created[0],range=thread.reviewState.range;
  assert.deepEqual(range,new Range(new Position(0,8),new Position(0,text.length-1)));
  assert.deepEqual(thread.range,new Range(new Position(1,0),new Position(1,0)));
  thread.input='An unfinished reply';f.data.revision++;await f.comments.refresh();
  assert.equal(f.created.length,1);assert.equal(thread.input,'An unfinished reply');
  assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection,new Selection(range.start,range.start));
  assert.deepEqual(f.vscode.window.activeTextEditor.revealed,range);
  await f.command('reply',{thread,text:'Follow up on those words.'});
  const write=f.requests.find(request=>request.route==='/note');
  assert.equal(write.body.text.slice(write.body.start,write.body.end),selected);
  assert.equal(f.documents[0].getText(),text+'\r\n\r\nAnother paragraph.');
  f.comments.dispose();
});

test('new native comments retain their selection while the marker sits on a paragraph break',async()=>{
  const f=fixture([]);f.documents[0].change('A sentence with selected words here.\n\nNext paragraph.');
  const thread=await f.comments.annotate(f.editor);
  assert.deepEqual(thread.range.end,new Position(1,0));
  await f.command('reply',{thread,text:'Please refine this selection.'});
  const write=f.requests.find(request=>request.route==='/note');
  assert.deepEqual([write.body.start,write.body.end],[6,20]);
  f.comments.dispose();
});

test('a final paragraph uses its preceding break without changing the saved quotation',async()=>{
  const text='Previous paragraph.\n\n'+ 'A long manuscript sentence. '.repeat(18)+'selected words.';
  const selected=text.slice(text.indexOf('A long'),text.length-1);
  const f=fixture([source('root','main.tex','Please clarify.',{before:selected})]);
  f.documents[0].change(text);await f.comments.refresh();
  const thread=f.created[0],range=thread.reviewState.range;
  assert.deepEqual(thread.range,new Range(new Position(1,0),new Position(1,0)));
  await f.command('reply',{thread,text:'Keep this exact quotation.'});
  const write=f.requests.find(request=>request.route==='/note');
  assert.equal(write.body.text.slice(write.body.start,write.body.end),selected);
  assert.equal(f.documents[0].getText(),text);
  f.comments.dispose();
});

test('a blank first line remains a marker location for the final wrapped paragraph',async()=>{
  for(const newline of ['\n','\r\n']){
    const f=fixture([]);f.documents[0].change(newline+'A long manuscript sentence. '.repeat(18));
    f.editor.selection=new Selection(new Position(1,3),new Position(1,100));
    const thread=await f.comments.annotate(f.editor);
    assert.deepEqual(thread.range,new Range(new Position(0,0),new Position(0,0)));
    await f.command('reply',{thread,text:'Preserve the exact words.'});
    const write=f.requests.find(request=>request.route==='/note');
    assert.equal(write.body.text.slice(write.body.start,write.body.end),f.documents[0].getText().split(newline)[1].slice(3,100));
    f.comments.dispose();
  }
});

test('a selection ending at the next line start never places its marker beyond unselected source',async()=>{
  for(const newline of ['\n','\r\n']){
    const f=fixture([]);f.documents[0].change(['Selected paragraph.','Another paragraph.','',''].join(newline));
    f.editor.selection=new Selection(new Position(0,0),new Position(1,0));
    const thread=await f.comments.annotate(f.editor);
    assert.deepEqual(thread.range,new Range(new Position(0,19),new Position(0,19)));
    await f.command('reply',{thread,text:'This refers to the first paragraph.'});
    const write=f.requests.find(request=>request.route==='/note');
    assert.equal(write.body.text.slice(write.body.start,write.body.end),'Selected paragraph.'+newline);
    f.comments.dispose();
  }
});

test('markers do not extend into subsequent source text or beyond the document',async()=>{
  for(const ending of ['\nMore source immediately follows.','']){
    const f=fixture();f.documents[0].change('First selected words.'+ending);
    await f.comments.refresh();
    const {thread,range}=f.created[0].reviewState;
    assert.deepEqual(thread.range,new Range(range.end,range.end));
    assert.equal(range.start.character,6);
    assert.equal(range.end.character,20);
    f.comments.dispose();
  }
});

test('send saves a new comment before dispatch and a failed save never launches an agent',async()=>{
 const f=fixture([]),thread=await f.comments.annotate(f.editor);
 f.failNote(true);
 assert.equal(await f.command('sendComment',{thread,text:'Work through this comment.'}),false);
 assert.deepEqual(f.sent,[]);
 f.failNote(false);
 assert.equal(await f.command('sendComment',{thread,text:'Work through this comment.'}),true);
 assert.deepEqual(f.sent,['note-1']);assert.equal(f.data.history[0].comment,'Work through this comment.');
 assert.equal(f.documents[0].isDirty,false);
 f.comments.dispose();
});

test('a saved thread dispatches its latest comment and never discards an unsaved comment edit',async()=>{
 const f=fixture([source('root'),source('follow','main.tex','Newest instruction',{origin_id:'root'})]);
 await f.comments.refresh();const thread=f.created[0];
 assert.equal(await f.command('commentAgent',thread),true);assert.deepEqual(f.sent,['follow']);
 const latest=thread.comments.at(-1);await f.command('editComment',latest);latest.body='Still editing';
 assert.equal(await f.command('commentAgent',thread),false);assert.deepEqual(f.sent,['follow']);
 assert.equal(latest.body,'Still editing');assert.match(f.errors.at(-1),/Save your comment edit/);
 f.runtime.review.id='different';
 await f.command('cancelComment',latest);assert.equal(await f.command('commentAgent',thread),false);
 assert.deepEqual(f.sent,['follow']);
 f.comments.dispose();
});

test('a follow-up dispatch keeps its saved identity even when the native refresh is interrupted',async()=>{
 const f=fixture();await f.comments.refresh();const thread=f.created[0];
 f.beforeProjection(()=>{if(f.data.revision>1)f.documents[0].change(f.documents[0].text+'!');});
 assert.equal(await f.command('sendComment',{thread,text:'Address this follow-up, not the preceding note.'}),true);
 assert.deepEqual(f.sent,['note-1']);assert.equal(f.data.history.at(-1).comment,'Address this follow-up, not the preceding note.');
 assert.equal(thread.reviewState.entry.id,'note-1','the saved follow-up is immediately available even if source refresh cannot finish');
 assert.equal(thread.comments.at(-1).body,'Address this follow-up, not the preceding note.');
 f.comments.dispose();
});

test('send publishes the durable note and hands off while its source refresh is still waiting',async()=>{
 const f=fixture([]),thread=await f.comments.annotate(f.editor);
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const data=f.runtime.data;f.runtime.data=async()=>{entered();await gate;return data();};
 const sending=f.command('sendComment',{thread,text:'Work while I keep reading.'});
 await started;
 assert.equal(await sending,true);assert.deepEqual(f.sent,['note-1']);
 assert.equal(thread.comments[0].body,'Work while I keep reading.');
 assert.equal(thread.comments[0].editable,true);assert.equal(thread.reviewState.data.revision,2);
 release();await f.comments.refresh();
 assert.equal(f.created.length,1);assert.equal(f.created[0],thread);
 assert.deepEqual(f.errors,[]);f.comments.dispose();
});

test('refresh keeps native thread objects, reply inputs, and an unfinished root edit',async()=>{
  const f=fixture();await f.comments.refresh();
  const thread=f.created[0],comment=thread.comments[0];
  thread.input='Unsubmitted native reply';
  await f.command('editComment',comment);comment.body='My unsaved correction';
  f.data.revision++;
  await f.comments.refresh();
  assert.equal(f.created.length,1);assert.equal(thread.comments[0],comment);
  assert.equal(comment.body,'My unsaved correction');assert.equal(thread.input,'Unsubmitted native reply');
  assert.equal(comment.mode,f.vscode.CommentMode.Editing);
  await f.command('saveComment',comment);
  assert.equal(f.data.history[0].comment,'My unsaved correction');assert.equal(f.changes(),1);
  f.comments.dispose();
});

test('editing an original comment cannot erase a newly arrived response',async()=>{
  const f=fixture();await f.comments.refresh();
  const comment=f.created[0].comments[0];await f.command('editComment',comment);
  comment.body='Unsaved author revision';
  f.data.history[0].replies.push({id:'response',text:'Agent response'});f.data.revision++;
  await f.comments.refresh();
  assert.equal(await f.command('saveComment',comment),false);
  assert.equal(comment.body,'Unsaved author revision');assert.equal(f.data.history[0].comment,'Please clarify this.');
  assert.equal(f.data.history[0].replies.length,1);assert.match(f.errors[0],/received a response/);
  await f.command('cancelComment',comment);assert.equal(comment.body,'Please clarify this.');
  f.comments.dispose();
});

test('a new native comment pins the original selection even if the buffer changes before submit',async()=>{
  const f=fixture([]);f.documents[0].change('🙂 selected words.');
  f.editor.selection=new Selection(new Position(0,3),new Position(0,17));
  const thread=await f.comments.annotate(f.editor);
  f.documents[0].change('🙂 Different text now.');f.data.revision++;
  assert.equal(await f.command('reply',{thread,text:'Feedback on my earlier selection.'}),true);
  const write=f.requests.find(request=>request.route==='/note');
  assert.equal(write.body.text,'🙂 selected words.');assert.equal(write.body.start,3);assert.equal(write.body.end,17);
  assert.equal(write.body.revision,2);assert.equal(f.documents[0].text,'🙂 Different text now.');
  assert.equal(f.created.length,1);assert.equal(f.created[0],thread);
  f.comments.dispose();
});

test('native follow-ups use the existing discussion parent and preserve earlier replies',async()=>{
  const f=fixture([source('root','main.tex','Original',{replies:[{id:'response',text:'Prior response'}]})]);
  await f.comments.refresh();
  await f.command('reply',{thread:f.created[0],text:'Please revisit the last sentence.'});
  const write=f.requests.find(request=>request.route==='/note');
  assert.equal(write.body.parent,'root');assert.equal(f.data.history[0].comment,'Original');
  assert.deepEqual(f.data.history[0].replies,[{id:'response',text:'Prior response'}]);
  assert.equal(f.data.history[1].origin_id,'root');assert.equal(f.created.length,1);
  assert.equal(f.created[0].comments.length,3);
  f.comments.dispose();
});

test('current edit notes stay editable and use the ordinary current-note operation',async()=>{
  const f=fixture([]);
  f.data.files=[{path:'main.tex',hunks:[{id:'passage',line:1,before:'Old',after:'New',edits:[{id:'edit',old:'Old',new:'New'}]}]}];
  f.data.comments={edit:'Current edit note'};await f.comments.refresh();
  const thread=f.created[0],comment=thread.comments[0];
  assert.equal(thread.canReply,false);assert.equal(comment.editable,true);
  await f.command('editComment',comment);comment.body='Revised current note';
  assert.equal(await f.command('saveComment',comment),true);
  assert.equal(f.data.comments.edit,'Revised current note');
  assert.equal(f.requests.some(request=>request.route==='/file'||request.route==='/draft'||request.route==='/apply'),false);
  f.comments.dispose();
});

test('a pinned current note retains its native thread when a response arrives',async()=>{
  const f=fixture([]);
  f.data.files=[{path:'main.tex',hunks:[{id:'passage',line:1,before:'Old',after:'New',edits:[{id:'edit',old:'Old',new:'New'}]}]}];
  f.data.comments={edit:'Current edit note'};await f.comments.refresh();
  const thread=f.created[0],root=thread.comments[0];thread.input='Still typing';
  f.data.history=[source('saved','main.tex','Current edit note',{kind:'edit',origin_id:'review:edit',replies:[{id:'answer',text:'Fixed.'}]})];
  f.data.comments={};f.data.revision++;await f.comments.refresh();
  assert.equal(f.created.length,1);assert.equal(thread.comments[0],root);
  assert.equal(thread.input,'Still typing');assert.equal(thread.canReply,true);
  assert.equal(thread.comments[1].body,'Fixed.');
  f.comments.dispose();
});

test('an agent explanation with identical text cannot take over the author’s current editor',async()=>{
  const f=fixture([]);
  f.data.files=[{path:'main.tex',hunks:[{id:'passage',line:1,before:'Old',after:'New',edits:[{id:'edit',old:'Old',new:'New'}]}]}];
  f.data.comments={edit:'Same text'};await f.comments.refresh();
  const thread=f.created[0],author=thread.comments[0];
  await f.command('editComment',author);author.body='Unsaved user change';
  f.data.history=[source('explanation','main.tex','Same text',{kind:'edit',author:'agent',origin_id:'review:edit'})];
  f.data.revision++;await f.comments.refresh();
  assert.equal(thread.comments[1],author);assert.equal(author.body,'Unsaved user change');
  assert.equal(author.editable,true);assert.equal(author.conflict,false);assert.equal(author.author.name,'You');
  assert.equal(thread.comments[0].author.name,'Agent');assert.notEqual(thread.comments[0],author);
  f.comments.dispose();
});

test('failed writes retain native comment drafts and their original anchors',async()=>{
  const f=fixture([]),thread=await f.comments.annotate(f.editor);
  thread.input='Keep this input';f.failNote(true);
  assert.equal(await f.command('reply',{thread,text:thread.input}),false);
  assert.equal(thread.input,'Keep this input');assert.equal(thread.disposed,undefined);
  assert.equal(f.data.history.length,0);assert.equal(f.changes(),0);
  f.failNote(false);assert.equal(await f.command('reply',{thread,text:thread.input}),true);
  assert.equal(f.data.history[0].comment,'Keep this input');
  f.comments.dispose();
});

test('navigation crosses files and expands the corresponding native discussion',async()=>{
  const f=fixture([source('second','other.tex'),source('first','main.tex')]);
  assert.equal(await f.comments.move(1),true);assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.opened,['/manuscript/main.tex','/manuscript/other.tex']);
  assert.equal(f.created[1].collapsibleState,f.vscode.CommentThreadCollapsibleState.Expanded);
  assert.deepEqual(await f.command('viewCommentChange',f.created[1]),{...f.data.history[0],resolved:false});
  f.comments.dispose();assert.equal(f.controller.disposed,true);assert.equal(f.created.every(thread=>thread.disposed),true);
});

test('resolve and reopen preserve native input, messages, decisions, and source buffers',async()=>{
  const f=fixture([source('root','main.tex','Original',{replies:[{id:'response',text:'Addressed.'}]}),
    source('follow','main.tex','Follow-up',{origin_id:'root'})]);
  f.data.decisions={edit:'reject'};f.documents[0].change('Dirty selected words.');
  await f.comments.refresh();const thread=f.created[0],messages=thread.comments;
  thread.input='Unsaved reply';thread.collapsibleState=f.vscode.CommentThreadCollapsibleState.Expanded;
  assert.equal(await f.command('resolveComment',thread),true);
  assert.deepEqual(f.data.resolved,['root']);assert.equal(thread.state,f.vscode.CommentThreadState.Resolved);
  assert.equal(thread.contextValue,'manuscriptReview.resolved');
  assert.equal(thread.collapsibleState,f.vscode.CommentThreadCollapsibleState.Collapsed);
  assert.equal(thread.input,'Unsaved reply');assert.deepEqual(thread.comments,messages);
  thread.collapsibleState=f.vscode.CommentThreadCollapsibleState.Expanded;
  await f.comments.refresh();assert.equal(thread.collapsibleState,f.vscode.CommentThreadCollapsibleState.Expanded);
  assert.equal(await f.command('reopenComment',thread),true);
  assert.deepEqual(f.data.resolved,[]);assert.equal(thread.state,f.vscode.CommentThreadState.Unresolved);
  assert.equal(thread.input,'Unsaved reply');assert.deepEqual(f.data.decisions,{edit:'reject'});
  assert.equal(f.documents[0].getText(),'Dirty selected words.');assert.equal(f.documents[0].isDirty,true);
  assert.ok(f.requests.every(request=>['/editor','/thread'].includes(request.route)));
  f.comments.dispose();
});

test('comment navigation skips resolved threads by default and All includes them',async()=>{
  const f=fixture([source('first','main.tex'),source('second','other.tex')]);
  f.data.resolved=['first'];await f.comments.refresh();
  assert.equal(await f.comments.move(1),true);assert.equal(f.opened.at(-1),'/manuscript/other.tex');
  assert.equal(await f.command('commentFilter'),true);
  f.vscode.window.activeTextEditor=undefined;
  assert.equal(await f.comments.move(-1),true);assert.equal(f.opened.at(-1),'/manuscript/main.tex');
  f.comments.dispose();
});

test('navigation follows the current cursor and dirty-buffer anchors instead of original line numbers',async()=>{
  const f=fixture([source('last','main.tex','Last comment',{line:1,before:'Last'}),
    source('first','main.tex','First comment',{line:99,before:'First'}),
    source('middle','main.tex','Middle comment',{line:50,before:'Middle'})]);
  f.documents[0].change('🙂 First\nGap\nMiddle\nGap\nLast');
  f.editor.selection=new Selection(new Position(1,1),new Position(1,1));
  f.vscode.window.activeTextEditor=f.editor;
  assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(2,0));
  assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(4,0));
  f.vscode.window.activeTextEditor.selection=new Selection(new Position(0,4),new Position(0,4));
  assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(2,0));
  f.vscode.window.activeTextEditor.selection=new Selection(new Position(1,1),new Position(1,1));
  assert.equal(await f.comments.move(-1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(0,3));
  assert.equal(f.documents[0].isDirty,true);
  assert.equal(f.requests.every(request=>request.route==='/editor'),true);
  f.comments.dispose();
});

test('navigation starts from the active end of a native selection',async()=>{
  const f=fixture([source('first','main.tex','First',{before:'First'}),
    source('middle','main.tex','Middle',{before:'Middle'}),source('last','main.tex','Last',{before:'Last'})]);
  f.documents[0].change('First\nMiddle\nLast');
  f.editor.selection=new Selection(new Position(0,0),new Position(1,3));
  f.vscode.window.activeTextEditor=f.editor;
  assert.equal(await f.comments.move(1),true);
  assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(2,0));
  f.comments.dispose();
});

test('a cursor in a source file without comments starts traversal at the adjacent commented file',async()=>{
  const f=fixture([source('first','main.tex'),source('last','other.tex')]);
  const native={document:document('narrative.tex','Current reading location'),selection:new Selection(new Position(0,5),new Position(0,5))};
  f.documents.push(native.document);f.vscode.window.activeTextEditor=native;
  assert.equal(await f.comments.move(1),true);
  assert.equal(f.opened.at(-1),'/manuscript/other.tex');
  f.vscode.window.activeTextEditor=native;
  assert.equal(await f.comments.move(-1),true);
  assert.equal(f.opened.at(-1),'/manuscript/main.tex');
  f.comments.dispose();
});

test('threads sharing an anchor retain sequential navigation and stop at the ends',async()=>{
  const f=fixture([source('first'),source('second'),source('third')]);
  for(const [direction,id] of [[1,'first'],[1,'second'],[1,'third'],[1,'third'],[-1,'second'],[-1,'first'],[-1,'first']]) {
    for(const thread of f.created)thread.collapsibleState=f.vscode.CommentThreadCollapsibleState.Collapsed;
    assert.equal(await f.comments.move(direction),true);
    assert.deepEqual(f.created.filter(thread=>thread.collapsibleState===f.vscode.CommentThreadCollapsibleState.Expanded)
      .map(thread=>thread.reviewState.entry.id),[id]);
  }
  f.comments.dispose();
});

test('navigation skips comments without a current source anchor',async()=>{
  const f=fixture([source('unmapped'),source('mapped')]),request=f.runtime.request;
  f.runtime.request=async function(route,body){
    const result=await request.call(this,route,body);
    if(route==='/editor')result.notes=result.notes.filter(note=>note.id==='mapped');
    return result;
  };
  assert.equal(await f.comments.move(1),true);
  assert.equal(f.created.find(thread=>thread.reviewState.entry.id==='unmapped').range,undefined);
  assert.deepEqual(f.created.filter(thread=>thread.collapsibleState===f.vscode.CommentThreadCollapsibleState.Expanded)
    .map(thread=>thread.reviewState.entry.id),['mapped']);
  f.comments.dispose();
});

test('navigation does not use retained anchors after a buffer changes during refresh',async()=>{
  const f=fixture();await f.comments.refresh();
  f.documents[0].change('First selected words. A preceding edit.');
  f.beforeProjection(()=>f.documents[0].change('The native buffer changed while mapping.'));
  assert.equal(await f.comments.move(1),false);
  assert.equal(f.opened.length,0);assert.equal(f.created[0].disposed,undefined);
  f.comments.dispose();
});

test('navigation does not apply mapped selections when source or review changes while opening the editor',async()=>{
  for(const change of [f=>f.documents[0].change('A newer dirty buffer.'),f=>f.runtime.review.id='other-review',f=>f.runtime.review.revision++]) {
    const f=fixture(),show=f.vscode.window.showTextDocument;
    f.vscode.window.showTextDocument=async function(document){const editor=await show.call(this,document);change(f);return editor;};
    assert.equal(await f.comments.move(1),false);
    assert.deepEqual(f.vscode.window.activeTextEditor.selection.start,new Position(0,0));
    assert.equal(f.created[0].collapsibleState,f.vscode.CommentThreadCollapsibleState.Collapsed);
    f.comments.dispose();
  }
});

test('a moving dirty buffer never receives offsets calculated for earlier text',async()=>{
  const f=fixture();f.beforeProjection(()=>f.documents[0].change('The buffer changed while mapping.'));
  await f.comments.refresh();assert.equal(f.created.length,0);
  assert.equal(f.requests.some(request=>request.route==='/note'),false);
  f.comments.dispose();
});

test('visible reviewed files receive one shared projection even without comments',async()=>{
  const f=fixture([]);f.data.files=[{path:'main.tex',hunks:[]}];
  f.documents[0].change('🙂 Unsaved selected words.');
  f.vscode.window.visibleTextEditors=[f.editor,{document:f.documents[0]},{document:f.documents[1]}];
  await f.comments.refresh();
  assert.equal(f.requests.length,1);assert.equal(f.created.length,0);assert.equal(f.projections.length,1);
  assert.equal(f.projections[0].projection.text,'🙂 Unsaved selected words.');
  assert.equal(f.projections[0].projection.document,f.documents[0]);
  assert.equal(f.projections[0].data.revision,f.data.revision);
  f.comments.dispose();
});

test('projection callbacks reject an earlier file changed while another file was mapping',async()=>{
  const f=fixture([source('first'),source('second','other.tex')]);
  f.beforeProjection(body=>{if(body.file==='other.tex')f.documents[0].change('Edited during the second request.');});
  await f.comments.refresh();
  assert.equal(f.projections.length,0);assert.equal(f.created.length,0);
  f.comments.dispose();
});

test('native annotation with an empty selection captures the whole current line',async()=>{
  const f=fixture([]);f.documents[0].change('🙂 Intro\nFull selected words here.\nLast');
  f.editor.selection=new Selection(new Position(1,5),new Position(1,5));
  const thread=await f.comments.annotate(f.editor);
  assert.deepEqual(thread.range,new Range(new Position(1,25),new Position(1,25)));
  await f.command('reply',{thread,text:'Please revise this sentence.'});
  const write=f.requests.find(request=>request.route==='/note');
  assert.equal(write.body.text.slice(write.body.start,write.body.end),'Full selected words here.');
  f.comments.dispose();
});

test('source commenting keeps explicit actions available without painting the file gutter and toggles without losing threads',async()=>{
  const f=fixture(),provider=f.controller.commentingRangeProvider;
  const unsupported=document('code.js','Text');
  assert.deepEqual(provider.provideCommentingRanges(unsupported),[]);
  assert.deepEqual(provider.provideCommentingRanges({...unsupported,uri:uri('/elsewhere/file.tex')}),[]);
  assert.deepEqual(provider.provideCommentingRanges({...unsupported,uri:{scheme:'untitled'}}),[]);
  await assert.rejects(f.comments.annotate({document:unsupported,selection:f.editor.selection}),/source file/);
  assert.equal(f.requests.length,0);
  await f.comments.refresh();
  const thread=f.created[0];thread.input='Unsubmitted reply';
  f.runtime.review=undefined;
  assert.deepEqual(provider.provideCommentingRanges(f.documents[0]),[]);
  f.comments.setEnabled(false);assert.equal(f.controller.commentingRangeProvider,undefined);
  f.comments.setEnabled(true);assert.equal(f.controller.commentingRangeProvider,provider);
  assert.equal(thread.disposed,undefined);assert.equal(thread.input,'Unsubmitted reply');
  f.comments.dispose();
});

test('review switches retain an unsubmitted native reply until its original review returns',async()=>{
  const f=fixture();await f.comments.refresh();
  const history=structuredClone(f.data.history),thread=f.created[0];
  thread.input='My unsubmitted reply';thread.collapsibleState=f.vscode.CommentThreadCollapsibleState.Expanded;
  f.runtime.review.id='earlier-review';f.data.history=[];f.data.revision++;
  await f.comments.refresh();
  assert.equal(thread.disposed,undefined);assert.equal(thread.label,'Other review');
  assert.equal(thread.collapsibleState,f.vscode.CommentThreadCollapsibleState.Collapsed);
  assert.equal(thread.input,'My unsubmitted reply');
  assert.equal(await f.command('reply',{thread,text:thread.input}),false);
  assert.match(f.errors[0],/Return to this comment’s review/);
  assert.equal(await f.command('viewCommentChange',thread),false);
  assert.equal(f.requests.some(request=>request.route==='/note'),false);
  f.runtime.review.id='review';f.data.history=history;f.data.revision++;
  await f.comments.refresh();
  assert.equal(f.created.length,1);assert.equal(thread.label,undefined);
  assert.equal(thread.collapsibleState,f.vscode.CommentThreadCollapsibleState.Expanded);
  assert.equal(thread.input,'My unsubmitted reply');
  assert.equal(await f.command('reply',{thread,text:thread.input}),true);
  assert.equal(f.data.history[1].comment,'My unsubmitted reply');
  assert.equal(f.data.history[1].origin_id,'root');
  f.comments.dispose();
});

test('an unsaved new native comment survives switching away and returning',async()=>{
  const f=fixture([]),thread=await f.comments.annotate(f.editor);
  thread.input='Draft feedback';f.runtime.review.id='other-review';await f.comments.refresh();
  assert.equal(thread.disposed,undefined);assert.equal(thread.label,'Other review');
  assert.equal(thread.input,'Draft feedback');
  assert.equal(await f.command('reply',{thread,text:thread.input}),false);
  f.runtime.review.id='review';await f.comments.refresh();
  assert.equal(thread.label,undefined);assert.equal(thread.contextValue,'manuscriptReview.pending');
  assert.equal(thread.collapsibleState,f.vscode.CommentThreadCollapsibleState.Expanded);
  assert.equal(await f.command('reply',{thread,text:thread.input}),true);
  assert.equal(f.created.length,1);assert.equal(f.data.history[0].comment,'Draft feedback');
  f.comments.dispose();
});

test('matching current edit identities in unrelated repositories keep independent native editors',async()=>{
  const f=fixture([]);
  f.data.files=[{path:'main.tex',hunks:[{id:'passage',line:1,before:'Old',after:'New',edits:[{id:'edit',old:'Old',new:'New'}]}]}];
  f.data.comments={edit:'Original repository note'};await f.comments.refresh();
  const first=f.created[0],comment=first.comments[0];await f.command('editComment',comment);
  comment.body='Unsaved original edit';
  const second=document('main.tex','Other selected words.');second.uri=uri('/other-manuscript/main.tex');
  f.documents.push(second);f.runtime.review={id:'other-review',repo:'/other-manuscript',revision:2};
  f.data.comments={edit:'Other repository note'};f.data.revision++;
  await f.comments.refresh();
  assert.equal(f.created.length,2);assert.equal(first.disposed,undefined);assert.equal(first.label,'Other review');
  assert.equal(comment.body,'Unsaved original edit');assert.equal(f.created[1].comments[0].body,'Other repository note');
  assert.equal(f.created[1].uri.toString(),'file:///other-manuscript/main.tex');
  f.comments.dispose();
});

test('a pending native reply cannot move to another round while its source loads',async()=>{
 const f=fixture([]),thread=await f.comments.annotate(f.editor);
 thread.input='My pending annotation';
 f.vscode.workspace.textDocuments=[];
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 f.vscode.workspace.openTextDocument=async()=>{entered();await gate;return f.documents[0];};
 const saving=f.command('reply',{thread,text:thread.input});await started;
 f.runtime.review.id='another-review';release();
 assert.equal(await saving,false);assert.equal(f.requests.some(request=>request.route==='/note'),false);
 assert.equal(thread.input,'My pending annotation');assert.match(f.errors.at(-1),/original round|this comment’s review/);
 f.comments.dispose();
});


test('a removed-file change can receive one new native discussion against its pinned source',async()=>{
 const f=fixture([]),document=f.documents[0];document.uri={scheme:'manuscript-review-source',authority:'review',path:'/main.tex',query:'version=original',fsPath:'/main.tex',toString:()=> 'manuscript-review-source://review/main.tex?version=original'};
 f.vscode.window.activeTextEditor=f.editor;f.openDocument(async()=>document);
 const selected={editor:f.editor,source:{reviewId:'review',revision:1,file:'main.tex',text:document.text},span:{from:6,to:20}};
 const thread=await f.comments.discuss(selected);assert.equal(thread.canReply,true);assert.equal(f.created.length,1);
 assert.equal(await f.comments.discuss(selected),thread);assert.equal(f.created.length,1);
 await f.command('reply',{thread,text:'Keep this deleted wording.'});
 assert.equal(f.requests.find(request=>request.route==='/note').body.source,'selected-source');
 assert.equal(f.requests.find(request=>request.route==='/note').body.text,document.text);
 f.comments.dispose();
});
