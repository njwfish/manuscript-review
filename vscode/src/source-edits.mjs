import {sourceFile} from './comments.mjs';

/** VS Code owns file saves; the review captures their latest saved wording. */
export function createSourceEdits(runtime,{flushPanel,unlockPanel,refreshPanel,refreshComments,state}){
 const pending=new Map(),editing=new Map(Object.entries(state?.get('deliveredSources',{})||{}));let saving=Promise.resolve(),disposed=false,deliveryGate,releaseDelivery;
 const key=file=>runtime.review.id+'/'+file;
 const persist=()=>state?.update('deliveredSources',Object.fromEntries(editing));
 async function drain(){
  while(pending.size&&!disposed){
   await deliveryGate;
   const [file,entry]=pending.entries().next().value;
   if(runtime.review?.id!==entry.review){
    if(pending.get(file)===entry)pending.delete(file);continue;
   }
   const lock=await flushPanel({lock:true});
   try{
    if(disposed||runtime.review?.id!==entry.review)throw new Error('The review changed before its saved edits were captured.');
    const data=await runtime.data('round');
    if(pending.get(file)!==entry)continue;
    try{await runtime.request('/capture',{file,text:entry.text,source:data.workspace_version,...(entry.editing?{editing:entry.editing}:{})});}
    catch(error){if(pending.get(file)!==entry)continue;throw error;}
    if(pending.get(file)===entry){pending.delete(file);if(entry.editing&&editing.get(key(file))?.source===entry.editing){editing.delete(key(file));await persist();}}
    await refreshPanel({flushed:true});await refreshComments();
   }finally{unlockPanel(lock);}
  }
 }
 function flush(){saving=saving.catch(()=>{}).then(drain);return saving;}
 function save(document){
  const review=runtime.review,file=sourceFile(review,document);
  if(disposed||document.uri.scheme!=='file'||!file||!review.workspace||document.isDirty)return Promise.resolve();
  const text=document.getText(),delivered=editing.get(key(file));
  pending.set(file,{review:review.id,text,editing:delivered&&(delivered.applied||text!==delivered.before)?delivered.source:undefined});
  return flush();
 }
 return {save,flush,async delivered(files,source){deliveryGate=new Promise(resolve=>releaseDelivery=resolve);for(const file of files)editing.set(key(file.file),{source,before:file.before});await persist();},
  async completeDelivery(files,source,applied){
   for(const file of files){const marker=editing.get(key(file.file));if(marker?.source===source){if(applied)marker.applied=true;else editing.delete(key(file.file));}const entry=pending.get(file.file);if(!applied&&entry?.editing===source)entry.editing=undefined;}
   const saved=persist();releaseDelivery?.();deliveryGate=releaseDelivery=undefined;await saved;
  },
  get pending(){return pending.size>0;},dispose(){disposed=true;}};
}
