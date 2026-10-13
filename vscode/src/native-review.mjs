import {reviewProgress} from '../../manuscript_review/review_model.js';

/** One source selection drives decisions, keyboard review and PDF navigation. */
export function createNativeReview(vscode,{runtime,enabled,sourceEdits,delivery,onOpen,onChange,onFocus,onMode,onComment,onError,isPDFActive=()=>false}){
 let projections=new WeakMap(),focused,focusMode=false,lastFocus,sourceEditor,actions=Promise.resolve(),navigationEpoch=0,generation=0,openingSource=false;
 const changed=new vscode.EventEmitter();
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,60);
 status.command='manuscriptReview.focusedReview';
 let disposed=false,busy=false;
 const current=(nearest=false)=>{
  if(disposed||!enabled())return;
  const editor=vscode.window.activeTextEditor||(isPDFActive()?sourceEditor:undefined),projection=projections.get(editor?.document),review=runtime()?.review;
  if(!projection||projection.data.id!==review?.id||projection.data.revision!==review.revision||editor.document.getText()!==projection.source.text)return;
  const cursor=editor.document.offsetAt(editor.selection.active);
  const pinned=focused?.file===projection.source.file&&projection.source.ranges.find(span=>span.id===focused.edit&&span.from<=cursor&&cursor<=span.to);
  const span=pinned||projection.source.ranges.find(span=>span.from<=cursor&&cursor<=span.to)
   ||(nearest&&(projection.source.ranges.find(span=>span.from>=cursor)||projection.source.ranges.at(-1)));
  return span?{editor,...projection,span}:undefined;
 };
 function setMode(value){focusMode=value;onMode?.(value);changed.fire();}
 function select(selected){
  if(!selected)return;
  sourceEditor=selected.editor;
  focused={file:selected.source.file,edit:selected.span.id};
  const key=selected.data.id+'/'+selected.data.revision+'/'+focused.file+'/'+focused.edit+'/'+focusMode;
  if(key!==lastFocus){lastFocus=key;onFocus?.(focused.file,focused.edit,selected,focusMode);}
 }
 async function open(message){openingSource=true;try{return sourceEditor=await onOpen(message);}finally{openingSource=false;}}
 function refresh(){
  changed.fire();
  const selected=current(true);
  if(!selected){status.hide();return;}
  const progress=reviewProgress(selected.data.files,selected.data.decisions);
  status.text=progress.complete?'Reviewed':progress.done+'/'+progress.total;
  status.tooltip=progress.complete?(selected.data.applied?'All changes reviewed and saved.':'All changes reviewed. Apply review in the sidebar.')
   :focusMode?'Review changes: A accept, S reject, D back, F forward. E edits the source.':'Review manuscript changes';
  status.show();
 }
 async function move(direction,{undecided=false}={}){
  await sourceEdits().flush();
  const service=runtime(),review=service.review.id,live=current(true),data=live?.data||await service.data('round');
  if(runtime()!==service||service.review.id!==review||service.review.revision!==data.revision)throw new Error('The review changed. Navigate its current changes.');
  const all=data.files.flatMap(file=>file.edits.map(edit=>({file:file.path,edit:edit.id})));
  const selected=current(true),anchor=selected?{file:selected.source.file,edit:selected.span.id}:focused;
  const index=all.findIndex(item=>item.file===anchor?.file&&item.edit===anchor?.edit);
  for(let step=1;step<=all.length;step++){
   const at=index<0?(direction>0?step-1:all.length-step):(index+direction*step+all.length)%all.length;
   const item=all[at];
   if(undecided&&['accept','reject'].includes(data.decisions[item.edit]))continue;
   const target=live?.source.file===item.file&&live.source.ranges.find(span=>span.id===item.edit);
   if(target){
    const point=live.editor.document.positionAt(target.from);
    live.editor.selection=new vscode.Selection(point,point);
    live.editor.revealRange(live.editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
   }else await open({file:item.file,edit:item.edit});
   if(runtime()!==service||service.review.id!==review)throw new Error('The review changed while opening this change.');
   focused=item;
   const latest=current();
   if(latest?.span.id===item.edit)select(latest);
   refresh();return true;
  }
  if(undecided)setMode(false);
  return false;
 }
 async function begin(entry){
  setMode(true);
  if(entry)await open({file:entry.file,...(entry.target?.kind==='edit'?{edit:entry.target.id}:{}),...(entry.id?{comment:entry.id}:{})});
  const selected=current(true);
  if(selected){
   focused={file:selected.source.file,edit:selected.span.id};
   const position=selected.editor.document.positionAt(selected.span.from);
   selected.editor.selection=new vscode.Selection(position,position);
   selected.editor.revealRange(selected.editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
   select(selected);refresh();return;
  }
  await move(1,{undecided:true});
 }
 async function decide(id,revision,file,edit,value,scope='edit'){
  if(busy)return;
  busy=true;
  try{
   const selected=current(),epoch=navigationEpoch,version=selected?.editor.document.version;
   if(!selected||selected.data.id!==id||selected.data.revision!==revision||selected.source.file!==file||selected.span.id!==edit)
    throw new Error('The source comparison changed. Choose its current edit.');
   await delivery().flush();await sourceEdits().flush();
   const latest=current();
   if(!latest||latest.data.id!==id||latest.data.revision!==revision||latest.source.file!==file||latest.span.id!==edit
    ||latest.editor!==selected.editor||latest.source.text!==selected.source.text||selected.editor.document.version!==version||selected.editor.document.isDirty)
    throw new Error('Save your source edits before deciding this change.');
   const source=selected.data.files.find(item=>item.path===file),group=source?.edits.find(item=>item.id===edit);
   const before=selected.editor.document.getText(),{from,to}=selected.span;
   if(!group||!['accept','reject','reset'].includes(value)||!['edit','passage','file'].includes(scope))throw new Error('Choose a current source change.');
   if(![group.old,group.new].includes(before.slice(from,to)))throw new Error('The editor differs from this proposal. Save it before deciding the change.');
   const targets=scope==='file'?source.edits:scope==='passage'?(source.hunks.find(passage=>passage.edits.some(item=>item.id===edit))?.edits||[]):[group];
   if(!targets.length)throw new Error('The passage changed. Select its current edit.');
   const decisions={...selected.data.decisions};
   for(const target of targets){if(value==='reset')delete decisions[target.id];else decisions[target.id]=value;}
   await runtime().request('/save',{revision,decisions,comments:selected.data.comments});
   if(runtime().review.id!==id)throw new Error('The decision was saved in its original review. Return there to update its source.');
   await delivery().refresh({force:true});
   await onChange();
   if(value!=='reset'&&epoch===navigationEpoch)await move(1,{undecided:true});
   else select(current());
  }catch(error){onError(error);}finally{busy=false;refresh();}
 }
 function decideCurrent(value,scope){
  const selected=current();
  if(!selected)throw new Error('Select a current manuscript change first.');
  return decide(selected.data.id,selected.data.revision,selected.source.file,selected.span.id,value,scope);
 }
 function edit(){generation++;navigationEpoch++;setMode(false);lastFocus=undefined;onFocus?.();return sourceEditor;}
 function enqueue(action){
  const ticket=generation,review=runtime()?.review?.id;
  const pending=actions.catch(()=>{}).then(()=>{if(!disposed&&ticket===generation&&runtime()?.review?.id===review)return action();});
  actions=pending;return pending;
 }
 const subscriptions=[changed,status,vscode.languages.registerCodeLensProvider([{scheme:'file'},{scheme:'manuscript-review-source'}],{onDidChangeCodeLenses:changed.event,
  provideCodeLenses(document){
   const selected=current();if(!selected||selected.editor.document!==document)return [];
   const point=document.positionAt(selected.span.from),range=new vscode.Range(point,point);
   const decision=selected.data.decisions[selected.span.id];
   const controls=['accept','reject'].map(value=>new vscode.CodeLens(range,{title:value==='accept'?(decision==='accept'?'Accepted':'Accept'):(decision==='reject'?'Rejected':'Reject'),
    command:'manuscriptReview.decideSource',arguments:[selected.data.id,selected.data.revision,selected.source.file,selected.span.id,value]}));
   controls.push(new vscode.CodeLens(range,{title:'Comment',command:'manuscriptReview.commentChange'}));
   return controls;
  }}),
  vscode.window.onDidChangeTextEditorSelection(event=>{
   if(event?.kind===vscode.TextEditorSelectionChangeKind.Mouse){navigationEpoch++;focused=undefined;edit();}
   else if(event?.kind===vscode.TextEditorSelectionChangeKind.Keyboard)navigationEpoch++;
   const selected=current();if(selected)select(selected);refresh();
  }),
  vscode.window.onDidChangeActiveTextEditor(()=>{if(!current(true)&&!isPDFActive()&&!openingSource)edit();refresh();}),
  vscode.workspace.onDidChangeTextDocument(event=>{
   if(event?.reason===vscode.TextDocumentChangeReason.Undo||event?.reason===vscode.TextDocumentChangeReason.Redo)edit();
   refresh();
  }),
  vscode.commands.registerCommand('manuscriptReview.decideSource',(...args)=>enqueue(()=>decide(...args)))];
 return {begin:entry=>enqueue(()=>begin(entry)),move:(...args)=>enqueue(()=>move(...args)),edit,decide:(...args)=>enqueue(()=>decideCurrent(...args)),comment:()=>{const selected=current();if(!selected)throw new Error('Select a current change first.');return onComment(selected);},
  selection(){const selected=current(true);return selected?{file:selected.source.file,target:{id:selected.span.id,kind:'edit'},source:true}:undefined;},
  update(source,data){projections.set(source.document,{source,data});select(current());refresh();},
  clear(){generation++;navigationEpoch++;projections=new WeakMap();focused=lastFocus=sourceEditor=undefined;setMode(false);status.hide();},
  refresh,dispose(){disposed=true;generation++;for(const subscription of subscriptions)subscription.dispose();projections=new WeakMap();}};
}
