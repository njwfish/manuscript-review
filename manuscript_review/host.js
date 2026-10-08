// The browser and VS Code use the same review client. Only transport and editor ownership differ.
export function createBridge(api,subscribe){
 const pending=new Map();let sequence=0;
 subscribe(event=>{
  const message=event.data;if(event.source||message?.type!=='review-response')return;
  const request=pending.get(message.id);if(!request)return;
  clearTimeout(request.timer);pending.delete(message.id);
  if(message.ok)request.resolve(message.data);else request.reject(new Error(message.error||'The editor host could not complete this action.'));
 });
 return (action,values={})=>new Promise((resolve,reject)=>{
  const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(new Error('The editor host did not respond.'));},30000);
  pending.set(id,{resolve,reject,timer});api.postMessage({type:'review-request',id,action,...values});
 });
}
const api=globalThis.acquireVsCodeApi?.();
const call=api?createBridge(api,listener=>globalThis.addEventListener('message',listener)):null;
export async function request(path,options={}){
 if(!call)return fetch(path,options);
 const body=options.body?JSON.parse(options.body):undefined;
 if(path==='/ui'){api.setState(body.ui);return {ok:true,json:async()=>({message:'Review position saved.'})};}
 const response=await call('request',{path,body});
 if(path.startsWith('/data')&&response.status===200)response.data.ui=api.getState()||{};
 return {ok:response.status>=200&&response.status<300,status:response.status,json:async()=>response.data};
}
export function openSource(values){return call('source',values);}
export function hostCommand(name){return call('command',{name});}
export async function imageSource(image,path){
 if(!call){image.src=path;return;}
 try{const source=await call('asset',{path});if(image.isConnected)image.src=source;}
 catch(error){image.alt=error.message;}
}
export function copyText(text){return call?call('copy',{text}):navigator.clipboard.writeText(text);}
export function exportFile(path){return call('export',{path});}
export function reviewReady(error){api?.postMessage({type:'review-ready',error});}

const frames=new Map();
export async function pdfFrame(frame,{path,marks,color}){
 for(const old of frames.keys())if(!old.isConnected)frames.delete(old);
 frames.set(frame,{path,marks,color});
 const uri=await call('viewer');
 if(frame.isConnected)frame.src=uri+'?parentOrigin='+encodeURIComponent(globalThis.location.origin);
}
if(api)globalThis.addEventListener('message',async event=>{
 if(!['review-pdf-ready','review-pdf-key','review-pdf-error'].includes(event.data?.type))return;
 for(const [frame,values] of frames){
  if(!frame.isConnected){frames.delete(frame);continue;}
  if(event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)continue;
  if(event.data.type==='review-pdf-key'){
   const {key,shiftKey,repeat}=event.data;
   if(typeof key==='string'&&/^[asdfucevrtgpnqmi?\[\]]$/i.test(key))document.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey:Boolean(shiftKey),repeat:Boolean(repeat),bubbles:true,cancelable:true}));
   return;
  }
  if(event.data.type==='review-pdf-error'){frame.replaceWith(Object.assign(document.createElement('p'),{className:'render-note',textContent:event.data.error}));frames.delete(frame);return;}
  try{
   const source=await call('asset',{path:values.path}),bytes=Uint8Array.from(atob(source.split(',')[1]),character=>character.charCodeAt(0));
   if(frame.isConnected)frame.contentWindow.postMessage({type:'review-pdf',document:values.path,data:bytes,marks:values.marks,color:values.color,active:true},new URL(frame.src).origin);
  }catch(error){frame.replaceWith(Object.assign(document.createElement('p'),{className:'render-note',textContent:error.message}));frames.delete(frame);}
 }
});

if(api)globalThis.addEventListener('review-flushed',event=>api.postMessage({type:'review-flushed',...event.detail}));
