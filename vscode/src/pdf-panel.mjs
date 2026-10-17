import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** PDF is a view of selected source; every review action belongs to the editor. */
export function createPDFPanel(vscode,context,runtime,{viewer,onAction,onError,showReviewed=()=>false,enabled=()=>true}){
 let panel,instance,ready=new Set(),selection,reviewing=false,documentKeys={},displayed={},cached,timer,refreshing,opening,again=false,generation=0,disposed=false;
 const post=message=>panel?.webview.postMessage({...message,instance});
 const keys=new Map([['a','accept'],['s','reject'],['d','previous'],['f','next'],['e','edit'],['c','comment'],['u','reset'],['escape','edit']]);
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>void refresh().catch(onError),500);}
 const sides=['before','after'];
 const normalized=(mark,document)=>{
  const page=document.pages[mark.page-1];
  return {...mark,bounds:mark.bounds?.map((value,index)=>Math.max(0,Math.min(1,value/(index%2?page.height:page.width))))??null};
 };
 async function publish(data,documents,bytes={}){
  const selected=selection?.review===data.id&&selection.revision===data.revision?selection:undefined;
  for(const side of sides){
   const document=documents[side];
   if(!document?.pdf){await post({type:'status',side,text:document?.error||'This version has no PDF document.'});continue;}
   const marks=enabled()?Object.entries(document.edits||{}).flatMap(([id,marks])=>
    !showReviewed()&&['accept','reject'].includes(data.decisions?.[id])?[]:
     marks.map(mark=>({...normalized(mark,document),selected:id===selected?.edit}))):[];
   const focus=enabled()?(document.contexts?.[selected?.edit]||document.edits?.[selected?.edit]||[]).map(mark=>normalized(mark,document)):[];
   const value=bytes[side];
   await post({type:'document',side,document:documentKeys[side],
    ...(value?{data:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)}:{}),
    selection:selected?.token,marks,focus,color:side==='before'?'removed':'added',reviewing,active:enabled()&&Boolean(selected)});
  }
 }
 function updateSelection(){
  if(panel&&ready.size===2&&cached?.data.id===runtime.review?.id&&cached.data.revision===runtime.review.revision)
   return publish(cached.data,cached.documents);
  return refresh();
 }
 async function refresh(){
  if(disposed||!panel||ready.size!==2)return;
  again=true;
  if(refreshing)return refreshing;
  refreshing=(async()=>{
   do{
    again=false;
    const ticket=generation,review=runtime.review?.id;
    if(!review)return;
    try{
    const data=await runtime.request('/summary');
    if(ticket!==generation||runtime.review?.id!==review||runtime.review.revision!==data.revision){again=Boolean(panel&&ready.size===2);continue;}
    const preview=await runtime.request('/previews?scope=selected');
    if(ticket!==generation||runtime.review?.id!==review){again=Boolean(panel&&ready.size===2);continue;}
    if(!panel||ready.size!==2)return;
    if(preview.proposed!==data.result||preview.proposal!==data.proposed||preview.entry!==data.entry){again=true;continue;}
    const documents=preview.documents;
    if(['queued','rendering'].includes(preview.preview_status)){
     for(const side of sides)await post({type:'status',side,text:'Updating PDF…'});
     schedule();return;
    }
    const keys=Object.fromEntries(sides.map(side=>[side,review+'/'+(side==='before'?preview.base:preview.proposed)+'/'+data.entry]));
    const bytes={},views={...documents},nextKeys={...keys};
    const assets=await Promise.allSettled(sides.map(async side=>{
     if(documents[side]?.pdf&&keys[side]!==documentKeys[side])
      bytes[side]=(await runtime.asset('/selected-assets/'+documents[side].pdf)).bytes;
    }));
    for(const [index,result] of assets.entries())if(result.status==='rejected'){
     const side=sides[index];delete nextKeys[side];
     views[side]={...documents[side],pdf:undefined,error:result.reason.message};
    }
    if(ticket!==generation||runtime.review?.id!==review||runtime.review.revision!==data.revision){again=Boolean(panel&&ready.size===2);continue;}
    if(!panel)return;
    documentKeys=nextKeys;
    cached={data,documents:views};
    panel.title='PDF: '+data.entry;
    await publish(data,views,bytes);
    }catch(error){if(ticket===generation&&runtime.review?.id===review){await Promise.all(sides.map(side=>post({type:'status',side,text:error.message})));throw error;}again=Boolean(panel&&ready.size===2&&!disposed);}
   }while(again&&panel);
  })().finally(()=>{refreshing=undefined;});
  return refreshing;
 }
 async function show(sourceColumn,check=()=>{}){
  if(disposed)return;
  if(check()===false)return;
  if(panel){panel.reveal(Number.isInteger(sourceColumn)&&sourceColumn>0?column(sourceColumn):panel.viewColumn??vscode.ViewColumn.Beside,true);return refresh();}
  if(opening)return opening;
  const pending=create(sourceColumn,check).finally(()=>{if(opening===pending)opening=undefined;});opening=pending;return pending;
 }
 function column(sourceColumn){return Number.isInteger(sourceColumn)&&sourceColumn>0?sourceColumn+1:vscode.ViewColumn.Beside;}
 async function create(sourceColumn,check){
  const ticket=++generation,id=randomUUID();instance=id;ready=new Set();
  const local=new URL('viewer.html',await viewer.start());
  const address=(await vscode.env.asExternalUri(vscode.Uri.parse(local.href))).toString(),origin=new URL(address).origin;
  if(disposed||ticket!==generation||check()===false)return;
  panel=vscode.window.createWebviewPanel('manuscriptReview.pdf','PDF: '+path.basename(runtime.review.repo),
   {viewColumn:column(sourceColumn),preserveFocus:true},{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.file(path.join(context.extensionPath,'dist'))]});
  const current=panel,script=panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath,'dist/pdf-panel.js')));
  const panes=sides.map(side=>'<section><header class="'+side+'">'+(side==='before'?'Original':'Proposed')+'</header><p id="'+side+'-status">Updating PDF…</p><iframe id="'+side+'-pdf" title="'+(side==='before'?'Original':'Proposed')+' manuscript PDF" hidden></iframe></section>').join('');
  panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src '+panel.webview.cspSource+'; style-src \'unsafe-inline\'; frame-src '+origin+';"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}body{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--vscode-panel-border)}section{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--vscode-editor-background)}header{padding:7px 14px;font-size:11px}.before{color:var(--vscode-gitDecoration-deletedResourceForeground)}.after{color:var(--vscode-gitDecoration-addedResourceForeground)}iframe{flex:1;min-height:0;width:100%;border:0}p{padding:12px 14px;margin:0;color:var(--vscode-descriptionForeground)}[hidden]{display:none}@media(max-width:900px){body{grid-template-columns:1fr;grid-template-rows:1fr 1fr}}</style></head><body data-instance="'+id+'">'+panes+'<script src="'+script+'"></script></body></html>';

  const subscriptions=[
   panel.webview.onDidReceiveMessage(async message=>{
    if(panel!==current||message?.instance!==id)return;
    try{
     if(message.type==='loaded')await post({type:'viewer',url:address});
     else if(message.type==='ready'&&sides.includes(message.side)){ready.add(message.side);if(ready.size===2)await refresh();}
     else if(message.type==='rendered'&&message.document===documentKeys[message.side])displayed[message.side]=message.selection;
     else if(message.type==='key'&&reviewing){
      const action=keys.get(message.key?.toLowerCase());
      if(['accept','reject','reset'].includes(action)&&(!sides.includes(message.side)||message.selection!==displayed[message.side]||message.selection!==selection?.token||selection?.revision!==runtime.review.revision))return;
      if(action)await onAction(action,message.ctrlKey?'file':message.shiftKey?'passage':'edit');
     }else if(message.type==='error'&&message.document===documentKeys[message.side]){displayed[message.side]=undefined;delete documentKeys[message.side];cached=undefined;await post({type:'status',side:message.side,text:message.error});onError(new Error(message.error));}
    }catch(error){onError(error);}
   }),
   panel.onDidChangeViewState(()=>{if(current.active)void onAction('focus').catch(onError);}),
   panel.onDidDispose(()=>{if(panel!==current)return;panel=undefined;ready=new Set();generation++;cached=undefined;documentKeys={};displayed={};clearTimeout(timer);for(const item of subscriptions)item.dispose();})
  ];
 }
 return {show,refresh,select(file,edit,revision){
   const review=runtime.review?.id;if(!review)return;const token=review+'/'+revision+'/'+file+'/'+edit;
   selection=file?{file,edit,revision,review,token}:undefined;return updateSelection();
  },
  reset(){generation++;cached=selection=undefined;documentKeys={};displayed={};clearTimeout(timer);for(const side of sides)post({type:'status',side,text:'Updating PDF…'});},
  setMode(value){reviewing=value;void updateSelection()?.catch(onError);},get active(){return Boolean(panel?.active);},get visible(){return Boolean(panel?.visible);},
  hide(){generation++;opening=undefined;panel?.dispose();},
  dispose(){disposed=true;generation++;clearTimeout(timer);panel?.dispose();}};
}

