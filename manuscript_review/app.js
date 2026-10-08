'use strict';
import {choiceFor,selectedSource,passageSource,editLocations,feedbackForPassage,explanationsForEdit,decisionShortcut,reviewProgress,editContext,currentFeedback,sourceRange,agentRequest} from './review_model.js';
let data, decisions={}, comments={}, drafts={}, active=0, passage=0, edit=0;
let view='auto', overrides={}, previewZoom=100, locations=[];
let saving=Promise.resolve(), saveFailed=false, commentTimer;
let uiTimer,draftTimer,editing=false,staleReview=false,commentScope='edit';
const draftChanges=new Map();
let positions={};
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const choice=id=>choiceFor(id,decisions);
const readOnly=()=>data?.scope==='baseline';
const groupStatus=group=>readOnly()?'included':choice(group.id);
const currentFile=()=>data?.files[active];
const currentHunk=()=>currentFile()?.hunks[passage];
const currentEdit=()=>currentHunk()?.edits[edit];
const selectedFeedback=()=>feedbackForPassage(data?.history||[],currentHunk()).filter(entry=>commentScope==='passage'||entry.target?.id===currentHunk()?.id||entry.target?.id===currentEdit()?.id);
const selectedExplanations=()=>explanationsForEdit(data?.history||[],currentHunk(),currentEdit(),data?.round_id);
const needsMath=g=>g?.math||/\\(?:frac|sum|sqrt|int|prod|mathop)\b|\\begin\{(?:equation|align|algorithm)|\\\[/.test(g?.new||'');
const shownView=h=>['auto','diff','rendered'].includes(view)?(overrides[h.id]||(view==='auto'?(needsMath(currentEdit())?'rendered':'diff'):view)):view;
const niceName=path=>path.split('/').pop().replace(/\.[^.]+$/,'').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
function status(message,error=false){$('status')&&($('status').textContent=message);if($('status'))$('status').className=error?'error':'';}
function resultStatus(result,fallback){status(result.message||fallback);}
const savedMessage=()=>data.files?.length&&reviewProgress(data.files,decisions).complete&&!data.applied?'Review complete · ⌘/Ctrl+Enter applies':'Saved locally';
const currentUI=()=>{positions[data?.scope||'round']={active,passage,edit,view,overrides};return {scope:data?.scope||'round',positions,previewZoom,wide:document.body.classList.contains('wide')};};
function remember(){
 const ui=currentUI();
 if(data){clearTimeout(uiTimer);uiTimer=setTimeout(()=>fetch('/ui',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({ui})}).catch(()=>{}),400);}
}
function button(label,action,cls='quiet'){const b=node('button',cls,label);b.type='button';b.addEventListener('click',action);return b;}
function keyButton(label,key,action,cls){const b=button(label,action,cls);b.append(node('span','key',key));b.setAttribute('aria-label',`${label} (${key})`);return b;}
async function post(path,values,notes,extra={}){
 const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({decisions:values,comments:notes,revision:data.revision,...extra})});
 const result=await r.json();if(!r.ok){if(result.stale){staleReview=true;$('review-notice').hidden=false;updateProgress();}throw new Error(result.error);}data.revision=result.revision;return result;
}
function retainDraft(id,text){
 draftChanges.set(id,text);clearTimeout(draftTimer);draftTimer=setTimeout(saveDrafts,350);updateProgress();
}
function saveDrafts(){
 clearTimeout(draftTimer);
 for(const [id,text] of draftChanges){
  draftChanges.delete(id);
  saving=saving.catch(()=>{}).then(()=>post('/draft',{}, {},{passage_id:id,text})).then(result=>{saveFailed=Boolean(draftChanges.size);if(!saveFailed)resultStatus(result);}).catch(error=>{saveFailed=true;if((text===null&&!Object.hasOwn(drafts,id))||drafts[id]===text)draftChanges.set(id,text);status(error.message,true);});
 }
}
function save(){
 if(readOnly())return;
 clearTimeout(commentTimer);const values={...decisions},notes={...comments};status('Saving…');
 saving=saving.catch(()=>{}).then(()=>post('/save',values,notes)).then(result=>{saveFailed=Boolean(draftChanges.size);if(!saveFailed)status(savedMessage());}).catch(e=>{saveFailed=true;status(e.message,true);});
}
function setChoices(members,value,scope='edit'){
 if(editing||readOnly())return;
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
 span.dataset.edit=g.id;span.title=`Edit ${index+1} · ${s}`;
 if(g.old)span.append(node('del',g.old.trim()?'':'whitespace',displayText(g.old)));
 const updated=g.new;if(updated)span.append(node('ins',updated.trim()?'':'whitespace',displayText(updated)));
 span.addEventListener('click',()=>selectEdit(passage,index));return span;
}
function discussionEntry(entry,withLocation=false){
 const item=node('article','discussion-entry');
 const title=entry.title||(entry.author==='agent'?'Why this changed':'');
 if(title)item.append(node('h3','discussion-title',title));
 if(withLocation)item.append(node('div','comment-meta',`${entry.file} · original line ${entry.line}`));
 item.append(node('div','discussion-speaker',entry.author==='agent'?'Agent':entry.current?'You · awaiting response':'You'),node('p','discussion-text',entry.comment));
 for(const reply of entry.replies)item.append(node('div','discussion-speaker','Agent response'),node('p','discussion-text',reply.text));
 const context=node('details','discussion-context');context.append(node('summary','','Original edit and context'));
 context.append(node('div','comment-meta',`Source comparison: ${entry.base.slice(0,7)} → ${entry.source_proposed.slice(0,7)}`));
 const source=node('div','exact-edit');
 if(entry.before)source.append(node('span','word-label','Original'),node('del','',displayText(entry.before)));
 if(entry.proposed)source.append(node('span','word-label','Proposal'),node('ins','',displayText(entry.proposed)));
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
 $('feedback-count').textContent=`${current.length} current ${current.length===1?'comment':'comments'} · ${data.history.length} saved ${data.history.length===1?'discussion':'discussions'}`;
 for(const entry of filtered){
  const item=discussionEntry(entry,true),destination=locations.find(([fi,hi,ei])=>{
   const h=data.files[fi].hunks[hi];return entry.target?.id===h.id||entry.target?.id===h.edits[ei].id;
  });
  if(destination)item.append(button('Go to revision',()=>{
   $('feedback').close();[active,passage,edit]=destination;render();
   openComment(entry.target.kind==='passage');
  },'discussion-link'));
  else item.append(node('div','comment-meta','No new edit here in this round.'));
  content.append(item);
 }
 if(!filtered.length)content.append(node('p','muted',query?'No matching feedback.':'No feedback yet. Use Comment to leave a note.'));
}
function commentBox(id,label,history=[]){
 const box=node('details','comment-box');box.dataset.key='comment-'+id;
 if(id===currentEdit()?.id&&!comments[id]?.trim()&&!history.length)box.hidden=true;
 const summary=node('summary','',comments[id]?.trim()?label+' · saved':label);box.append(summary);
 if(history.length){const discussion=node('div','discussion');history.forEach(entry=>discussion.append(discussionEntry(entry)));box.append(discussion);}
 const area=node('textarea');area.id='comment-'+id;area.rows=3;area.maxLength=20000;area.value=comments[id]||'';area.setAttribute('aria-label',label);area.placeholder='Describe the revision you want…';
 area.addEventListener('input',()=>{
  if(area.value)comments[id]=area.value;else delete comments[id];
  if(!history.length)summary.textContent=label;clearTimeout(commentTimer);commentTimer=setTimeout(save,350);updateProgress();
 });
 area.addEventListener('blur',save);box.append(area,node('div','comment-meta','Saves automatically · Esc or ⌘/Ctrl+Enter returns to review'));return box;
}
function sourceEditor(h){
 const source=node('details','source-editor');source.id='passage-source';source.dataset.key='source-editor-'+h.id;
 source.hidden=!Object.hasOwn(drafts,h.id);
 source.append(node('summary','','Edit whole passage'));
 const label=node('label','field-label','Passage source');label.htmlFor='passage-editor';
 const area=node('textarea','source-area');area.id='passage-editor';area.maxLength=200000;area.spellcheck=false;
 area.value=Object.hasOwn(drafts,h.id)?drafts[h.id]:passageSource(h,decisions);area.rows=Math.max(6,Math.min(20,area.value.split('\n').length));area.setAttribute('aria-label','Passage source');
 area.setAttribute('autocorrect','off');area.setAttribute('autocapitalize','off');
 area.addEventListener('input',()=>{drafts[h.id]=area.value;discard.hidden=false;retainDraft(h.id,area.value);});
 const controls=node('div','revision-controls');
 const submit=button('Save passage',()=>savePassage(),'primary');submit.id='save-passage';
 const discard=button('Discard draft',()=>{area.value=passageSource(h,decisions);delete drafts[h.id];discard.hidden=true;retainDraft(h.id,null);saveDrafts();});discard.hidden=!Object.hasOwn(drafts,h.id);
 controls.append(submit,discard);source.append(label,area,controls,node('div','comment-meta','Save writes the passage to your manuscript · Esc keeps a draft'));
 if(data.preview_error){const error=node('details','preview-error');error.append(node('summary','','LaTeX preview error'),node('pre','',data.preview_error));source.append(error);}
 return source;
}
function discussionPanel(h,g){
 const visible=new Set(selectedExplanations().map(entry=>entry.id)),history=selectedFeedback().filter(entry=>!visible.has(entry.id));
 const identifier=commentScope==='passage'?h.id:g.id,label=commentScope==='passage'?'Passage comment':'Edit comment';
 const box=commentBox(identifier,label,history);box.classList.add('discussion-panel');box.dataset.key='discussion-'+h.id;
 box.hidden=!history.length&&!comments[g.id]?.trim()&&!comments[h.id]?.trim();
 box.firstElementChild.textContent=history.length?`Discussion · ${history.length} ${history.length===1?'note':'notes'}`:comments[identifier]?.trim()?'Comment · saved':'Comment';
 const row=node('label','comment-target','Comment on '),scope=node('select');scope.setAttribute('aria-label','Comment scope');
 for(const [value,label] of [['edit','This edit'],['passage','Whole passage']]){const option=node('option','',label);option.value=value;option.selected=commentScope===value;scope.append(option);}
 scope.addEventListener('change',()=>{commentScope=scope.value;render();openComment(commentScope==='passage');});row.append(scope);box.insertBefore(row,box.querySelector('textarea'));
 return box;
}
function openEditor(){
 const area=$('passage-editor');if(!area)return;
 const panel=area.closest('.source-editor');panel.hidden=false;panel.open=true;
 area.focus();area.scrollIntoView({block:'nearest'});
}
async function savePassage(){
 const area=$('passage-editor');if(!area||editing||readOnly())return;
 const text=area.value,id=currentHunk().id,path=currentFile().path,line=currentHunk().line;
 area.readOnly=true;drafts[id]=text;retainDraft(id,text);saveDrafts();editing=true;document.body.classList.add('saving-passage');
 const values={...decisions},notes={...comments};status('Saving passage…');
 try{
  await saving;if(saveFailed||draftChanges.size)throw new Error('Resolve the save error before saving this passage.');
  const result=await post('/passage',values,notes,{passage_id:id,text});
  data=result.data;decisions=data.decisions;comments=data.comments;drafts=data.drafts;locations=editLocations(data);
  active=Math.max(0,data.files.findIndex(f=>f.path===path));
  passage=Math.max(0,currentFile()?.hunks.findIndex(h=>h.line>=line)||0);edit=0;
  saveFailed=false;remember();render();focusSelection();resultStatus(result);watchPreviews();
 }catch(error){status(error.message,true);}
 finally{area.readOnly=false;editing=false;document.body.classList.remove('saving-passage');}
}
function updateSidebar(){
 const aside=$('files');aside.replaceChildren();aside.append(node('div','nav-label','Manuscript'));let supporting=false;
 data.files.forEach((f,i)=>{
  if(f.supporting&&!supporting){aside.append(node('div','nav-label','Supporting'));supporting=true;}
  const done=f.edits.filter(g=>choice(g.id)!=='pending').length;
  const b=button('',()=>{active=i;passage=edit=0;render();focusSelection();},'file'+(i===active?' active':''));b.title=f.path;b.setAttribute('aria-label',f.path);
  if(i===active)b.setAttribute('aria-current','true');
  b.append(node('span','file-name',niceName(f.path)),node('span','file-count',readOnly()?`${f.edits.length} changes`:`${done}/${f.edits.length}`));aside.append(b);
 });
}
function updateProgress(){
 const all=data.files.flatMap(f=>f.edits),progress=reviewProgress(data.files,decisions);
 const accepted=all.filter(g=>groupStatus(g)==='accept').length,rejected=all.filter(g=>groupStatus(g)==='reject').length;
 const count=Object.values(comments).filter(c=>c.trim()).length;
 const draftCount=Object.keys(drafts).length;
 $('draft-status').hidden=!Object.keys(drafts).length;$('draft-status').textContent=`${Object.keys(drafts).length} ${Object.keys(drafts).length===1?'draft':'drafts'}`;
 $('progress').disabled=readOnly()||!progress.complete;
 $('progress').textContent=readOnly()?`${progress.total} changes since baseline`:progress.complete?'Review complete':`${progress.done} of ${progress.total} reviewed`;
 $('progress').title=readOnly()?'Original baseline → selected manuscript':`${accepted} accepted · ${rejected} rejected · ${all.length-accepted-rejected} undecided · ${count} ${count===1?'comment':'comments'}`;
 $('review-summary').hidden=readOnly()||!progress.total||!progress.complete;
 $('review-state').textContent=`${staleReview?'Review changed · Reload to continue':saveFailed||draftChanges.size?'Changes need saving':'Choices saved'} · ${data.applied?'Manuscript applied':'Ready to apply'}${count?` · ${count} ${count===1?'comment':'comments'}`:''}${draftCount?` · ${draftCount} ${draftCount===1?'draft':'drafts'}`:''}`;
 $('handoff-hint').textContent=draftCount?'Save or discard your passage drafts before requesting text revisions.':'Paste the request into your agent’s chat.';
 $('copy-request-header').hidden=readOnly()||progress.complete||!count;
 $('copy-request').className=data.applied?'primary':'quiet';
 const finish=$('finish-review');finish.hidden=false;
 finish.textContent=data.applied?'Applied':'Apply review';finish.disabled=Boolean(data.applied)||Boolean(draftCount);$('apply').disabled=Boolean(draftCount)||editing;
 finish.title=data.applied?'Your selected wording has been written to the manuscript.':'Write your selected wording to the manuscript · ⌘/Ctrl+Enter';
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
  body.append(document.createTextNode(context.before),marked(shown,edit),document.createTextNode(context.after));
  if(context.trailing)body.append(node('span','ellipsis',' …'));wrap.append(body);
  if(context.trimmed||large){const full=node('details','detail');full.dataset.key='full-passage-'+h.id;full.append(node('summary','','Full passage'),sourceBody(h,f,true));wrap.append(full);}
  return wrap;
 }
 const code=f.supporting||f.path.endsWith('.bib')||h.edits.some(needsMath)||needsMath({new:h.after});
 const body=node('div','passage-body'+(code?' code':''));
 const large=h.grouped_segments.some(g=>g.members&&(g.old.length+g.new.length)>6500);
 function populate(full){
  body.replaceChildren();let index=0;if(h.leading)body.append(node('span','ellipsis','… '));
  h.grouped_segments.forEach(g=>{
   if(g.members){const shown=large&&!full?{...g,old:g.old.slice(0,4000),new:g.new.slice(0,4000)}:g;body.append(marked(shown,index++));}
   else body.append(document.createTextNode(g.text));
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
 caption.append(node('span',side==='before'?'original-dot':'proposed-dot'),document.createTextNode(side==='before'?(data.base_label||'Original'):(data.proposal_label)));pane.append(caption);
  const r=h.rendered?.[side],scroll=node('div','image-scroll');
  if(r?.asset){const image=node('img');image.src=(readOnly()?'/baseline-assets/':'/assets/')+r.asset;image.alt=`${side==='before'?'Original with deletions in red':'Revision with additions in green'}, passage ${passage+1}`;scroll.append(image);}
  else scroll.append(node('p','render-note',['queued','rendering'].includes(data.preview_status)?'Typesetting your revision… Word changes are available.':'No typeset preview for this passage. Select Word changes.'));
  pane.append(scroll);pair.append(pane);
 }
 return pair;
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
  b.append(node('span','edit-number',`${i+1} · ${groupStatus(g)}${comments[g.id]?.trim()?' · comment':''}`));
  if(g.old)b.append(node('del','',displayText(g.old)));const updated=g.new;if(updated)b.append(node('ins','',displayText(updated)));li.append(b);list.append(li);
 });detail.append(list);return detail;
}
function bulkControls(id,members,scope){
 const box=$(id);box.replaceChildren();[['Accept','accept'],['Reject','reject'],['Reset','pending']].forEach(([label,value])=>box.append(button(label,()=>{setChoices(members,value,scope);$('actions').close();focusSelection();},'')));
}
function render(){
 if(!data)return;
 $('manuscript-title').textContent=data.manuscript?`${data.manuscript} · Round ${data.round_number}`:data.repo.split('/').pop();
 $('manuscript-title').title=`${data.repo}\n${data.title||''}\n${data.base_label} → ${data.proposal_label}`;
 $('round-state').hidden=!data.latest_review||data.latest_review===data.id;$('round-state').textContent='Earlier round';
 $('comparison').value=data.scope;
 $('apply').hidden=$('next').hidden=readOnly();
 for(const id of ['passage-actions','file-actions'])$(id).closest('.dialog-section').hidden=readOnly();
 $('snapshot').textContent=`${data.base_label} → ${data.proposal_label}`;
 if(!data.files.length){$('main').replaceChildren(node('h2','',readOnly()?'No accumulated changes':'No changes this round'),node('p','muted',readOnly()?'The selected manuscript matches the original baseline.':'The selected draft matches this round’s starting version. Earlier comments remain in All feedback.'));updateSidebar();updateProgress();return;}
 const oldStatus=$('status')?.textContent||'',oldError=$('status')?.classList.contains('error');
 const open=new Set([...document.querySelectorAll('main details[open]')].map(d=>d.dataset.key));
 const f=currentFile();passage=Math.max(0,Math.min(passage,f.hunks.length-1));edit=Math.max(0,Math.min(edit,currentHunk().edits.length-1));
 const h=currentHunk(),g=currentEdit(),display=shownView(h);
 updateSidebar();updateProgress();remember();
 bulkControls('passage-actions',h.edits.map(g=>g.id),'passage');bulkControls('file-actions',f.edits.map(g=>g.id),'file');
 const main=$('main');main.replaceChildren();main.classList.toggle('rendered',display==='rendered');
 const bar=node('div','contextbar'),context=node('div','context');context.id='selection';context.setAttribute('aria-live','polite');
 const parts=[`passage ${passage+1} of ${f.hunks.length}`];
 if(data.files.length>1)parts.unshift(`file ${active+1} of ${data.files.length}`);
 if(h.edits.length>1)parts.push(`edit ${edit+1} of ${h.edits.length}`);
 context.append(node('span','context-name',niceName(f.path)),document.createTextNode(` · ${parts.join(' · ')}`));
 context.title=`${f.path} · original line ${h.line}`;
 bar.append(context);
 const prev=button('‹',()=>moveEdit(-1),'nav-button');prev.setAttribute('aria-label','Previous edit (D)');prev.disabled=locationIndex()===0;
 const next=button('›',()=>moveEdit(1),'nav-button');next.setAttribute('aria-label','Next edit (F)');next.disabled=locationIndex()===locations.length-1;bar.append(prev,next);
 const mode=node('select','view-select');mode.setAttribute('aria-label','Review view');
 [['auto','Auto view'],['diff','Word changes'],['rendered','Rendered LaTeX'],['before','Original source · whole file'],['after','Proposed source · whole file'],['selected','Selected source · whole file']].forEach(([value,label])=>{const o=node('option','',label);o.value=value;o.selected=value===view;mode.append(o);});
 mode.addEventListener('change',()=>{view=mode.value;overrides={};render();focusSelection();});bar.append(mode);
 if(display==='rendered'&&f.path.endsWith('.tex')){
  const zoom=node('select','zoom-control');zoom.id='zoom';zoom.setAttribute('aria-label','Preview zoom');
  [100,125,150,175,200,225,250].forEach(value=>{const o=node('option','',value===100?'Fit':value+'%');o.value=value;o.selected=value===previewZoom;zoom.append(o);});
  zoom.addEventListener('change',()=>{previewZoom=Number(zoom.value);zoomPreview(0);});bar.append(zoom);
 }
 main.append(bar);
 const card=node('section','passage selected-passage');card.id='passage-'+passage;card.tabIndex=-1;card.setAttribute('aria-label',`Passage ${passage+1}, edit ${edit+1} of ${h.edits.length}`);
 if(!['auto','diff','rendered'].includes(view)){
  const content=view==='before'?f.before:view==='after'?f.after:selected(f);
  const p=node('pre');p.id='preview';
  if(content===null)p.textContent='File is absent in this version.';
  else{const [start,end]=sourceRange(f,g,view,decisions),marker=node('mark','source-selection',content.slice(start,end));marker.dataset.selectedSource='';p.append(document.createTextNode(content.slice(0,start)),marker,document.createTextNode(content.slice(end)));}
  const exact=node('div','selected-change');exact.append(node('span','selected-label','Selected edit'),exactEdit(g));card.append(p,exact);
 }else if(display==='rendered'&&f.path.endsWith('.tex')){
  card.append(renderedPair(h));
  const exact=node('div','selected-change');exact.append(node('span','selected-label','Selected edit'),exactEdit(g));card.append(exact);
  const src=node('details','detail');src.dataset.key='source-'+h.id;src.append(node('summary','','Word changes in context'),sourceBody(h,f,true));card.append(src);
 }else card.append(sourceBody(h,f));
 main.append(card);
 const controls=node('div','decisionbar'),s=groupStatus(g);
 const accept=keyButton('Accept','A',()=>{setChoices([g.id],'accept');focusSelection();},'accept');accept.setAttribute('aria-pressed',s==='accept');
 const reject=keyButton('Reject','S',()=>{setChoices([g.id],'reject');focusSelection();},'reject');reject.setAttribute('aria-pressed',s==='reject');
 const comment=keyButton('Discussion','C',()=>openComment(false),'quiet');
 comment.id='edit-comment-action';
 const revise=keyButton('Edit','E',openEditor,'quiet');
 const reset=keyButton('Reset','U',()=>{setChoices([g.id],'pending');focusSelection();},'quiet');reset.title='Mark this edit undecided';
 reset.hidden=s==='pending';
 if(readOnly()){
  controls.append(node('span','muted','Selected manuscript since the original baseline'),button('Return to this round',()=>switchScope('round')));main.append(controls);
  const history=selectedFeedback();if(history.length){const panel=node('details','discussion');panel.dataset.key='cumulative-discussion';panel.append(node('summary','','Discussion'));history.forEach(entry=>panel.append(discussionEntry(entry)));main.append(panel);}
  if(h.edits.length>1)main.append(allEdits(h));
 }else{
  for(const entry of selectedExplanations()){const explanation=discussionEntry(entry);explanation.classList.add('rationale');main.append(explanation);}
  controls.append(accept,reject,revise,comment,reset,node('span','decision-state state-'+s,{pending:'Undecided',accept:'Accepted',reject:'Rejected'}[s]));main.append(controls);
  main.append(sourceEditor(h),discussionPanel(h,g));if(h.edits.length>1)main.append(allEdits(h));
 }
 const foot=node('div','statusline');const saveStatus=node('span','','');saveStatus.id='status';saveStatus.setAttribute('role','status');saveStatus.setAttribute('aria-live','polite');foot.append(saveStatus);main.append(foot);
 document.querySelectorAll('main details').forEach(d=>{if(open.has(d.dataset.key)){d.hidden=false;d.open=true;}});status(oldStatus,oldError);
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
 const scope=wholePassage?'passage':'edit';if(commentScope!==scope){commentScope=scope;render();}
 const area=$('comment-'+(wholePassage?currentHunk()?.id:currentEdit()?.id));if(area){area.parentElement.hidden=false;area.parentElement.open=true;area.focus();area.scrollIntoView({block:'nearest'});}
}
async function resumeDraft(){
 if(readOnly())await switchScope('round');
 const destination=locations.find(([fi,hi])=>Object.hasOwn(drafts,data.files[fi].hunks[hi].id));
 if(destination){[active,passage,edit]=destination;render();openEditor();}
 else{
  const section=$('retained-drafts');section.replaceChildren();section.hidden=false;
  section.append(node('h3','','Retained source drafts'),node('p','','These drafts no longer have a matching passage. Copy the source into your manuscript or a passage editor, then discard the retained draft.'));
  for(const [id,text] of Object.entries(drafts)){
   const area=node('textarea','source-area');area.value=text;area.readOnly=true;area.rows=6;area.style.width='100%';area.setAttribute('aria-label','Retained passage source');
   const discard=button('Discard draft',()=>{delete drafts[id];retainDraft(id,null);saveDrafts();resumeDraft();});section.append(area,discard);
  }
  if(Object.keys(drafts).length){$('actions').showModal();section.scrollIntoView({block:'nearest'});section.querySelector('textarea').focus();}
  else{section.hidden=true;$('actions').close();}
 }
}
function togglePassageView(){const h=currentHunk();overrides[h.id]=shownView(h)==='rendered'?'diff':'rendered';if(!['auto','diff','rendered'].includes(view))view='auto';render();focusSelection();}
function zoomPreview(step){previewZoom=Math.max(100,Math.min(250,previewZoom+step));document.documentElement.style.setProperty('--preview-zoom',previewZoom/100);if($('zoom'))$('zoom').value=String(previewZoom);remember();}
function panPreview(step){document.querySelectorAll('.selected-passage .image-scroll').forEach(p=>p.scrollLeft+=step);}
function toggleFiles(){document.body.classList.toggle('wide');remember();}
function help(){$('shortcuts').showModal();}
async function switchScope(scope){
 if(!data||editing||scope===data.scope)return;
 editing=true;document.body.classList.add('saving-passage');status('Loading comparison…');
 const from=data.scope;positions[from]={active,passage,edit,view,overrides};
 try{
  saveDrafts();save();await saving;if(saveFailed||draftChanges.size)throw new Error('Resolve the save error before changing comparisons.');status('Loading comparison…');
  const response=await fetch('/data?scope='+scope);if(!response.ok)throw new Error('Could not load this comparison.');
  data=await response.json();decisions=data.decisions;comments=data.comments;drafts=data.drafts;locations=editLocations(data);
  const position=positions[scope]||{};active=Math.max(0,Math.min(position.active||0,data.files.length-1));passage=position.passage||0;edit=position.edit||0;view=position.view||'auto';overrides=position.overrides||{};
  render();focusSelection();status(readOnly()?'Cumulative view · T returns to this round':'Saved locally');
  if(['queued','rendering'].includes(data.preview_status))watchPreviews();
 }catch(error){$('comparison').value=from;status(error.message,true);}
 finally{editing=false;document.body.classList.remove('saving-passage');}
}
function nextUndecided(){
 const index=locationIndex();for(let step=1;step<=locations.length;step++){
  const l=locations[(index+step)%locations.length],g=data.files[l[0]].hunks[l[1]].edits[l[2]];
  if(choice(g.id)==='pending'){[active,passage,edit]=l;view=['auto','rendered','diff'].includes(view)?view:'auto';$('actions').open&&$('actions').close();render();focusSelection();return;}
 }status('All edits have a decision.');
}
document.addEventListener('keydown',event=>{
 if(!data||editing||event.defaultPrevented)return;
 const target=event.target,typing=target.matches('textarea,input,select')||target.isContentEditable;
 if(document.querySelector('dialog[open]'))return;
 if(typing){if(event.key==='Escape'||(event.key==='Enter'&&(event.metaKey||event.ctrlKey))){event.preventDefault();
  if(target.classList.contains('source-area')){if(event.key==='Enter')savePassage();else{saveDrafts();target.closest('.source-editor').open=false;target.blur();render();focusSelection();}}
  else{save();const box=target.closest('.comment-box');if(box){box.open=false;if(!comments[currentEdit()?.id]?.trim()&&!comments[currentHunk()?.id]?.trim()&&!selectedFeedback().length)box.hidden=true;}target.blur();focusSelection();}return;}return;}
 if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.altKey&&!readOnly()&&reviewProgress(data.files,decisions).complete){event.preventDefault();if(!event.repeat&&!data.applied&&data.files.length)applyChoices();return;}
 const k=event.key.toLowerCase();
 if(!currentEdit()&&!['q','m','?','b','t'].includes(k))return;
 if(readOnly()&&['a','s','u','e','c','g'].includes(k)){event.preventDefault();status('Use This round to review or edit the latest changes.');return;}
 if(event.repeat&&['a','s','u'].includes(k)){event.preventDefault();return;}
 const decision=decisionShortcut(event);
 if(decision){
  event.preventDefault();
  const targets={edit:[currentEdit().id],passage:currentHunk().edits.map(g=>g.id),file:currentFile().edits.map(g=>g.id)};
  setChoices(targets[decision.scope],decision.value,decision.scope);focusSelection();return;
 }
 if(event.metaKey||event.ctrlKey||event.altKey)return;
 let handled=true;
 if(k==='f'||k==='j'||event.key==='ArrowDown')event.shiftKey?movePassage(1):moveEdit(1);
 else if(k==='d'||k==='k'||event.key==='ArrowUp')event.shiftKey?movePassage(-1):moveEdit(-1);
 else if(k==='n')movePassage(1);else if(k==='p')movePassage(-1);
 else if(k===']')moveFile(1);else if(k==='[')moveFile(-1);
 else if(k==='e')event.shiftKey?resumeDraft():openEditor();else if(k==='c')openComment(event.shiftKey);else if(k==='r')copyAgentRequest();else if(k==='v')togglePassageView();else if(k==='b')toggleFiles();
 else if(k==='+'||k==='=')zoomPreview(25);else if(k==='-')zoomPreview(-25);
 else if(k==='h'||event.key==='ArrowLeft')panPreview(-100);else if(k==='l'||event.key==='ArrowRight')panPreview(100);
 else if(k==='t')switchScope(readOnly()?'round':'baseline');else if(k==='?')help();else if(k==='m')$('actions').showModal();else if(k==='g')nextUndecided();else if(k==='q')showFeedback();
 else if(k==='i'){const d=document.querySelector('.detail[data-key^="individual-"]');if(d)d.open=!d.open;}
 else if(event.key==='Escape')focusSelection();else handled=false;
 if(handled)event.preventDefault();
});
$('next').addEventListener('click',nextUndecided);
async function applyChoices(){
 if(!data||editing||readOnly()||$('apply').disabled)return;editing=true;document.body.classList.add('saving-passage');save();$('apply').disabled=$('finish-review').disabled=true;
 try{await saving;if(saveFailed||draftChanges.size)throw new Error('Resolve the save error before applying.');const result=await post('/apply',{...decisions},{...comments});data.applied=result.applied;$('actions').close();updateProgress();resultStatus(result);}
 catch(e){$('actions').close();status(e.message,true);}finally{editing=false;document.body.classList.remove('saving-passage');$('apply').disabled=false;updateProgress();}
}
$('apply').addEventListener('click',applyChoices);$('finish-review').addEventListener('click',applyChoices);
async function download(path){try{save();await saving;if(saveFailed||draftChanges.size)throw new Error('Choices and comments could not be saved.');const a=node('a');a.href=path;a.download='';document.body.append(a);a.click();a.remove();}catch(e){status(e.message,true);}}
$('export').addEventListener('click',()=>download('/selected.patch?scope='+data.scope));$('choices').addEventListener('click',()=>download('/feedback.json'));
$('comparison').addEventListener('change',event=>switchScope(event.target.value));
$('help').addEventListener('click',help);$('hide-files').addEventListener('click',toggleFiles);$('more').addEventListener('click',()=>$('actions').showModal());
$('close-help').addEventListener('click',()=>$('shortcuts').close());$('close-actions').addEventListener('click',()=>$('actions').close());
for(const id of ['shortcuts','actions','feedback'])$(id).addEventListener('close',focusSelection);
$('show-feedback').addEventListener('click',showFeedback);
$('feedback-search').addEventListener('input',renderFeedback);
$('close-feedback').addEventListener('click',()=>$('feedback').close());
$('import-responses').addEventListener('click',()=>$('response-file').click());
$('response-file').addEventListener('change',async event=>{
 const file=event.target.files[0];if(!file)return;
 try{const responses=JSON.parse(await file.text());saveDrafts();save();await saving;if(saveFailed||draftChanges.size)throw new Error('Save your current notes before importing responses.');
  const result=await post('/responses',{...decisions},{...comments},{responses});
  if(readOnly()){const response=await fetch('/data?scope=baseline');if(!response.ok)throw new Error('Responses saved; reload to refresh discussion.');data=await response.json();decisions=data.decisions;comments=data.comments;drafts=data.drafts;}
  else{data.history=result.history;comments=result.comments;data.comments=comments;}render();$('actions').close();resultStatus(result,'Responses added to the discussion.');
 }catch(error){status(error.message,true);$('response-error').textContent=error.message;}finally{event.target.value='';}
});
async function copyAgentRequest(){
 try{if(readOnly()){await switchScope('round');if(readOnly())throw new Error('Return to this round before copying an agent request.');}saveDrafts();save();await saving;if(saveFailed||draftChanges.size)throw new Error('Comments could not be saved.');if(Object.keys(drafts).length)throw new Error('Save or discard your passage drafts before requesting a revision.');
  const request=agentRequest(data,reviewProgress(data.files,decisions).complete);
  if(window.webkit?.messageHandlers?.copyText)window.webkit.messageHandlers.copyText.postMessage(request);else await navigator.clipboard.writeText(request);
  $('actions').close();$('feedback').close();status('Agent request copied. Paste it into your chat.');}
 catch(e){$('actions').close();$('feedback').close();status(e.message,true);}
}
for(const id of ['copy-request','copy-request-header','copy-request-more','copy-request-feedback'])$(id).addEventListener('click',copyAgentRequest);
async function ready(){
 try{
  const r=await fetch('/data');if(!r.ok)throw new Error('Could not load review snapshot.');data=await r.json();decisions=data.decisions;comments=data.comments;
  locations=editLocations(data);
  const ui=data.ui;
  positions=ui.positions||{};const position=positions.round||{};
  active=Math.max(0,Math.min(position.active||0,data.files.length-1));passage=position.passage||0;edit=position.edit||0;
  drafts=data.drafts;view=position.view||'auto';overrides=position.overrides||{};previewZoom=ui.previewZoom||100;
  document.body.classList.toggle('wide',Boolean(ui.wide));
  zoomPreview(0);$('snapshot').textContent=`${data.base_label} → ${data.proposal_label}`;
  if(data.library_url){const link=$('library');link.href=data.library_url;link.hidden=false;}
  render();focusSelection();status('Saved locally');
  if(ui.scope==='baseline')await switchScope('baseline');
  if(['queued','rendering'].includes(data.preview_status))watchPreviews();
 }catch(e){$('main').append(node('p','error',e.message));}
}
async function watchPreviews(){
 const scope=data.scope,proposed=data.proposed;
 try{
  const r=await fetch('/data?scope='+scope);if(!r.ok)return;const fresh=await r.json();if(data.scope!==scope||data.proposed!==proposed)return;data.preview_status=fresh.preview_status;
  fresh.files.forEach((f,fi)=>f.hunks.forEach((h,hi)=>{const target=data.files.find(file=>file.path===f.path)?.hunks.find(passage=>passage.id===h.id);if(target)target.rendered=h.rendered;}));
  if(['queued','rendering'].includes(data.preview_status))setTimeout(watchPreviews,2500);
  else if(!document.activeElement.matches('textarea,input,select'))render();
 }catch{setTimeout(watchPreviews,5000);}
}
window.flushReview=async()=>{
 if(!data)return;if(editing)throw new Error('Wait for the current operation to finish.');saveDrafts();save();await saving;
 if(staleReview){const retained=await fetch('/retain',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({revision:data.revision,decisions,comments,drafts})});if(!retained.ok)throw new Error('Could not retain your unsaved changes. Try again before reloading.');}
 if((saveFailed||draftChanges.size)&&!staleReview)throw new Error('Your latest review could not be saved.');
 clearTimeout(uiTimer);const response=await fetch('/ui',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':data.token},body:JSON.stringify({ui:currentUI()})});
 if(!response.ok)throw new Error('Could not save your review position.');
};
$('library').addEventListener('click',async event=>{event.preventDefault();try{await window.flushReview();window.location.assign(data.library_url);}catch(error){status(error.message,true);}});
$('draft-status').addEventListener('click',resumeDraft);
$('progress').addEventListener('click',()=>{$('review-summary').scrollIntoView({block:'start'});(data.applied?$('copy-request'):$('finish-review')).focus({preventScroll:true});});
$('reload-review').addEventListener('click',async()=>{try{await window.flushReview();window.location.reload();}catch(error){status(error.message,true);}});
ready();
