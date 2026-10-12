/** Deliver to saved native buffers with undo; source capture owns the comparison. */
export function createDelivery(vscode,runtime,{sourceEdits,paused,onDelivered,onConflict,openDocument}){
 let active,again=false,forced=false,disposed=false;
 async function deliver(force){
  const review=runtime.review?.id;
  if(disposed||!review||(!force&&paused()))return;
  await sourceEdits.flush();
  const data=await runtime.request('/summary');
  if(!force&&!data.authoring||runtime.review?.id!==review||(!force&&paused()))return;
  const plan=await runtime.request('/delivery',{revision:data.revision,...(force?{explicit:true}:{})});
  if(plan.conflicts?.length)await onConflict?.();
  if(!plan.files.length)return;
  const entries=await Promise.all(plan.files.map(async file=>({file,document:await openDocument(file.file)})));
  const available=()=>!disposed&&runtime.review?.id===review&&(force||!paused());
  if(!available())return;
  let captured=false;
  for(const {file,document} of entries){
   if(document.uri.scheme==='file'&&!document.isDirty&&!document.isClosed&&document.getText()!==file.before){await sourceEdits.save(document);captured=true;}
  }
  if(captured){again=true;return;}
  const eligible=entries.filter(({file,document})=>document.uri.scheme==='file'&&!document.isDirty&&!document.isClosed&&document.getText()===file.before).map(entry=>({...entry,version:entry.document.version}));
  if(!eligible.length)return;
  const current=()=>available()&&runtime.review.revision===plan.revision
   &&eligible.every(({file,document,version})=>document.version===version&&!document.isDirty&&!document.isClosed&&document.getText()===file.before);
  const files=eligible.map(entry=>({...entry.file,version:entry.version}));
  const edits=new vscode.WorkspaceEdit();
  for(const {file,document} of eligible)edits.set(document.uri,file.edits.map(edit=>new vscode.TextEdit(new vscode.Range(document.positionAt(edit.from),document.positionAt(edit.to)),edit.text)));
  let applied=false,staged=false;
  try{
   await sourceEdits.delivered(files,plan.source,review);
   staged=true;
   if(current())applied=await vscode.workspace.applyEdit(edits);else if(available())again=true;
  }finally{if(staged)await sourceEdits.completeDelivery(files,plan.source,applied,review);}
  if(!applied)return;
  for(const {file,document} of eligible){
   if(document.getText()===file.after&&!await document.save())throw new Error('Agent changes are in the editor. Save the document to finish updating its comparison.');
  }
  await sourceEdits.flush();
  if(runtime.review?.id===review)await onDelivered();
 }
 return {refresh({force=false}={}){forced ||= force;again=true;return active??=((async()=>{do{again=false;const requested=forced;forced=false;await deliver(requested);}while(again&&!disposed);})().finally(()=>{active=undefined;}));},flush:()=>active,get pending(){return Boolean(active);},dispose(){disposed=true;}};
}
