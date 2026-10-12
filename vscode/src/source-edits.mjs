import {sourceFile} from './comments.mjs';

/** VS Code owns file saves; the review captures their latest saved wording. */
export function createSourceEdits(runtime,{flushPanel,unlockPanel,refreshPanel,refreshComments,state,reviewing=()=>true}){
 const pending=new Map(),intents=new WeakMap(),editing=new Map(Object.entries(state?.get('deliveredSources',{})||{}));let saving=Promise.resolve(),disposed=false,deliveryGate,releaseDelivery;
 const key=(file,review=runtime.review.id)=>review+'/'+file;
 const active=()=>[...pending.entries()].find(([,entry])=>entry.review===runtime.review?.id);
 const persist=()=>state?.update('deliveredSources',Object.fromEntries(editing));
 async function drain(){
  while(active()&&!disposed){
   await deliveryGate;
   const [identifier,entry]=active(),file=entry.file;
   const lock=await flushPanel({lock:true});
   try{
    if(disposed||runtime.review?.id!==entry.review)throw new Error('The review changed before its saved edits were captured.');
    const data=await runtime.request('/summary');
    if(pending.get(identifier)!==entry)continue;
    try{await runtime.request('/capture',{file,text:entry.text,source:data.workspace_version,intent:entry.intent,...(entry.editing?{editing:entry.editing}:{})});}
    catch(error){if(pending.get(identifier)!==entry)continue;throw error;}
    if(pending.get(identifier)===entry){pending.delete(identifier);if(entry.editing&&editing.get(key(file))?.source===entry.editing){editing.delete(key(file));await persist();}}
    await refreshPanel({flushed:true});await refreshComments();
   }finally{unlockPanel(lock);}
  }
 }
 function flush(){saving=saving.catch(()=>{}).then(drain);return saving;}
 function save(document){
  const review=runtime.review,file=sourceFile(review,document);
  if(disposed||document.uri.scheme!=='file'||!file||!review.workspace||document.isDirty)return Promise.resolve();
  const text=document.getText(),delivered=editing.get(key(file));
  const intent=intents.get(document)?.review===review.id?intents.get(document).intent:reviewing()?'proposal':'author';
  intents.delete(document);
  pending.set(key(file),{review:review.id,file,text,intent,editing:delivered&&(delivered.applied||text!==delivered.before)?delivered.source:undefined});
  return flush();
 }
 function change(document){
  if(disposed||deliveryGate||!sourceFile(runtime.review,document))return;
  if(!document.isDirty){const intent=intents.get(document);if(intent)intent.closed=true;return;}
  if(intents.get(document)?.closed||intents.get(document)?.review!==runtime.review.id)intents.set(document,{review:runtime.review.id,intent:reviewing()?'proposal':'author'});
 }
 return {save,change,flush,async delivered(files,source,review=runtime.review.id){deliveryGate=new Promise(resolve=>releaseDelivery=resolve);for(const file of files)editing.set(key(file.file,review),{source,before:file.before});await persist();},
  async completeDelivery(files,source,applied,review=runtime.review.id){
   for(const file of files){const marker=editing.get(key(file.file,review));if(marker?.source===source){if(applied)marker.applied=true;else editing.delete(key(file.file,review));}const entry=pending.get(key(file.file,review));if(!applied&&entry?.editing===source)entry.editing=undefined;}
   const saved=persist();releaseDelivery?.();deliveryGate=releaseDelivery=undefined;await saved;
  },
  get pending(){return Boolean(active());},dispose(){disposed=true;}};
}