/** Follow an existing Workshop PDF without opening another viewer. */
export async function followWorkshopPDF(vscode,selected){
 const document=selected?.editor.document;
 if(document?.uri.scheme!=='file'||!document.uri.fsPath.endsWith('.tex')||document.isDirty)return;
 const folder=selected.data.workspace||selected.data.repo,entry=selected.data.entry;
 if(!entry)return;
 const root=path.join(folder,entry),dir=path.dirname(root),name=path.basename(root,'.tex');
 const out=vscode.workspace.getConfiguration('latex-workshop',vscode.Uri.file(root)).get('latex.outDir','%DIR%');
 const expanded=out.replaceAll('%DIR%',dir).replaceAll('%DOC%',name).replaceAll('%DOCFILE%',name);
 if(expanded.includes('%'))return;
 const pdf=path.resolve(dir,expanded,name+'.pdf');
 const open=vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>
  tab.input?.viewType==='latex-workshop-pdf-hook'&&tab.input.uri?.fsPath===pdf));
 if(!open)return;
 const extension=vscode.extensions.getExtension('James-Yu.latex-workshop');
 if(!extension)return;
 await extension.activate();
 await vscode.commands.executeCommand('latex-workshop.synctexto',document.positionAt(selected.span.from).line,document.uri.fsPath);
}
