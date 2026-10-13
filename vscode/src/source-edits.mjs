import {randomUUID} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {sourceFile} from './comments.mjs';

/** Saved buffers are an ordered ledger; VS Code alone owns their source writes. */
export function createSourceEdits(runtime,{onChange,state,intent=()=> 'proposal',recoverDelivery,resolveCapture}){
 const pending=new Map(Object.entries(state?.get('savedSources',{})||{})),intents=new WeakMap(),editing=new Map(Object.entries(state?.get('deliveredSources',{})||{}));
 const stagedDocuments=new Map();
 let saving=Promise.resolve(),persisting=Promise.resolve(),disposed=false,deliveryGate,releaseDelivery;
 const key=(file,review=runtime.review.id)=>review+'/'+file;
 const active=()=>[...pending.entries()].find(([,entry])=>entry.review===runtime.review?.id);
 function persist(){
  const saved=Object.fromEntries(pending),delivered=Object.fromEntries(editing);
  persisting=persisting.catch(()=>{}).then(()=>Promise.all([state?.update('savedSources',saved),state?.update('deliveredSources',delivered)]));
  return persisting;
 }
 async function drain(){
  while(active()&&!disposed){
   await deliveryGate;
   const item=active();if(!item||disposed)return;
   const [identifier,entry]=item,file=entry.file;
   const marker=editing.get(identifier);
   if(marker&&!marker.applied&&!deliveryGate){
    const text=entry.saves.at(-1).text;
    const applied=await recoverDelivery?.({file,review:entry.review,before:marker.before,after:marker.after,text});
    if(typeof applied!=='boolean')throw new Error('An interrupted delivery needs its source confirmed before these saved edits can be captured. Retry Save to choose its origin.');
    if(applied){
     const latest=pending.get(identifier);
     pending.set(identifier,{...latest,saves:latest.saves.map(save=>{const {unconfirmed,...point}=save;return unconfirmed?{...point,editing:marker.source}:point;})});
    }
    await completeDelivery([{file}],marker.source,applied,entry.review);continue;
   }
   if(disposed||runtime.review?.id!==entry.review)throw new Error('The review changed before its saved edits were captured.');
   await runtime.request('/summary');
   if(disposed||runtime.review?.id!==entry.review)throw new Error('The review changed before its saved edits were captured.');
   if(pending.get(identifier)!==entry)continue;
   // Keep large bursts bounded without dropping any save or its editing intent.
   const saves=[];let bytes=Buffer.byteLength(entry.saves.at(-1).text,'utf8');
   for(const save of entry.saves){const size=Buffer.byteLength(JSON.stringify(save),'utf8');if(saves.length&&bytes+size>12_000_000)break;saves.push(save);bytes+=size;}
   let result;
   try{result=await runtime.request('/capture',{file,text:entry.saves.at(-1).text,source:entry.source,cursor:entry.cursor,saves});}
   catch(error){
    if(pending.get(identifier)!==entry)continue;
    const conflict=error.capture;
    if(conflict?.file===file&&conflict.intent==='proposal'&&saves.some(save=>save.id===conflict.save&&save.intent==='author')&&await resolveCapture?.(conflict)){
     const latest=pending.get(identifier);
     pending.set(identifier,{...latest,saves:latest.saves.map(save=>save.id===conflict.save?{...save,intent:'proposal'}:save)});
     await persist();continue;
    }
    throw error;
   }
   if(result.captured!==saves.at(-1).id)throw new Error('The source service did not acknowledge these saves. They remain available for retry.');
   const latest=pending.get(identifier),remaining=latest.saves.slice(saves.length);
   if(remaining.length)pending.set(identifier,{...latest,source:result.workspace_version,cursor:result.cursor,saves:remaining});else pending.delete(identifier);
   const delivered=editing.get(key(file));
   if(delivered&&saves.some(save=>save.editing===delivered.source))editing.delete(key(file));
   await persist();await onChange();
  }
 }
 function flush(){saving=saving.catch(()=>{}).then(async()=>{await persisting;await drain();});return saving;}
 function save(document){
  const review=runtime.review,file=sourceFile(review,document);
  if(disposed||document.uri.scheme!=='file'||!file||!review.workspace||document.isDirty)return Promise.resolve();
  const text=document.getText(),delivered=editing.get(key(file));
  const typing=intents.get(document)?.review===review.id?intents.get(document):undefined;
  const policy=typing?.manual??typing?.intent??intent();
  intents.delete(document);
  const staged=stagedDocuments.get(key(file));
  const point={id:randomUUID().replaceAll('-',''),text,intent:policy,
   ...(typing?.manual?{staging:typing.delivery,staged_intent:typing.intent}:{}),
   ...(delivered&&!delivered.applied&&!deliveryGate?{unconfirmed:true}:{}),
   ...(delivered&&(delivered.applied||staged?.document===document||text!==delivered.before)?{editing:delivered.source}:{})};
  const previous=pending.get(key(file));
  pending.set(key(file),previous?{...previous,saves:[...previous.saves,point]}:
   {review:review.id,file,source:review.workspace_version,cursor:review.source_cursors?.[file]??null,saves:[point]});
  void persist();return flush();
 }
 function change(document){
  const file=sourceFile(runtime.review,document);
  if(disposed||!file)return;
  if(!document.isDirty){const intent=intents.get(document);if(intent)intent.closed=true;return;}
  const marker=editing.get(key(file));
  const candidate=deliveryGate&&marker&&!marker.applied&&document.getText()===marker.after&&(marker.version===undefined||document.version===marker.version+1);
  if(candidate)stagedDocuments.set(key(file),{document,source:marker.source});
  const previous=intents.get(document);
  if(previous?.closed||previous?.review!==runtime.review.id)intents.set(document,{review:runtime.review.id,intent:intent(),provisional:Boolean(candidate),delivery:candidate?marker.source:undefined});
  else if(previous.provisional&&!candidate){previous.manual=intent();previous.provisional=false;}
 }
 async function completeDelivery(files,source,applied,review=runtime.review.id){
  try{
   for(const file of files){
    const identifier=key(file.file,review),marker=editing.get(identifier);
    if(marker?.source===source){if(applied)editing.set(identifier,{...marker,applied:true});else editing.delete(identifier);}
    const staged=stagedDocuments.get(identifier);
    if(staged?.source===source){
     const intent=intents.get(staged.document);
     if(intent?.delivery===source){
      if(applied&&intent.provisional)intents.delete(staged.document);
      else{intent.intent=applied?(intent.manual??intent.intent):intent.intent;intent.provisional=false;delete intent.manual;delete intent.delivery;}
     }
     stagedDocuments.delete(identifier);
    }
    const entry=pending.get(identifier);
    if(entry)pending.set(identifier,{...entry,saves:entry.saves.map(save=>{
     const {unconfirmed,staging,staged_intent,...point}=save;
     if(!applied&&staging===source)point.intent=staged_intent;
     if(applied||point.editing!==source)return point;const {editing,...authored}=point;return authored;
    })});
   }
   await persist();
  }finally{releaseDelivery?.();deliveryGate=releaseDelivery=undefined;}
 }
 return {save,change,flush,async delivered(files,source,review=runtime.review.id){
  if(files.some(file=>{const marker=editing.get(key(file.file,review));return marker&&!marker.applied;}))throw new Error('Save the manuscript to confirm its interrupted delivery before receiving more agent changes.');
  deliveryGate=new Promise(resolve=>releaseDelivery=resolve);for(const file of files)editing.set(key(file.file,review),{source,before:file.before,after:file.after,version:file.version});
  try{await persist();}catch(error){await completeDelivery(files,source,false,review);throw error;}
 },completeDelivery,get pending(){return Boolean(active());},dispose(){disposed=true;}};
}
