'use strict';
import {choiceFor,selectedSource,editLocations,feedbackForPassage,decisionShortcut,reviewProgress,editContext,currentFeedback,sourceRange,agentRequest,commentThreads,commentShortcut} from './review_model.js';
import {createEditor} from './editor.js';
import {request,openSource,hostCommand,imageSource,copyText,exportFile,reviewReady,pdfFrame,hostMessage} from './host.js';
const embedded=Boolean(globalThis.acquireVsCodeApi);
let data, decisions={}, comments={}, drafts={}, active=0, passage=0, edit=0;
let view='auto', overrides={}, previewZoom=100, locations=[];
let saving=Promise.resolve(), saveFailed=false, commentTimer;
let uiTimer,draftTimer,editing=false,staleReview=false,commentScope='edit';
const draftChanges=new Map();
let positions={};
let fileEditor=null,editorFile=null,editorSource=null,editorInitial='',openingEditor=null,discussionOpen=null,discussionKey=null;
let noteTarget=null,noteTimer,pendingNoteId=null,noteSelection=0,commentId=null;
let navigatingComment=false;
const noteChanges=new Map();
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const choice=id=>choiceFor(id,decisions);
const readOnly=()=>data?.scope==='baseline';
const groupStatus=group=>readOnly()?'included':choice(group.id);
const currentFile=()=>data?.files[active];
const currentHunk=()=>currentFile()?.hunks[passage];
const currentEdit=()=>currentHunk()?.edits[edit];
const selectedFeedback=()=>feedbackForPassage(data?.history||[],currentHunk()).filter(entry=>commentScope==='passage'||entry.target?.id===currentHunk()?.id||entry.target?.id===currentEdit()?.id);
const currentCommentId=()=>noteTarget?.id||noteTarget?.parent||(selectedFeedback().some(entry=>entry.id===commentId)?commentId:commentScope==='passage'?currentHunk()?.id:currentEdit()?.id);
const needsMath=g=>g?.math||/\\(?:frac|sum|sqrt|int|prod|mathop)\b|\\begin\{(?:equation|align|algorithm)|\\\[/.test(g?.new||'');
const shownView=h=>['auto','diff','rendered','pdf'].includes(view)?(overrides[h.id]||(view==='auto'?(needsMath(currentEdit())?'rendered':'diff'):view)):view;
const niceName=path=>path.split('/').pop().replace(/\.[^.]+$/,'').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
function status(message,error=false){$('status')&&($('status').textContent=message);if($('status'))$('status').className=error?'error':'';}
function resultStatus(result,fallback){status(result.message||fallback);}
function setBusy(value){editing=value;document.body.classList.toggle('busy',value);document.querySelectorAll('header,.shell,#review-summary').forEach(element=>{element.inert=value;});}
const savedMessage=()=>data.scope!=='manuscript'&&reviewProgress(data.files,decisions).total&&reviewProgress(data.files,decisions).complete&&!data.applied?'Ready to apply. ⌘/Ctrl+Enter applies the review.':'Saved locally';
const currentUI=()=>{const scope=data?.scope||'round',previous=positions[scope]||{},file=editorFile||currentFile()?.path;positions[scope]={active:fileEditor?data.files.findIndex(item=>item.path===file):active,passage,edit,view,overrides,file,cursor:fileEditor?.position()??(previous.file===file?previous.cursor:0)};return {scope,positions,note:noteTarget?.id||noteTarget?.parent||commentId,previewZoom,wide:document.body.classList.contains('wide')};};
function remember(){
 const ui=currentUI();
 if(data){clearTimeout(uiTimer);uiTimer=setTimeout(()=>request('/ui',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({ui})}).catch(()=>{}),400);}
}
function button(label,action,cls='quiet'){const b=node('button',cls,label);b.type='button';b.addEventListener('click',action);return b;}
function keyButton(label,key,action,cls){const b=button(label,action,cls);b.append(node('span','key',key));b.setAttribute('aria-label',`${label} (${key})`);return b;}
async function post(path,values,notes,extra={}){
 const r=await request(path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({decisions:values,comments:notes,revision:data.revision,...extra})});
 const result=await r.json();if(!r.ok){if(result.stale){staleReview=true;$('review-notice').hidden=false;updateProgress();}throw new Error(result.error);}data.revision=result.revision;if(result.result)data.result=result.result;return result;
}
function retainDraft(id,text){
 draftChanges.set(id,text);clearTimeout(draftTimer);draftTimer=setTimeout(saveDrafts,350);updateProgress();
}
function saveDrafts(){
 clearTimeout(draftTimer);
 for(const [id,text] of draftChanges){
  draftChanges.delete(id);
  saving=saving.catch(()=>{}).then(()=>post('/draft',{}, {},{id,draft:text})).then(result=>{saveFailed=Boolean(draftChanges.size||noteChanges.size);if(!saveFailed)resultStatus(result);}).catch(error=>{saveFailed=true;if((text===null&&!Object.hasOwn(drafts,id))||drafts[id]===text)draftChanges.set(id,text);status(error.message,true);});
 }
}
function setNoteText(target,comment){
 target.comment=comment;
 if(comment.trim()||target.id||target.submitted)noteChanges.set(target,comment);else noteChanges.delete(target);
 clearTimeout(noteTimer);noteTimer=setTimeout(saveNotes,350);
}
function saveNotes(){
 clearTimeout(noteTimer);saveDrafts();
 for(const [target,comment] of noteChanges){
  noteChanges.delete(target);target.submitted=true;
  saving=saving.catch(()=>{}).then(()=>post('/note',{}, {},{...target,comment})).then(result=>{
   const entry=result.entry;
   if(entry){data.history=data.history.filter(previous=>previous.id!==entry.id);if(entry.comment.trim())data.history.push(entry);}
   target.id=entry?.comment.trim()?entry.id:null;
   if(!target.id)target.submitted=false;
   if(fileEditor&&editorFile===target.file){const range=fileEditor.range(target.marker);if(target.id&&range){fileEditor.addNote({id:entry.id,...range,replace:target.marker?.startsWith('note-')?target.marker:undefined});target.marker=entry.id;}else if(!target.id){fileEditor.removeNote(target.marker);target.parent=null;}}
   if(noteTarget===target)commentId=target.id||target.parent||null;
   saveFailed=Boolean(noteChanges.size||draftChanges.size);refreshCommentNavigation();remember();updateProgress();resultStatus(result);
  }).catch(error=>{saveFailed=true;if(!noteChanges.has(target)&&target.comment===comment)noteChanges.set(target,comment);status(error.message,true);});
 }
}
function save(){
 if(readOnly())return;
 clearTimeout(commentTimer);const values={...decisions},notes={...comments};status('Saving…');
 saving=saving.catch(()=>{}).then(()=>post('/save',values,notes)).then(result=>{saveFailed=Boolean(draftChanges.size||noteChanges.size);if(!saveFailed)status(savedMessage());}).catch(e=>{saveFailed=true;status(e.message,true);});
}
function refreshCommentNavigation(){
 const host=$('discussion'),selector=host.querySelector('select[aria-label="Manuscript comments"]');
 if(!selector)return;
 selector.replaceWith(sourceCommentSelector(currentCommentId()));
 host.querySelector('.comment-navigation')?.replaceWith(commentNavigation(currentCommentId()));
}
function setChoices(members,value,scope='edit'){
 if(editing||readOnly())return;
 if(drafts[currentFile()?.path]){status('Save or discard this file’s draft before changing its decisions.',true);return;}
 if(fileEditor)closeEditor(false);
 if(members.some(id=>(choice(id)==='reject')!==(value==='reject')))data.applied=false;
 members.forEach(id=>{if(value==='pending')delete decisions[id];else decisions[id]=value;});
 save();
 if(value==='pending')render();
 else if(scope==='file')moveFile(1);
 else if(scope==='passage')movePassage(1);
 else moveEdit(1);
 status('Saving…');
}
function displayText(value){return value&&!value.trim()?value.replace(/ /g,'␠').replace(/\t/g,'⇥').replace(/\n/g,'↵\n'):value;}
function marked(g,index){
 const s=groupStatus(g),span=node('span','change '+(s==='reject'?'rejected':'')+(g.id===currentEdit()?.id?' active-edit':''));
 span.dataset.edit=g.id;span.title=`Edit ${index+1} (${s})`;
 if(g.old)span.append(node('del',g.old.trim()?'':'whitespace',displayText(g.old)));
 const updated=g.new;if(updated)span.append(node('ins',updated.trim()?'':'whitespace',displayText(updated)));
 span.addEventListener('click',event=>{
  const offset=sourceRange(currentFile(),g,'selected',decisions)[0]+textOffset(event);
  const proposed=event.target.closest('ins');
  if(proposed&&!readOnly()){edit=index;openEditor(offset);}else selectEdit(passage,index);
 });return span;
}
function textOffset(event){
 const range=document.caretRangeFromPoint?.(event.clientX,event.clientY);
 if(!range||!event.currentTarget.contains(range.startContainer))return 0;
 return range.startOffset;
}
function sourceText(text,start){
 const span=node('span','source-text',text);
 if(!readOnly())span.addEventListener('click',event=>openEditor(start+textOffset(event)));
 return span;
}
function discussionEntry(entry,withLocation=false){
 const item=node('article','discussion-entry');
 const title=entry.title||(entry.author==='agent'?(entry.kind==='source'?'Feedback':'Why this changed'):'');
 if(title)item.append(node('h3','discussion-title',title));
 if(withLocation)item.append(node('div','comment-meta',`${entry.file}:${entry.line}`));
 if(entry.author!=='agent')item.append(node('div','discussion-speaker',entry.current?'You (awaiting response)':'You'));
 item.append(node('p','discussion-text',entry.comment));
 for(const reply of entry.replies)item.append(node('div','discussion-speaker','Agent response'),node('p','discussion-text',reply.text));
 const context=node('details','discussion-context');context.append(node('summary','',entry.kind==='source'?'Original text and context':'Original edit and context'));
 context.append(node('div','comment-meta',`Source comparison: ${entry.base.slice(0,7)} to ${entry.source_proposed.slice(0,7)}`));
 const source=node('div','exact-edit');
 if(entry.kind==='source')source.append(node('pre','discussion-original',entry.before));
 else{if(entry.before)source.append(node('span','word-label','Original'),node('del','',displayText(entry.before)));
 if(entry.proposed)source.append(node('span','word-label','Proposal'),node('ins','',displayText(entry.proposed)));}
 if(entry.revised!==undefined&&entry.revised!==null)source.append(node('span','word-label','Your revision'),node('pre','',entry.revised));
 const paragraph=node('pre','discussion-original',entry.context_before||'');
 context.append(source,paragraph);item.append(context);return item;
}
function showFeedback(){
 $('feedback-search').value='';renderFeedback();$('actions').close();$('feedback').showModal();
}
function renderFeedback(){
 const content=$('feedback-list');content.replaceChildren();
 const current=currentFeedback(data,comments),entries=[...current,...data.history],query=$('feedback-search').value.trim().toLowerCase();
 const filtered=entries.filter(entry=>[entry.file,entry.title,entry.comment,...entry.replies.map(reply=>reply.text)].filter(Boolean).join(' ').toLowerCase().includes(query));
 $('feedback-count').replaceChildren(commentNavigation(commentId));
 for(const entry of filtered){
  const item=discussionEntry(entry,true);
  item.dataset.discussionId=entry.id;item.tabIndex=0;
  item.append(button(entry.current?'Go to revision':'Open in manuscript',()=>{$('feedback').close();showComment(entry.id);},'discussion-link'));
  content.append(item);
 }
 if(!filtered.length)content.append(node('p','muted',query?'No matching feedback.':'No feedback yet. Use Comment to leave a note.'));
}
function commentNavigation(identifier){
 const threads=commentThreads(data,comments),entry=[...data.history,...currentFeedback(data,comments)].find(entry=>entry.id===identifier);
 const index=threads.findIndex(thread=>thread.origin_id===(entry?.origin_id||entry?.id)),bar=node('div','comment-navigation');
 const count=node('span','',index<0?`${threads.length} comments`:`${index+1} of ${threads.length}`);count.setAttribute('aria-live','polite');
 const previous=button('‹',()=>moveComment(-1),'nav-button'),next=button('›',()=>moveComment(1),'nav-button');
 previous.setAttribute('aria-label','Previous comment (⌘/Ctrl+Shift+[)');next.setAttribute('aria-label','Next comment (⌘/Ctrl+Shift+])');
 previous.disabled=!threads.length||index===0;next.disabled=!threads.length||index===threads.length-1;
 bar.append(count,previous,next);return bar;
}
function moveComment(direction){
 return navigateComment(()=>{
  const threads=commentThreads(data,comments),identifier=$('feedback').open?commentId:currentCommentId();
  const selected=threads.findIndex(entry=>entry.id===identifier||entry.origin_id===data.history.find(item=>item.id===identifier)?.origin_id);
  const index=selected<0?(direction>0?0:threads.length-1):Math.max(0,Math.min(threads.length-1,selected+direction));
  return threads[index]?.id;
 });
}
function showComment(identifier){return navigateComment(()=>identifier);}
async function navigateComment(select){
 if(navigatingComment||editing)return;
 navigatingComment=true;
 try{
  saveNotes();saveDrafts();save();await saving;
  if(saveFailed||draftChanges.size||noteChanges.size)throw new Error('Resolve the save error before moving to another comment.');
  if(openingEditor)await openingEditor;
  const identifier=select();$('feedback').close();
  const entry=[...data.history,...currentFeedback(data,comments)].find(entry=>entry.id===identifier);
  if(!entry)return;
  if(entry.current){await showRevision(entry);return;}
  if(embedded){await openSource({file:entry.file,comment:entry.id});return;}
  await switchScope('manuscript',entry.file);
  if(data.scope!=='manuscript')return;
  const index=data.files.findIndex(file=>file.path===entry.file);
  if(index<0){commentId=identifier;pendingNoteId=null;showFeedback();const item=[...$('feedback-list').children].find(item=>item.dataset.discussionId===identifier);item?.focus();item?.scrollIntoView({block:'nearest'});return;}
  if(fileEditor&&editorFile!==entry.file)closeEditor(false);
  active=index;passage=edit=0;commentId=identifier;pendingNoteId=identifier;render();await openEditor();
  if(fileEditor&&editorFile===entry.file){pendingNoteId=null;fileEditor.goTo(identifier);await selectSourceNote(identifier);fileEditor.focus();}
 }catch(error){status(error.message,true);}
 finally{navigatingComment=false;}
}
async function showRevision(entry){
 saveNotes();saveDrafts();save();await saving;
 if(saveFailed||draftChanges.size||noteChanges.size)throw new Error('Resolve the save error before opening the change.');
 await switchScope('round',entry.file);if(data.scope!=='round')return;
 const destination=locations.find(([fi,hi,ei])=>{const h=data.files[fi].hunks[hi];return entry.target?.id===h.id||entry.target?.id===h.edits[ei].id;});
 if(!destination)return;
 if(fileEditor)closeEditor(false);commentId=entry.id;[active,passage,edit]=destination;render();openComment(entry.target.kind==='passage');
}
function renderDiscussion(){
 if(fileEditor&&(data.scope==='manuscript'||noteTarget))return renderSourceDiscussion();
 const host=$('discussion');host.replaceChildren();
 const h=currentHunk(),g=currentEdit();
 if(!h||!g){host.hidden=true;document.body.classList.remove('has-discussion');return;}
 const key=g.id;if(discussionKey!==key){discussionKey=key;discussionOpen=null;}
 const identifier=commentScope==='passage'?h.id:g.id;
 const ids=new Set([h.id,...(commentScope==='passage'?h.edits.map(edit=>edit.id):[g.id])]);
 const history=[...selectedFeedback(),...currentFeedback(data,comments).filter(entry=>entry.id!==identifier&&ids.has(entry.id))];
 const visible=discussionOpen??Boolean(history.length||comments[g.id]?.trim()||comments[h.id]?.trim());
 host.hidden=!visible;document.body.classList.toggle('has-discussion',visible);
 if(!visible)return;
 const heading=node('div','discussion-head'),scope=node('select');scope.setAttribute('aria-label','Comment scope');
 for(const [value,label] of [['edit','This edit'],['passage','Whole passage']]){const option=node('option','',label);option.value=value;option.selected=commentScope===value;scope.append(option);}
 scope.addEventListener('change',()=>{commentScope=scope.value;renderDiscussion();$('comment-'+(commentScope==='passage'?h.id:g.id))?.focus();});
 const close=button('×',()=>{discussionOpen=false;renderDiscussion();fileEditor?.focus();},'icon');close.setAttribute('aria-label','Close discussion');heading.append(scope,close);host.append(heading,commentNavigation(currentCommentId()));
 for(const entry of history)host.append(discussionEntry(entry));
 if(!readOnly()){
  const area=node('textarea');area.id='comment-'+identifier;area.rows=5;area.maxLength=20000;area.value=comments[identifier]||'';area.setAttribute('aria-label',commentScope==='passage'?'Passage comment':'Edit comment');area.placeholder='Comment…';
  area.addEventListener('input',()=>{if(area.value)comments[identifier]=area.value;else delete comments[identifier];clearTimeout(commentTimer);commentTimer=setTimeout(save,350);updateProgress();});
  area.addEventListener('blur',save);host.append(area);
 }
}
function sourceNoteTarget(entry){
 const range=fileEditor.range(entry.id)||fileEditor.selection();
 const latest=data.history.filter(item=>item.origin_id===entry.origin_id).at(-1)||entry;
 return {...range,file:editorFile,source:editorSource,text:fileEditor.text(),parent:latest.id,
  id:latest.kind==='source'&&latest.author==='user'&&!latest.replies.length?latest.id:null,marker:entry.id,comment:latest.kind==='source'&&latest.author==='user'&&!latest.replies.length?latest.comment:''};
}
async function selectSourceNote(id){
 const path=editorFile,selection=++noteSelection;saveNotes();await saving;if(saveFailed||!fileEditor||editorFile!==path||selection!==noteSelection)return;const entry=data.history.find(entry=>entry.id===id&&entry.file===path);if(!entry)return;
 commentId=id;noteTarget=sourceNoteTarget(entry);discussionOpen=true;renderDiscussion();remember();
}
function commentSelection(){
 if(!fileEditor||editing)return;
 ++noteSelection;saveNotes();commentId=null;const marker='note-'+crypto.randomUUID();
 noteTarget={...fileEditor.selection(),file:editorFile,source:editorSource,text:fileEditor.text(),marker,comment:''};
 fileEditor.addNote({id:marker,...noteTarget});discussionOpen=true;renderSourceDiscussion();$('source-comment')?.focus();
}
function renderSourceDiscussion(){
 const host=$('discussion');host.replaceChildren();
 const entries=data.history.filter(entry=>entry.file===editorFile&&entry.comment.trim());
 const threads=commentThreads(data,comments);
 if(discussionOpen===false||(!threads.length&&!noteTarget)){host.hidden=true;document.body.classList.remove('has-discussion');return;}
 host.hidden=false;document.body.classList.add('has-discussion');
 const heading=node('div','discussion-head'),current=entries.find(entry=>entry.id===(noteTarget?.id||noteTarget?.parent)),selector=sourceCommentSelector(current?.id);
 const close=button('×',()=>{++noteSelection;saveNotes();discussionOpen=false;renderSourceDiscussion();fileEditor.focus();},'icon');close.setAttribute('aria-label','Close discussion');heading.append(selector,close);host.append(heading,commentNavigation(current?.id));
 if(!noteTarget){host.append(button('Comment selection',commentSelection));return;}
 const selected=noteTarget.text.slice(noteTarget.start,noteTarget.end);if(selected)host.append(node('pre','discussion-quote',selected.slice(0,240)));
 if(current)for(const entry of entries.filter(entry=>entry.origin_id===current.origin_id&&entry.id!==noteTarget.id))host.append(discussionEntry(entry));
 if(current?.target)host.append(button('View change',()=>showRevision(current).catch(error=>status(error.message,true)),'discussion-link'));
 const area=node('textarea');area.id='source-comment';area.rows=5;area.maxLength=20000;area.setAttribute('aria-label',current?'Manuscript comment':'New manuscript comment');area.placeholder=current&&!noteTarget.id?'Follow-up…':'Comment…';
 const target=noteTarget;area.value=target.comment??'';
 area.addEventListener('input',()=>setNoteText(target,area.value));
 area.addEventListener('blur',saveNotes);host.append(area);
}
function sourceCommentSelector(identifier){
 const selector=node('select');selector.setAttribute('aria-label','Manuscript comments');
 const placeholder=node('option','','Comments');placeholder.value='';selector.append(placeholder);
 const threads=commentThreads(data,comments),current=data.history.find(entry=>entry.id===identifier);
 for(const entry of threads){const option=node('option','',`${entry.file===editorFile?'Line '+entry.line:entry.file+':'+entry.line}: ${(entry.before||entry.comment).replace(/\s+/g,' ').slice(0,65)}`);option.value=entry.id;selector.append(option);}
 selector.value=current?threads.find(entry=>entry.origin_id===current.origin_id)?.id||'':'';
 selector.addEventListener('change',()=>{if(selector.value)showComment(selector.value);});return selector;
}
function renderSelection(context=$('selection')){
 const file=currentFile(),h=currentHunk();if(!context||!file)return;
 if(data.scope==='manuscript'){context.replaceChildren(node('span','context-name',niceName(file.path)));context.title=file.path;return;}
 if(!h)return;
 context.replaceChildren(node('span','context-name',niceName(file.path)),node('span','context-location',`Passage ${passage+1}/${file.hunks.length}`));
 if(h.edits.length>1)context.append(node('span','context-location',`Edit ${edit+1}/${h.edits.length}`));
 context.title=`${file.path}:${h.line}`;
}
async function openEditor(position){
 if(embedded){saveNotes();save();await saving;if(saveFailed||noteChanges.size)return;await openSource({file:currentFile()?.path,edit:currentEdit()?.id,position:typeof position==='number'?position:undefined});return;}
 if(editing||readOnly())return;
 if(openingEditor)return openingEditor;
 const path=currentFile()?.path;
 openingEditor=loadEditor(position);
 try{await openingEditor;}
 finally{openingEditor=null;if(data.scope==='manuscript'&&!fileEditor&&!editing&&currentFile()?.path!==path)openEditor();}
}
async function loadEditor(position){
 position=typeof position==='number'?position:undefined;
 if(fileEditor){fileEditor.focus();return;}
 const file=currentFile(),group=currentEdit();if(!file||(data.scope!=='manuscript'&&!group))return;
 const scope=data.scope;
 saveNotes();saveDrafts();save();await saving;
 if(saveFailed||draftChanges.size||currentFile()?.path!==file.path){status('Resolve the save error before editing.',true);return;}
 let doc;
 try{const response=await request('/editor?file='+encodeURIComponent(file.path));doc=await response.json();if(!response.ok)throw new Error(doc.error);if(doc.revision!==data.revision)throw new Error('The review changed. Reload before editing.');}
 catch(error){status(error.message,true);return;}
 if(fileEditor||data.scope!==scope||currentFile()?.path!==file.path||currentEdit()?.id!==group?.id)return;
 const draft=drafts[file.path];
 editorFile=file.path;editorSource=doc.source;editorInitial=doc.original;
 const text=doc.text,ranges=[...doc.notes,...doc.ranges].map(range=>({...range,current:range.id===group?.id}));
 if(draft&&position===undefined)position=ranges.find(range=>range.id===group?.id)?.from;
 const card=$('passage-'+passage);card.replaceChildren();
 document.body.classList.add('editing-file');
 const bar=node('div','editor-toolbar');
 if(data.scope!=='manuscript')bar.append(button('Return to review',()=>closeEditor(),'quiet'));
 const annotate=button('Comment selection',commentSelection,'quiet');annotate.title='Comment on selected text or the current line (⌘/Ctrl+Shift+M)';bar.append(annotate,button('Discussion',()=>{if(data.scope==='manuscript'||noteTarget){discussionOpen=true;renderSourceDiscussion();}else openComment(commentScope==='passage');},'quiet'));
 const discard=button('Discard draft',()=>{delete drafts[file.path];retainDraft(file.path,null);saveDrafts();closeEditor();},'quiet');discard.id='discard-file-draft';discard.hidden=!draft;
 const submit=button('Save changes',saveFile,'primary');submit.id='save-file';submit.disabled=text===editorInitial;bar.append(node('span','spacer'),discard,submit);card.append(bar);
 const surface=node('div','file-editor');surface.id='file-source';card.append(surface);
 document.querySelector('.decisionbar')?.remove();document.querySelector('.edit-list')?.closest('details')?.remove();
 fileEditor=createEditor(surface,{text,ranges,position:position??ranges.find(range=>range.id===group?.id)?.from??0,
  onChange:text=>{if(text===editorInitial){delete drafts[file.path];retainDraft(file.path,null);}else{const draft={file:file.path,source:editorSource,text};drafts[file.path]=draft;retainDraft(file.path,draft);}discard.hidden=!drafts[file.path];submit.disabled=text===editorInitial;},
  onSelect:id=>{if(data.history.some(entry=>entry.id===id)){selectSourceNote(id);return;}if(currentEdit()?.id===id)return;const hi=file.hunks.findIndex(h=>h.edits.some(g=>g.id===id));if(hi>=0){passage=hi;edit=file.hunks[hi].edits.findIndex(g=>g.id===id);renderSelection();renderDiscussion();remember();}},
  onSave:saveFile,onClose:()=>{if(data.scope==='manuscript')fileEditor.focus();else closeEditor();},onComment:commentSelection,onAgentRequest:copyAgentRequest,onMoveComment:moveComment});
 renderDiscussion();
 if(pendingNoteId){const identifier=pendingNoteId;pendingNoteId=null;fileEditor.goTo(identifier);await selectSourceNote(identifier);}
}
function closeEditor(redraw=true){
 ++noteSelection;currentUI();saveNotes();saveDrafts();fileEditor?.destroy();fileEditor=null;editorFile=null;noteTarget=null;discussionOpen=null;document.body.classList.remove('editing-file');
 if(redraw){render();focusSelection();}
}
async function saveFile(){
 if(!fileEditor||editing||readOnly())return;
 const text=fileEditor.text(),path=editorFile,source=editorSource,line=currentHunk()?.line||1,target=noteTarget;
 if(text===editorInitial){if(data.scope!=='manuscript')closeEditor();return;}
 const draft={file:path,source,text};drafts[path]=draft;retainDraft(path,draft);saveDrafts();
 fileEditor.setReadOnly(true);setBusy(true);status('Saving changes…');
 try{
  saveNotes();save();await saving;if(saveFailed||draftChanges.size||noteChanges.size)throw new Error('Resolve the save error before saving source.');
  saving=saving.then(()=>post('/file',{...decisions},{...comments},{file:path,source,text}));
  const result=await saving;
  if(data.scope==='manuscript'){const response=await request('/data?scope=manuscript');if(!response.ok)throw new Error('Changes saved; reload to refresh the manuscript.');data=await response.json();}else data=result.data;decisions=data.decisions;comments=data.comments;drafts=data.drafts;locations=editLocations(data);
  active=Math.max(0,data.files.findIndex(f=>f.path===path));passage=Math.max(0,data.files[active]?.hunks.findIndex(h=>h.line>=line)||0);edit=0;
  closeEditor(false);pendingNoteId=target?.id||target?.parent;saveFailed=false;remember();render();resultStatus(result);watchPreviews();
 }catch(error){status(error.message,true);fileEditor?.setReadOnly(false);}
 finally{setBusy(false);if(data.scope==='manuscript'&&!fileEditor)render();if(fileEditor)fileEditor.focus();else focusSelection();}
}
function updateSidebar(){
 const aside=$('files');aside.replaceChildren();aside.append(node('div','nav-label','Manuscript'));let supporting=false;
 data.files.forEach((f,i)=>{
  if(f.supporting&&!supporting){aside.append(node('div','nav-label','Supporting'));supporting=true;}
  const done=f.edits.filter(g=>choice(g.id)!=='pending').length;
  const b=button('',()=>{active=i;passage=edit=0;render();focusSelection();},'file'+(i===active?' active':''));b.title=f.path;b.setAttribute('aria-label',f.path);
  if(i===active)b.setAttribute('aria-current','true');
  b.append(node('span','file-name',niceName(f.path)));if(data.scope!=='manuscript')b.append(node('span','file-count',readOnly()?`${f.edits.length} changes`:`${done}/${f.edits.length}`));aside.append(b);
 });
}
function updateProgress(){
 const all=data.files.flatMap(f=>f.edits),progress=reviewProgress(data.files,decisions);
 const accepted=all.filter(g=>groupStatus(g)==='accept').length,rejected=all.filter(g=>groupStatus(g)==='reject').length;
 const count=Object.values(comments).filter(c=>c.trim()).length+data.history.filter(entry=>entry.kind==='source'&&!entry.replies.length&&entry.comment.trim()).length;
 const draftCount=Object.keys(drafts).length;
 $('draft-status').hidden=!Object.keys(drafts).length;$('draft-status').textContent=`${Object.keys(drafts).length} ${Object.keys(drafts).length===1?'draft':'drafts'}`;
 $('progress').disabled=readOnly()||!progress.complete;
 $('progress').textContent=readOnly()?`${progress.total} changes since baseline`:progress.complete?'Review complete':`${progress.done} of ${progress.total} reviewed`;
 $('progress').hidden=data.scope==='manuscript';
 $('progress').title=readOnly()?'Original baseline to selected manuscript':`${accepted} accepted, ${rejected} rejected, ${all.length-accepted-rejected} undecided, ${count} ${count===1?'comment':'comments'}`;
 $('review-summary').hidden=data.scope==='manuscript'||readOnly()||!progress.total||!progress.complete;
 $('review-state').textContent=`${staleReview?'Reload to continue':saveFailed||draftChanges.size?'Changes need saving':data.applied?'Applied to manuscript':'Ready to apply'}${count?`. ${count} ${count===1?'comment':'comments'}`:''}${draftCount?`. ${draftCount} ${draftCount===1?'draft':'drafts'}`:''}`;
 $('handoff-hint').textContent=draftCount?'Save or discard your file drafts before requesting text revisions.':'Paste the request into your agent’s chat.';
 $('copy-request-header').hidden=readOnly()||(data.scope!=='manuscript'&&progress.complete&&progress.total>0)||!count;
 $('copy-request').className=data.applied?'primary':'quiet';
 const finish=$('finish-review');finish.hidden=false;
 finish.textContent=data.applied?'Applied':'Apply review';finish.disabled=Boolean(data.applied)||Boolean(draftCount);$('apply').disabled=Boolean(draftCount)||editing;
 finish.title=data.applied?'Your selected wording has been written to the manuscript.':'Write your selected wording to the manuscript (⌘/Ctrl+Enter)';
}
function selected(f){
 return selectedSource(f,decisions);
}
function sourceBody(h,f,fullPassage=false){
 if(!fullPassage){
  const g=h.edits[edit],context=editContext(h,edit);
 const code=f.supporting||f.path.endsWith('.bib')||/\\[A-Za-z]+[\[{]/.test(context.before+g.old+g.new+context.after);
  const body=node('div','passage-body'+(code?' code':'')),wrap=node('div'),large=g.old.length+g.new.length>6500;
  const shown=large?{...g,old:g.old.slice(0,4000),new:g.new.slice(0,4000)}:g;
  if(context.leading)body.append(node('span','ellipsis','… '));
  const [start,end]=sourceRange(f,g,'selected',decisions);
  body.append(sourceText(context.before,start-context.before.length),marked(shown,edit),sourceText(context.after,end));
  if(context.trailing)body.append(node('span','ellipsis',' …'));wrap.append(body);
  if(context.trimmed||large){const full=node('details','detail');full.dataset.key='full-passage-'+h.id;full.append(node('summary','','Full passage'),sourceBody(h,f,true));wrap.append(full);}
  return wrap;
 }
 const code=f.supporting||f.path.endsWith('.bib')||h.edits.some(needsMath)||needsMath({new:h.after});
 const body=node('div','passage-body'+(code?' code':''));
 const large=h.grouped_segments.some(g=>g.members&&(g.old.length+g.new.length)>6500);
 function populate(full){
  const first=h.edits[0],prefix=h.grouped_segments.slice(0,h.grouped_segments.findIndex(g=>g.id===first.id)).map(g=>g.text).join('');let offset=sourceRange(f,first,'selected',decisions)[0]-prefix.length;
  body.replaceChildren();let index=0;if(h.leading)body.append(node('span','ellipsis','… '));
  h.grouped_segments.forEach(g=>{
   if(g.members){const shown=large&&!full?{...g,old:g.old.slice(0,4000),new:g.new.slice(0,4000)}:g;body.append(marked(shown,index++));offset+=choice(g.id)==='reject'?g.old.length:g.new.length;}
   else{body.append(sourceText(g.text,offset));offset+=g.text.length;}
  });
  if(h.trailing)body.append(node('span','ellipsis',' …'));
 }
 populate(false);const wrap=node('div');wrap.append(body);
 if(large){let full=false;const more=button('Show complete source',()=>{full=!full;populate(full);more.textContent=full?'Collapse long source':'Show complete source';});more.className='long';wrap.append(more);}return wrap;
}
function renderedPair(h){
 const pair=node('div','typeset-pair');
 for(const side of ['before','after']){
  const pane=node('figure','typeset-pane'),caption=node('figcaption');
 caption.textContent=side==='before'?(readOnly()?'Baseline':'Original'):(readOnly()?'Selected':'Proposed');pane.append(caption);
  const r=h.rendered?.[side],scroll=node('div','image-scroll');
  if(r?.asset){const image=node('img');imageSource(image,(readOnly()?'/baseline-assets/':'/assets/')+r.asset);image.alt=`${side==='before'?'Original with deletions in red':'Revision with additions in green'}, passage ${passage+1}`;scroll.append(image);}
  else scroll.append(node('p','render-note',['queued','rendering'].includes(data.preview_status)?'Typesetting your revision… Word changes are available.':'No typeset preview for this passage. Select Word changes.'));
  if(side==='after'&&!readOnly()){scroll.classList.add('editable-preview');scroll.addEventListener('click',()=>openEditor());}
  pane.append(scroll);pair.append(pane);
 }
 return pair;
}
function pdfPair(group,pair=node('div','typeset-pair pdf-pair')){
 for(const side of ['before','after']){
  const previous=pair.children[side==='before'?0:1];
  const document=data.documents?.[side],pane=node('figure','typeset-pane'),caption=node('figcaption');
  const label=side==='before'?(readOnly()?'Baseline':'Original'):(readOnly()?'Selected':'Proposed');
  const marks=document?.edits[group.id]||[],numbers=[...new Set(marks.map(mark=>mark.page))];
  caption.textContent=label;pane.append(caption);
  if(embedded&&document?.pdf){
   const frame=previous?.querySelector('.pdf-viewer')||node('iframe','pdf-viewer');frame.title=label+' PDF';
   if(previous?.contains(frame))previous.querySelector('figcaption').textContent=label;
   else{pane.append(frame);if(previous)previous.replaceWith(pane);else pair.append(pane);}
   const normalized=marks.map(mark=>{const page=document.pages[mark.page-1];return {...mark,bounds:mark.bounds?.map((value,index)=>Math.max(0,Math.min(1,value/(index%2?page.height:page.width))))??null};});
   pdfFrame(frame,{path:(readOnly()?'/baseline-assets/':'/assets/')+document.pdf,marks:normalized,color:side==='before'?'removed':'added'}).catch(error=>{frame.replaceWith(node('p','render-note',error.message));});
   continue;
  }
  const scroll=node('div','image-scroll pdf-scroll');
  if(document?.pages.length&&!marks.length)scroll.append(node('p','render-note','No direct PDF location for this source edit.'));
  if(!document?.pages.length)scroll.append(node('p','render-note',['queued','rendering'].includes(data.preview_status)?'Typesetting your revision…':document?.error||data.preview_error||'Choose a LaTeX document in the Library to render its PDF.'));
  for(const number of numbers){
   const page=document.pages[number-1],frame=node('div','pdf-page'),image=node('img'),pageMarks=marks.filter(mark=>mark.page===number);
   frame.style.aspectRatio=`${page.width}/${page.height}`;
   imageSource(image,(readOnly()?'/baseline-assets/':'/assets/')+page.asset);image.alt=`${label}, PDF page ${number} of ${document.pages.length}`+(pageMarks.some(mark=>mark.bounds)?', selected edit highlighted':'');
   frame.append(image);
   if(!pageMarks.some(mark=>mark.bounds))scroll.append(node('p','render-note','PDF page located; highlight unavailable.'));
   for(const mark of pageMarks.filter(mark=>mark.bounds)){
    const [left,top,right,bottom]=mark.bounds,box=node('span','pdf-mark '+(side==='before'?'removed':'added'));
    box.style.left=left/page.width*100+'%';box.style.top=top/page.height*100+'%';
    box.style.width=Math.max(1,right-left)/page.width*100+'%';box.style.height=Math.max(1,bottom-top)/page.height*100+'%';
    box.title=mark.location?'Source-linked location':mark.precision==='words'?'Selected word change':'Source-linked typeset region';frame.append(box);
   }
   if(number===numbers[0])image.addEventListener('load',()=>{if(image.isConnected)focusPDF();});
   scroll.append(frame,node('div','pdf-page-number',`Page ${number} of ${document.pages.length}`));
  }
  if(side==='after'&&!readOnly()){scroll.classList.add('editable-preview');scroll.addEventListener('click',()=>openEditor());}
  pane.append(scroll);if(previous)previous.replaceWith(pane);else pair.append(pane);
 }
 return pair;
}
function focusPDF(){
 document.querySelectorAll('.pdf-scroll').forEach(scroll=>{
  const mark=scroll.querySelector('.pdf-mark');if(!mark)return;
  const position=mark.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();
  scroll.scrollTop=Math.max(0,scroll.scrollTop+position.top-viewport.top-scroll.clientHeight*.4);
  scroll.scrollLeft=Math.max(0,scroll.scrollLeft+position.left-viewport.left-scroll.clientWidth*.4);
 });
}
function exactEdit(g){
 const row=node('div','exact-edit');
 if(g.old)row.append(node('span','word-label','Removed'),node('del','',displayText(g.old)));
 const updated=g.new;if(updated)row.append(node('span','word-label','Added'),node('ins','',displayText(updated)));return row;
}
function allEdits(h){
 const detail=node('details','detail');detail.dataset.key='individual-'+h.id;detail.append(node('summary','',`All ${h.edits.length} edits in this passage`));
 const list=node('ol','edit-list');h.edits.forEach((g,i)=>{
  const li=node('li'),b=button('',()=>selectEdit(passage,i),'edit-option');if(i===edit)b.setAttribute('aria-current','true');
  const meta=node('span','edit-number');meta.append(node('span','',`${i+1}`),node('span','',groupStatus(g)));if(comments[g.id]?.trim())meta.append(node('span','','comment'));b.append(meta);
  if(g.old)b.append(node('del','',displayText(g.old)));const updated=g.new;if(updated)b.append(node('ins','',displayText(updated)));li.append(b);list.append(li);
 });detail.append(list);return detail;
}
function bulkControls(id,members,scope){
 const box=$(id);box.replaceChildren();[['Accept','accept'],['Reject','reject'],['Reset','pending']].forEach(([label,value])=>box.append(button(label,()=>{setChoices(members,value,scope);$('actions').close();focusSelection();},'')));
}
function render(){
 if(!data)return;
 document.body.classList.remove('pdf-review');
 if(fileEditor&&editorFile===currentFile()?.path){fileEditor.goTo(currentEdit()?.id);renderSelection();updateSidebar();updateProgress();renderDiscussion();return;}
 if(fileEditor)closeEditor(false);
 $('manuscript-title').textContent=data.manuscript||data.repo.split('/').pop();
 $('manuscript-title').title=`${data.repo}\nBase: ${data.base}\nProposal: ${data.proposed}`;
 $('round-state').hidden=!data.manuscript;$('round-state').textContent=`Round ${data.round_number}${data.latest_review&&data.latest_review!==data.id?' (earlier)':''}`;
 $('comparison').value=data.scope;
 $('apply').hidden=$('next').hidden=readOnly();
 for(const id of ['passage-actions','file-actions'])$(id).closest('.dialog-section').hidden=readOnly();
 $('snapshot').textContent=`${data.base.slice(0,7)} to ${data.proposed.slice(0,7)}`;
 if(data.scope==='manuscript'){
  updateSidebar();updateProgress();remember();const main=$('main');main.replaceChildren();main.classList.remove('rendered');
  if(!currentFile()){main.append(node('p','muted','No manuscript text files in this version.'));return;}
  const bar=node('div','contextbar'),context=node('div','context');context.id='selection';renderSelection(context);bar.append(context);main.append(bar);
  const card=node('section','passage selected-passage');card.id='passage-'+passage;card.setAttribute('aria-label','Manuscript source');main.append(card);
  const statusLine=node('div','statusline'),message=node('span');message.id='status';message.setAttribute('role','status');statusLine.append(message);main.append(statusLine);
  const position=positions.manuscript||{};if(!editing)openEditor(position.file===currentFile().path?position.cursor||0:0);return;
 }
 if(!data.files.length){$('main').replaceChildren(node('h2','',readOnly()?'No accumulated changes':'No changes this round'),node('p','muted',readOnly()?'The selected manuscript matches the original baseline.':'The selected draft matches this round’s starting version. Earlier comments remain in All feedback.'));updateSidebar();updateProgress();renderDiscussion();return;}
 const oldStatus=$('status')?.textContent||'',oldError=$('status')?.classList.contains('error');
 const open=new Set([...document.querySelectorAll('main details[open]')].map(d=>d.dataset.key));
 const f=currentFile();passage=Math.max(0,Math.min(passage,f.hunks.length-1));edit=Math.max(0,Math.min(edit,currentHunk().edits.length-1));
 const h=currentHunk(),g=currentEdit(),display=shownView(h);
 document.body.classList.toggle('pdf-review',embedded&&display==='pdf');
 updateSidebar();updateProgress();remember();
 bulkControls('passage-actions',h.edits.map(g=>g.id),'passage');bulkControls('file-actions',f.edits.map(g=>g.id),'file');
 const main=$('main'),existing=embedded&&display==='pdf'?main.querySelector('.selected-passage:has(.pdf-viewer)'):null;
 if(existing){for(const child of [...main.children])if(child!==existing)child.remove();}else main.replaceChildren();
 main.classList.toggle('rendered',['rendered','pdf'].includes(display));
 const bar=node('div','contextbar'),context=node('div','context');context.id='selection';context.setAttribute('aria-live','polite');
 renderSelection(context);
 bar.append(context);
 const prev=button('‹',()=>moveEdit(-1),'nav-button');prev.setAttribute('aria-label','Previous edit (D)');prev.disabled=locationIndex()===0;
 const next=button('›',()=>moveEdit(1),'nav-button');next.setAttribute('aria-label','Next edit (F)');next.disabled=locationIndex()===locations.length-1;bar.append(prev,next);
 const mode=node('select','view-select');mode.setAttribute('aria-label','Review view');
 [['auto','Auto view'],['diff','Word changes'],['pdf','PDF pages'],['rendered','Rendered LaTeX'],['before','Original file'],['after','Proposed file'],['selected','Selected file']].forEach(([value,label])=>{const o=node('option','',label);o.value=value;o.selected=value===view;mode.append(o);});
 mode.addEventListener('change',()=>{view=mode.value;overrides={};render();focusSelection();});bar.append(mode);
 if(['rendered','pdf'].includes(display)&&f.path.endsWith('.tex')&&!(embedded&&display==='pdf')){
  const zoom=node('select','zoom-control');zoom.id='zoom';zoom.setAttribute('aria-label','Preview zoom');
  [100,125,150,175,200,225,250].forEach(value=>{const o=node('option','',value===100?'Fit':value+'%');o.value=value;o.selected=value===previewZoom;zoom.append(o);});
  zoom.addEventListener('change',()=>{previewZoom=Number(zoom.value);zoomPreview(0);});bar.append(zoom);
 }
 main.insertBefore(bar,existing);
 const card=existing||node('section','passage selected-passage');card.id='passage-'+passage;card.tabIndex=-1;card.setAttribute('aria-label',`Passage ${passage+1}, edit ${edit+1} of ${h.edits.length}`);
 if(display==='pdf'){
  const pair=existing?.querySelector('.pdf-pair');
  if(pair){for(const child of [...card.children])if(child!==pair)child.remove();pdfPair(g,pair);}else card.append(pdfPair(g));
  const exact=node('div','selected-change');exact.append(node('span','selected-label','Selected edit'),exactEdit(g));card.append(exact);
 }else if(!['auto','diff','rendered'].includes(view)){
  const content=view==='before'?f.before:view==='after'?f.after:selected(f);
  const p=node('pre');p.id='preview';
  if(content===null)p.textContent='File is absent in this version.';
  else{const [start,end]=sourceRange(f,g,view,decisions),marker=node('mark','source-selection',content.slice(start,end));marker.dataset.selectedSource='';p.append(document.createTextNode(content.slice(0,start)),marker,document.createTextNode(content.slice(end)));}
  if(view==='selected'&&!readOnly())p.addEventListener('click',event=>{
   const caret=document.caretRangeFromPoint?.(event.clientX,event.clientY);
   if(!caret||!p.contains(caret.startContainer))return;
   const range=document.createRange();range.selectNodeContents(p);range.setEnd(caret.startContainer,caret.startOffset);openEditor(range.toString().length);
  });
  else if(view==='after'&&!readOnly())p.addEventListener('click',()=>openEditor());
  const exact=node('div','selected-change');exact.append(node('span','selected-label','Selected edit'),exactEdit(g));card.append(p,exact);
 }else if(display==='rendered'&&f.path.endsWith('.tex')){
  card.append(renderedPair(h));
  const exact=node('div','selected-change');exact.append(node('span','selected-label','Selected edit'),exactEdit(g));card.append(exact);
  const src=node('details','detail');src.dataset.key='source-'+h.id;src.append(node('summary','','Word changes in context'),sourceBody(h,f,true));card.append(src);
 }else card.append(sourceBody(h,f));
 if(!existing)main.append(card);
 const controls=node('div','decisionbar'),s=groupStatus(g);
 const accept=keyButton('Accept','A',()=>{setChoices([g.id],'accept');focusSelection();},'accept');accept.setAttribute('aria-pressed',s==='accept');
 const reject=keyButton('Reject','S',()=>{setChoices([g.id],'reject');focusSelection();},'reject');reject.setAttribute('aria-pressed',s==='reject');
 const comment=keyButton('Discussion','C',()=>openComment(false),'quiet');
 comment.id='edit-comment-action';
 const revise=keyButton('Edit','E',openEditor,'quiet');
 const reset=keyButton('Reset','U',()=>{setChoices([g.id],'pending');focusSelection();},'quiet');reset.title='Mark this edit undecided';
 reset.hidden=s==='pending';
 if(readOnly()){
  controls.append(button('Return to this round',()=>switchScope('round')));main.append(controls);
  if(h.edits.length>1)main.append(allEdits(h));
 }else{
  controls.append(accept,reject,revise,comment,reset,node('span','decision-state state-'+s,{pending:'Undecided',accept:'Accepted',reject:'Rejected'}[s]));main.append(controls);
  if(h.edits.length>1)main.append(allEdits(h));
 }
 const foot=node('div','statusline');const saveStatus=node('span','','');saveStatus.id='status';saveStatus.setAttribute('role','status');saveStatus.setAttribute('aria-live','polite');foot.append(saveStatus);
 if(embedded&&display==='pdf')controls.append(foot);else main.append(foot);
 document.querySelectorAll('main details').forEach(d=>{if(open.has(d.dataset.key)){d.hidden=false;d.open=true;}});renderDiscussion();status(oldStatus,oldError);
}
function focusSelection(){if(!data.files.length)return;
 const card=$('passage-'+passage);card?.focus({preventScroll:true});
 const marked=card?.querySelector('.active-edit,[data-selected-source]');
 if(marked&&!marked.closest('details:not([open])'))marked.scrollIntoView({block:'nearest',behavior:'instant'});
 else $('selection')?.scrollIntoView({block:'nearest',behavior:'instant'});
}
function selectEdit(hi,ei){passage=hi;edit=ei;render();focusSelection();}
function locationIndex(){return locations.findIndex(l=>l[0]===active&&l[1]===passage&&l[2]===edit);}
function moveEdit(direction){if(!locations.length||editing)return;const l=locations[Math.max(0,Math.min(locations.length-1,locationIndex()+direction))];[active,passage,edit]=l;render();focusSelection();}
function movePassage(direction){
 if(!locations.length||editing)return;
 const passages=locations.filter(l=>l[2]===0),index=passages.findIndex(l=>l[0]===active&&l[1]===passage);
 [active,passage,edit]=passages[Math.max(0,Math.min(passages.length-1,index+direction))];render();focusSelection();
}
function moveFile(direction){if(editing)return;active=Math.max(0,Math.min(data.files.length-1,active+direction));passage=edit=0;render();focusSelection();}
function openComment(wholePassage=false){
 if(data.scope==='manuscript'){if(fileEditor)commentSelection();return;}
 commentScope=wholePassage?'passage':'edit';discussionKey=currentEdit()?.id;discussionOpen=true;renderDiscussion();
 const area=$('comment-'+(wholePassage?currentHunk()?.id:currentEdit()?.id));area?.focus();
}
async function resumeDraft(){
 if(readOnly())await switchScope('round');
 const destination=locations.find(([fi])=>Object.hasOwn(drafts,data.files[fi].path));
 if(destination){[active,passage,edit]=destination;render();openEditor();return;}
 await switchScope('manuscript');
 const file=data.files.findIndex(file=>Object.hasOwn(drafts,file.path));
 if(file>=0){active=file;passage=edit=0;render();openEditor();}
 else{
  const section=$('retained-drafts');section.replaceChildren();section.hidden=false;
  section.append(node('h3','','Retained source drafts'),node('p','','These drafts no longer have a matching passage. Copy the source into your manuscript or a file editor, then discard the retained draft.'));
  for(const [id,draft] of Object.entries(drafts)){
   const area=node('textarea','source-area');area.value=draft.text;area.readOnly=true;area.rows=6;area.style.width='100%';area.setAttribute('aria-label','Retained source draft');
   const discard=button('Discard draft',()=>{delete drafts[id];retainDraft(id,null);saveDrafts();resumeDraft();});section.append(area,discard);
  }
  if(Object.keys(drafts).length){$('actions').showModal();section.scrollIntoView({block:'nearest'});section.querySelector('textarea').focus();}
  else{section.hidden=true;$('actions').close();}
 }
}
function togglePassageView(){const h=currentHunk();overrides[h.id]=['rendered','pdf'].includes(shownView(h))?'diff':view==='pdf'?'pdf':'rendered';if(!['auto','diff','rendered','pdf'].includes(view))view='auto';render();focusSelection();}
function zoomPreview(step){previewZoom=Math.max(100,Math.min(250,previewZoom+step));document.documentElement.style.setProperty('--preview-zoom',previewZoom/100);if($('zoom'))$('zoom').value=String(previewZoom);focusPDF();remember();}
function panPreview(step){document.querySelectorAll('.selected-passage .image-scroll').forEach(p=>p.scrollLeft+=step);}
function toggleFiles(){document.body.classList.toggle('wide');remember();}
function help(){$('shortcuts').showModal();}
async function switchScope(scope,path){
 if(!data||editing||scope===data.scope)return;
 currentUI();if(fileEditor)closeEditor(false);
 setBusy(true);status('Loading comparison…');
 const from=data.scope;
 try{
  saveNotes();saveDrafts();save();await saving;if(saveFailed||draftChanges.size||noteChanges.size)throw new Error('Resolve the save error before changing comparisons.');status('Loading comparison…');
  const response=await request('/data?scope='+scope);if(!response.ok)throw new Error('Could not load this comparison.');
  data=await response.json();decisions=data.decisions;comments=data.comments;drafts=data.drafts;locations=editLocations(data);
  const position=positions[scope]||{};active=Math.max(0,Math.min(position.active||0,data.files.length-1));passage=position.passage||0;edit=position.edit||0;view=position.view||'auto';overrides=position.overrides||{};
  if(path){const index=data.files.findIndex(file=>file.path===path);if(index>=0){active=index;passage=edit=0;}}
  render();focusSelection();status(readOnly()?'Press T to return to this round.':'Saved locally');
  if(['queued','rendering'].includes(data.preview_status))watchPreviews();
 }catch(error){$('comparison').value=from;status(error.message,true);}
 finally{setBusy(false);if(data.scope==='manuscript'&&!fileEditor)render();}
}
function nextUndecided(){
 const index=locationIndex();for(let step=1;step<=locations.length;step++){
  const l=locations[(index+step)%locations.length],g=data.files[l[0]].hunks[l[1]].edits[l[2]];
  if(choice(g.id)==='pending'){[active,passage,edit]=l;view=['auto','rendered','diff','pdf'].includes(view)?view:'auto';$('actions').open&&$('actions').close();render();focusSelection();return;}
 }status('All edits have a decision.');
}
document.addEventListener('keydown',event=>{
 if(!data||editing||event.defaultPrevented)return;
 const target=event.target,typing=target.matches('textarea,input,select')||target.isContentEditable;
 if(document.querySelector('dialog[open]')&&!$('feedback').open)return;
 const commentDirection=commentShortcut(event);if(commentDirection){event.preventDefault();moveComment(commentDirection);return;}
 if(document.querySelector('dialog[open]'))return;
 if(typing){if(event.key==='Escape'||(event.key==='Enter'&&(event.metaKey||event.ctrlKey))){event.preventDefault();
  if(target.closest('.cm-editor'))return;
  save();target.blur();if(fileEditor)fileEditor.focus();else focusSelection();return;}return;}
 if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.altKey&&!readOnly()&&reviewProgress(data.files,decisions).total&&reviewProgress(data.files,decisions).complete){event.preventDefault();if(!event.repeat&&!data.applied&&data.files.length)applyChoices();return;}
 const k=event.key.toLowerCase();
 if(!currentEdit()&&!['q','m','?','b','t','r','c','e','[',']'].includes(k))return;
 if(readOnly()&&['a','s','u','e','c','g'].includes(k)){event.preventDefault();status('Use This round to review or edit the latest changes.');return;}
 if(event.repeat&&['a','s','u'].includes(k)){event.preventDefault();return;}
 const decision=currentEdit()?decisionShortcut(event):null;
 if(decision){
  event.preventDefault();
  const targets={edit:[currentEdit().id],passage:currentHunk().edits.map(g=>g.id),file:currentFile().edits.map(g=>g.id)};
  setChoices(targets[decision.scope],decision.value,decision.scope);focusSelection();return;
 }
 if(event.metaKey||event.ctrlKey||event.altKey)return;
 let handled=true;
 if(document.querySelector('.pdf-scroll')&&['PageDown','PageUp'].includes(event.key))document.querySelectorAll('.pdf-scroll').forEach(pane=>pane.scrollTop+=(event.key==='PageDown'?1:-1)*pane.clientHeight*.8);
 else if(k==='f'||k==='j'||event.key==='ArrowDown')event.shiftKey?movePassage(1):moveEdit(1);
 else if(k==='d'||k==='k'||event.key==='ArrowUp')event.shiftKey?movePassage(-1):moveEdit(-1);
 else if(k==='n')movePassage(1);else if(k==='p')movePassage(-1);
 else if(k===']')moveFile(1);else if(k==='[')moveFile(-1);
 else if(k==='e')event.shiftKey&&!embedded?resumeDraft():openEditor();else if(k==='c')openComment(event.shiftKey);else if(k==='r')copyAgentRequest();else if(k==='v')togglePassageView();else if(k==='b'&&!embedded)toggleFiles();
 else if(k==='+'||k==='=')zoomPreview(25);else if(k==='-')zoomPreview(-25);
 else if(k==='h'||event.key==='ArrowLeft')panPreview(-100);else if(k==='l'||event.key==='ArrowRight')panPreview(100);
 else if(k==='t')switchScope(readOnly()?'round':'baseline');else if(k==='?')help();else if(k==='m')$('actions').showModal();else if(k==='g')nextUndecided();else if(k==='q')showFeedback();
 else if(k==='i'){const d=document.querySelector('.detail[data-key^="individual-"]');if(d){d.open=!d.open;if(d.open)d.scrollIntoView({block:'nearest'});}}
 else if(event.key==='Escape')focusSelection();else handled=false;
 if(handled)event.preventDefault();
});
$('next').addEventListener('click',nextUndecided);
async function applyChoices(){
 if(!data||editing||readOnly()||$('apply').disabled)return;if(fileEditor)closeEditor(false);setBusy(true);save();$('apply').disabled=$('finish-review').disabled=true;
 try{await saving;if(saveFailed||draftChanges.size)throw new Error('Resolve the save error before applying.');const result=await post('/apply',{...decisions},{...comments});data.applied=result.applied;$('actions').close();updateProgress();resultStatus(result);}
 catch(e){$('actions').close();status(e.message,true);}finally{setBusy(false);$('apply').disabled=false;updateProgress();}
}
$('apply').addEventListener('click',applyChoices);$('finish-review').addEventListener('click',applyChoices);
async function download(path){try{save();await saving;if(saveFailed||draftChanges.size)throw new Error('Choices and comments could not be saved.');if(embedded){await exportFile(path);return;}const a=node('a');a.href=path;a.download='';document.body.append(a);a.click();a.remove();}catch(e){status(e.message,true);}}
$('export').addEventListener('click',()=>download('/selected.patch?scope='+data.scope));$('choices').addEventListener('click',()=>download('/feedback.json'));
$('comparison').addEventListener('change',event=>switchScope(event.target.value));
$('help').addEventListener('click',help);$('hide-files').addEventListener('click',toggleFiles);$('more').addEventListener('click',()=>$('actions').showModal());
$('close-help').addEventListener('click',()=>$('shortcuts').close());$('close-actions').addEventListener('click',()=>$('actions').close());
for(const id of ['shortcuts','actions','feedback'])$(id).addEventListener('close',focusSelection);
$('show-feedback').addEventListener('click',showFeedback);
$('review-comments').addEventListener('click',()=>{$('actions').close();moveComment(1);});
$('feedback-search').addEventListener('input',renderFeedback);
$('close-feedback').addEventListener('click',()=>$('feedback').close());
$('import-responses').addEventListener('click',()=>$('response-file').click());
$('response-file').addEventListener('change',async event=>{
 const file=event.target.files[0];if(!file)return;
 try{const responses=JSON.parse(await file.text());saveDrafts();save();await saving;if(saveFailed||draftChanges.size)throw new Error('Save your current notes before importing responses.');
  const result=await post('/responses',{...decisions},{...comments},{responses});
  if(readOnly()){const response=await request('/data?scope=baseline');if(!response.ok)throw new Error('Responses saved; reload to refresh discussion.');data=await response.json();decisions=data.decisions;comments=data.comments;drafts=data.drafts;}
  else{data.history=result.history;comments=result.comments;data.comments=comments;}render();$('actions').close();resultStatus(result,'Responses added to the discussion.');
 }catch(error){status(error.message,true);$('response-error').textContent=error.message;}finally{event.target.value='';}
});
async function copyAgentRequest(){
 try{if(readOnly()){await switchScope('round');if(readOnly())throw new Error('Return to this round before copying an agent request.');}saveNotes();saveDrafts();save();await saving;if(saveFailed||draftChanges.size||noteChanges.size)throw new Error('Comments could not be saved.');if(Object.keys(drafts).length)throw new Error('Save or discard your file drafts before requesting a revision.');
  const progress=reviewProgress(data.files,decisions),request=agentRequest(data,progress.complete||progress.total===0);
  if(window.webkit?.messageHandlers?.copyText)window.webkit.messageHandlers.copyText.postMessage(request);else await copyText(request);
  $('actions').close();$('feedback').close();status('Agent request copied. Paste it into your chat.');}
 catch(e){$('actions').close();$('feedback').close();status(e.message,true);}
}
for(const id of ['copy-request','copy-request-header','copy-request-more','copy-request-feedback'])$(id).addEventListener('click',copyAgentRequest);
async function ready(){
 try{
  const r=await request('/data');if(!r.ok)throw new Error('Could not load review snapshot.');data=await r.json();decisions=data.decisions;comments=data.comments;
  locations=editLocations(data);
  const ui=data.ui;
  if(ui.scope&&ui.scope!==data.scope&&(!embedded||ui.scope!=='manuscript')){const response=await request('/data?scope='+ui.scope);if(!response.ok)throw new Error('Could not restore the manuscript view.');data=await response.json();decisions=data.decisions;comments=data.comments;locations=editLocations(data);}
  pendingNoteId=commentId=ui.note;positions=ui.positions||{};const position=positions[data.scope]||{};
  active=Math.max(0,Math.min(position.active||0,data.files.length-1));passage=position.passage||0;edit=position.edit||0;
  drafts=data.drafts;view=position.view||'auto';overrides=position.overrides||{};previewZoom=ui.previewZoom||100;
  document.body.classList.toggle('wide',Boolean(ui.wide));
  zoomPreview(0);$('snapshot').textContent=`${data.base.slice(0,7)} to ${data.proposed.slice(0,7)}`;
  if(data.library_url){const link=$('library');link.href=data.library_url;link.hidden=false;}
  if(embedded){document.body.classList.add('wide');$('comparison').querySelector('option[value=manuscript]')?.remove();
   const round=$('round-state'),control=button(round.textContent,()=>runHostCommand('rounds'),'quiet');control.id=round.id;control.hidden=round.hidden;control.title='Choose review round';round.replaceWith(control);
   $('compare-saved').hidden=false;
   $('host-tools').hidden=false;
   $('apply-shortcut').querySelector('td').textContent='Save comment; apply completed review';$('pdf-shortcut-hint').hidden=false;
  }
  render();focusSelection();status('Saved locally');
  if(embedded)reviewReady();
  if(['queued','rendering'].includes(data.preview_status))watchPreviews();
 }catch(e){$('main').append(node('p','error',e.message));if(embedded)reviewReady(e.message);}
}
async function watchPreviews(){
 const scope=data.scope,proposed=data.proposed;
 try{
  const r=await request('/data?scope='+scope);if(!r.ok)return;const fresh=await r.json();if(data.scope!==scope||data.proposed!==proposed)return;data.preview_status=fresh.preview_status;data.documents=fresh.documents;data.preview_error=fresh.preview_error;
  fresh.files.forEach((f,fi)=>f.hunks.forEach((h,hi)=>{const target=data.files.find(file=>file.path===f.path)?.hunks.find(passage=>passage.id===h.id);if(target)target.rendered=h.rendered;}));
  if(['queued','rendering'].includes(data.preview_status))setTimeout(watchPreviews,2500);
  else if(!fileEditor&&!document.activeElement.matches('textarea,input,select'))render();
 }catch{setTimeout(watchPreviews,5000);}
}
window.flushReview=async()=>{
 if(!data)return;if(editing)throw new Error('Wait for the current operation to finish.');saveNotes();saveDrafts();save();await saving;
 if(staleReview){const retained=await request('/retain',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({revision:data.revision,decisions,comments,drafts,notes:[...noteChanges].map(([target,comment])=>({...target,comment}))})});if(!retained.ok)throw new Error('Could not retain your unsaved changes. Try again before reloading.');}
 if((saveFailed||draftChanges.size||noteChanges.size)&&!staleReview)throw new Error('Your latest review could not be saved.');
 clearTimeout(uiTimer);const response=await request('/ui',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({ui:currentUI()})});
 if(!response.ok)throw new Error('Could not save your review position.');
};
$('library').addEventListener('click',async event=>{event.preventDefault();try{await window.flushReview();window.location.assign(data.library_url);}catch(error){status(error.message,true);}});
$('draft-status').addEventListener('click',resumeDraft);
$('progress').addEventListener('click',()=>{$('review-summary').scrollIntoView({block:'start'});(data.applied?$('copy-request'):$('finish-review')).focus({preventScroll:true});});
async function runHostCommand(name){try{await hostCommand(name);}catch(error){status(error.message,true);}}
$('compare-saved').addEventListener('click',()=>runHostCommand('reviewSavedChanges'));
for(const [id,name] of [['compare-versions','compare'],['review-library','library'],['saved-drafts','sourceDrafts'],['review-setup','setup']])$(id).addEventListener('click',()=>runHostCommand(name));
$('reload-review').addEventListener('click',async()=>{try{await window.flushReview();window.location.reload();}catch(error){status(error.message,true);}});
if(embedded)window.addEventListener('message',async event=>{
 if(!hostMessage(event))return;
 const message=event.data;
 if(message?.type==='review-command'&&message.action==='flush'){
  try{await window.flushReview();window.dispatchEvent(new CustomEvent('review-flushed',{detail:{id:message.id,ok:true}}));}
  catch(error){window.dispatchEvent(new CustomEvent('review-flushed',{detail:{id:message.id,ok:false,error:error.message}}));}
 }
 if(message?.type==='review-changed'){staleReview=true;$('review-notice').hidden=false;updateProgress();}
 if(message?.type==='review-select'&&data){
  try{await showRevision({file:message.file,id:message.note,target:{id:message.target,kind:message.kind||'edit'}});}
  catch(error){status(error.message,true);}
 }
});
ready();
