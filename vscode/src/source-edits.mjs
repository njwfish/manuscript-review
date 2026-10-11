import {sourceFile} from './comments.mjs';

/** VS Code owns file saves; the review captures their latest saved wording. */
export function createSourceEdits(runtime,{flushPanel,unlockPanel,refreshPanel,refreshComments}){
 const pending=new Map();let saving=Promise.resolve(),disposed=false;
 async function drain(){
  while(pending.size&&!disposed){
   const [file,entry]=pending.entries().next().value;
   if(runtime.review?.id!==entry.review){
    if(pending.get(file)===entry)pending.delete(file);continue;
   }
   const lock=await flushPanel({lock:true});
   try{
    if(disposed||runtime.review?.id!==entry.review)throw new Error('The review changed before its saved edits were captured.');
    const data=await runtime.data('round');
    if(pending.get(file)!==entry)continue;
    try{await runtime.request('/capture',{file,text:entry.text,source:data.workspace_version});}
    catch(error){if(pending.get(file)!==entry)continue;throw error;}
    if(pending.get(file)===entry)pending.delete(file);
    await refreshPanel({flushed:true});await refreshComments();
   }finally{unlockPanel(lock);}
  }
 }
 function flush(){saving=saving.catch(()=>{}).then(drain);return saving;}
 function save(document){
  const review=runtime.review,file=sourceFile(review,document);
  if(disposed||document.uri.scheme!=='file'||!file||!review.workspace||document.isDirty)return Promise.resolve();
  pending.set(file,{review:review.id,text:document.getText()});
  return flush();
 }
 return {save,flush,get pending(){return pending.size>0;},dispose(){disposed=true;}};
}
