'use strict';
const api=acquireVsCodeApi(),frame=document.getElementById('pdf'),status=document.getElementById('status');
const instance=document.body.dataset.instance;
let viewerOrigin;
const send=message=>api.postMessage({...message,instance});
window.addEventListener('message',event=>{
 const message=event.data;
 if(event.source===frame.contentWindow&&event.origin===viewerOrigin){
  if(message?.type==='review-pdf-ready')send({type:'ready'});
  else if(message?.type==='review-pdf-key')send({type:'key',key:message.key,selection:message.selection,shiftKey:message.shiftKey,ctrlKey:message.ctrlKey});
  else if(message?.type==='review-pdf-error')send({type:'error',error:message.error});
  return;
 }
 if(message?.instance!==instance)return;
 if(message.type==='viewer'){
  const url=new URL(message.url);viewerOrigin=url.origin;
  url.pathname='/viewer.html';url.searchParams.set('parentOrigin',location.origin);frame.src=url.href;
 }else if(message.type==='status'){
  status.textContent=message.text;status.hidden=!message.text;frame.hidden=Boolean(message.text);
 }else if(message.type==='document'){
  status.hidden=true;frame.hidden=false;
  frame.contentWindow.postMessage({...message,type:'review-pdf'},viewerOrigin);
 }
});
send({type:'loaded'});
