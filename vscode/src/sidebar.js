'use strict';
const api=acquireVsCodeApi(),element=id=>document.getElementById(id);
let state={},busy=false,inputId,historyKey,restoreInput;
const send=action=>api.postMessage({action,review:state.review,revision:state.revision,folder:state.folder,
 fromVersion:state.fromVersion,toVersion:state.toVersion,entry:state.entry,input:state.comment?.id,text:element('comment-input').value});
function resizeInput(){
 const input=element('comment-input');input.style.height='auto';input.style.height=Math.min(280,input.scrollHeight+2)+'px';
}
function renderComment(){
 const comment=state.comment;
 element('setup').hidden=Boolean(comment);element('composer').hidden=!comment;
 if(!comment){inputId=historyKey=undefined;return;}
 element('comment-location').textContent=comment.file.split('/').pop()+':'+comment.line;
 element('comment-location').title=comment.file;
 element('comment-resolve').hidden=!comment.saved;
 element('comment-resolve').title=comment.resolved?'Reopen comment':'Resolve comment';
 element('comment-resolve').setAttribute('aria-label',element('comment-resolve').title);
 element('comment-resolve').setAttribute('aria-pressed',String(Boolean(comment.resolved)));
 const key=JSON.stringify(comment.history);
 if(key!==historyKey){
  historyKey=key;
  const messages=comment.history.map(message=>{
   const section=document.createElement('section');section.className='message';
   const author=document.createElement('div');author.className='author';author.textContent=message.author;
   const body=document.createElement('div');body.className='message-body';body.textContent=message.body;
   section.append(author,body);return section;
  });
  element('comment-history').replaceChildren(...messages);
 }
 element('comment-agent').textContent=state.agent;
 element('comment-model').textContent=state.model;
 element('comment-model').title='Model: '+state.model;
 if(inputId!==comment.id){
  inputId=comment.id;element('comment-input').value=comment.body;
  resizeInput();element('comment-input').focus();
 }
 element('comment-save').disabled=busy||!comment.editing&&!element('comment-input').value.trim();
 element('comment-send').disabled=busy||!element('comment-input').value.trim();
}
function render(){
 element('folder').textContent=state.folder?state.folder.split(/[\\/]/).pop():'Choose manuscript folder';
 element('folder').title=state.folder||'';element('empty').hidden=Boolean(state.folder);element('comparison').hidden=!state.folder;
 for(const [id,label,version] of [['from',state.from,state.fromVersion],['to',state.to,state.toVersion],['entry',state.entry,state.entry]]){
  element(id).textContent=label||'';element(id).title=version==='working'?'Snapshot of saved working files':version&&version!==label?`${label}\n${version}`:label||'';
  element(id).setAttribute('aria-label',`${{from:'From',to:'To',entry:'PDF'}[id]}: ${label||'Source only'}`);
 }
 element('review').textContent=state.active&&!state.pending?'Review':'Compare';
 element('review').className=state.canApply&&!state.pending?'secondary':'primary';
 element('apply').hidden=!state.canApply||state.pending;
 element('progress').textContent=state.pending?'Ready to compare':state.applied?'Applied':state.progress||'';
 element('progress').hidden=!element('progress').textContent;
 element('comments').checked=state.commentsEnabled!==false;
 element('highlights').checked=state.highlights!==false;
 element('removals').checked=state.removals!==false;
 element('editing-row').hidden=!state.active||!state.authoring;
 element('editing').textContent=state.editing==='author'?'Your draft':'Proposal';
 element('editing').title=state.editing==='author'?'Saves advance your draft and preserve pending agent changes':'Saves refine the proposal and keep From fixed';
 element('discussion').hidden=!state.active;
 element('unresolved').textContent=`${state.unresolved||0} open`;
 element('agent-label').textContent=state.agent||'Codex';element('agent').title='Choose the agent for comment requests';
 element('model').textContent=state.model||'CLI default';element('model').title='Choose the model for comment requests';
 document.querySelectorAll('button,input,textarea').forEach(control=>{control.disabled=busy||control.id==='pdf'&&(!state.active||state.pending);});
 renderComment();
}
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>send(button.dataset.action)));
for(const id of ['comments','highlights','removals'])element(id).addEventListener('change',()=>send(id));
element('comment-input').addEventListener('input',()=>{
 resizeInput();send('commentDraft');
 element('comment-save').disabled=busy||!state.comment.editing&&!element('comment-input').value.trim();
 element('comment-send').disabled=busy||!element('comment-input').value.trim();
});
element('comment-input').addEventListener('keydown',event=>{
 if(event.isComposing||busy)return;
 if(event.key==='Enter'&&!event.shiftKey&&!event.altKey){event.preventDefault();send(event.metaKey||event.ctrlKey?'commentSave':'commentSend');}
});
document.addEventListener('keydown',event=>{
 if(state.comment&&event.key==='Escape'&&!event.isComposing&&!busy){event.preventDefault();send('commentClose');}
});
window.addEventListener('message',event=>{
 const message=event.data;
 if(message?.type==='state'){state=message.state;element('error').hidden=true;render();}
 else if(message?.type==='busy'){
  if(message.busy&&state.comment)restoreInput=inputId;
  busy=message.busy;render();
  if(!busy&&restoreInput===inputId&&state.comment){element('comment-input').focus();restoreInput=undefined;}
 }
 else if(message?.type==='error'){element('error').textContent=message.message;element('error').hidden=false;}
});
api.postMessage({action:'ready'});
