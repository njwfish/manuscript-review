/** Native source is the proposal editor; the session owns decisions and versions. */
export function createNativeReview(vscode,{runtime,enabled,sourceEdits,delivery,onChange,onFocus,onError}){
 let projections=new WeakMap();
 const changed=new vscode.EventEmitter();
 let disposed=false,busy=false,lastFocus;
 const current=(nearest=false)=>{
  if(disposed||!enabled())return;
  const editor=vscode.window.activeTextEditor,projection=projections.get(editor?.document),review=runtime()?.review;
  if(!projection||projection.data.id!==review?.id||projection.data.revision!==review.revision||editor.document.getText()!==projection.source.text)return;
  const cursor=editor.document.offsetAt(editor.selection.active);
  const span=projection.source.ranges.find(span=>span.from<=cursor&&cursor<=span.to)
   ||(nearest&&(projection.source.ranges.find(span=>span.from>=cursor)||projection.source.ranges.at(-1)));
  return span?{editor,...projection,span}:undefined;
 };
 const subscriptions=[changed,vscode.languages.registerCodeLensProvider({scheme:'file'},{onDidChangeCodeLenses:changed.event,
  provideCodeLenses(document){const selected=current();if(!selected||selected.editor.document!==document)return [];
   const position=document.positionAt(selected.span.from),range=new vscode.Range(position,position);
   const decision=selected.data.decisions[selected.span.id];
   return ['accept','reject'].map(value=>new vscode.CodeLens(range,{title:value==='accept'?(decision==='accept'?'Accepted':'Accept'):(decision==='reject'?'Rejected':'Reject'),
    command:'manuscriptReview.decideSource',arguments:[selected.data.id,selected.data.revision,selected.source.file,selected.span.id,value]}));}}),
  vscode.window.onDidChangeTextEditorSelection(()=>{changed.fire();const selected=current();if(selected){const key=selected.data.id+'/'+selected.source.file+'/'+selected.span.id;if(key!==lastFocus){lastFocus=key;onFocus?.(selected.source.file,selected.span.id);}}}),
  vscode.window.onDidChangeActiveTextEditor(()=>changed.fire()),
  vscode.workspace.onDidChangeTextDocument(()=>changed.fire()),
  vscode.commands.registerCommand('manuscriptReview.decideSource',async(id,revision,file,edit,value)=>{
   if(busy)return;
   busy=true;
   try{
    const selected=current();
    if(!selected||selected.data.id!==id||selected.data.revision!==revision||selected.source.file!==file||selected.span.id!==edit)
     throw new Error('The source comparison changed. Choose its current edit.');
    await delivery().flush();await sourceEdits().flush();
    if(current()?.data!==selected.data||runtime().review.revision!==revision||selected.editor.document.isDirty)
     throw new Error('Save your source edits before deciding this change.');
    const group=selected.data.files.find(item=>item.path===file)?.edits.find(item=>item.id===edit);
    const {document}=selected.editor,{from,to}=selected.span,before=document.getText();
    if(!group||!['accept','reject'].includes(value))throw new Error('Choose a current source change.');
    if(![group.old,group.new].includes(before.slice(from,to)))throw new Error('The editor differs from this proposal. Save it before deciding the change.');
    await runtime().request('/save',{revision,decisions:{...selected.data.decisions,[edit]:value},comments:selected.data.comments});
    if(runtime().review.id!==id)throw new Error('The decision was saved in its original review. Return there to update its source.');
    await delivery().refresh({force:true});
    await onChange();
    const latest=projections.get(document);
    if(runtime().review.id===id&&latest?.data.revision===runtime().review.revision&&document.getText()===latest.source.text){
     const pending=latest.source.ranges.filter(span=>span.id!==edit&&!['accept','reject'].includes(latest.data.decisions[span.id]));
     const next=pending.find(span=>span.from>from)||pending[0];
     if(next){const position=document.positionAt(next.from);selected.editor.selection=new vscode.Selection(position,position);selected.editor.revealRange(selected.editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);}
    }
   }catch(error){onError(error);}finally{busy=false;changed.fire();}
  })];
 return {selection(){const selected=current(true);return selected?{file:selected.source.file,target:{id:selected.span.id,kind:'edit'},source:true}:undefined;},
  update(source,data){projections.set(source.document,{source,data});changed.fire();},clear(){projections=new WeakMap();lastFocus=undefined;changed.fire();},
  refresh(){changed.fire();},dispose(){disposed=true;for(const subscription of subscriptions)subscription.dispose();projections=new WeakMap();}};
}
