'use strict';
const api=acquireVsCodeApi(),element=id=>document.getElementById(id);
let state={},busy=false;
function render(){
 element('folder').textContent=state.folder?state.folder.split(/[\\/]/).pop():'Choose manuscript folder';
 element('folder').title=state.folder||'';element('empty').hidden=Boolean(state.folder);element('comparison').hidden=!state.folder;
 for(const [id,label,version] of [['from',state.from,state.fromVersion],['to',state.to,state.toVersion],['entry',state.entry,state.entry]]){
  element(id).textContent=label||'';element(id).title=version==='working'?'Snapshot of saved working files':version&&version!==label?`${label}\n${version}`:label||'';
  element(id).setAttribute('aria-label',`${{from:'From',to:'To',entry:'PDF'}[id]}: ${label||'Source only'}`);
 }
 element('review').textContent=state.active&&!state.pending?'Open review':'Review changes';
 element('apply').hidden=!state.canApply||state.pending;
 element('progress').textContent=state.pending?'Comparison not opened':state.applied?'Applied':state.progress||'';
 element('progress').hidden=!element('progress').textContent;
 element('comments').checked=state.commentsEnabled!==false;
 element('highlights').checked=state.highlights!==false;
 element('discussion').hidden=!state.active;
 element('unresolved').textContent=`${state.unresolved||0} unresolved`;
 element('agent-label').textContent=state.agent||'Codex';element('agent').title='Choose the agent for comment requests';
 document.querySelectorAll('button,input').forEach(control=>{control.disabled=busy;});
}
const send=action=>api.postMessage({action,review:state.review,revision:state.revision,folder:state.folder,fromVersion:state.fromVersion,toVersion:state.toVersion,entry:state.entry});
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>send(button.dataset.action)));
element('comments').addEventListener('change',()=>send('comments'));
element('highlights').addEventListener('change',()=>send('highlights'));
window.addEventListener('message',event=>{
 const message=event.data;
 if(message?.type==='state'){state=message.state;element('error').hidden=true;render();}
 else if(message?.type==='busy'){busy=message.busy;render();}
 else if(message?.type==='error'){element('error').textContent=message.message;element('error').hidden=false;}
});
api.postMessage({action:'ready'});
