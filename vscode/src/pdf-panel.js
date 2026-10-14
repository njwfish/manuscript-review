'use strict';
const api=acquireVsCodeApi(),instance=document.body.dataset.instance;
const sides=['before','after'];
const frames=Object.fromEntries(sides.map(side=>[side,document.getElementById(side+'-pdf')]));
let viewerOrigin;
const send=message=>api.postMessage({...message,instance});
window.addEventListener('message',event=>{
 const message=event.data;
 const side=sides.find(side=>event.source===frames[side].contentWindow);
 if(side&&event.origin===viewerOrigin){
  if(message?.type==='review-pdf-ready')send({type:'ready',side});
  else if(message?.type==='review-pdf-key')send({type:'key',side,key:message.key,selection:message.selection,shiftKey:message.shiftKey,ctrlKey:message.ctrlKey});
  else if(message?.type==='review-pdf-rendered')send({type:'rendered',side,document:message.document,selection:message.selection});
  else if(message?.type==='review-pdf-error')send({type:'error',side,document:message.document,error:message.error});
  return;
 }
 if(message?.instance!==instance)return;
 if(message.type==='viewer'){
  const url=new URL(message.url);viewerOrigin=url.origin;
  url.searchParams.set('parentOrigin',location.origin);
  for(const frame of Object.values(frames))frame.src=url.href;
 }else if(sides.includes(message.side)){
  const status=document.getElementById(message.side+'-status'),frame=frames[message.side];
  if(message.type==='status'){
   status.textContent=message.text;status.hidden=!message.text;frame.hidden=Boolean(message.text);
  }else if(message.type==='document'){
   status.hidden=true;frame.hidden=false;
   frame.contentWindow.postMessage({...message,type:'review-pdf'},viewerOrigin);
  }
 }
});
send({type:'loaded'});
