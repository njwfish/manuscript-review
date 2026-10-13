import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** PDF is a view of selected source; every review action belongs to the editor. */
export function createPDFPanel(vscode,context,runtime,{viewer,onAction,onError}){
 let panel,instance,ready=false,selection,reviewing=false,documentKey,displayed,cached,timer,refreshing,opening,again=false,generation=0,disposed=false;
 const post=message=>panel?.webview.postMessage({...message,instance});
 const keys=new Map([['a','accept'],['s','reject'],['d','previous'],['f','next'],['e','edit'],['c','comment'],['u','reset'],['escape','edit']]);
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>void refresh().catch(onError),500);}
 function publish(data,document,key,bytes){
  const selected=selection?.review===data.id&&selection.revision===data.revision?selection:undefined;
  const marks=(document.edits[selected?.edit]||[]).map(mark=>{
   const page=document.pages[mark.page-1];
   return {page:mark.page,bounds:mark.bounds?.map((value,index)=>Math.max(0,Math.min(1,value/(index%2?page.height:page.width))))??null};
  });
  return post({type:'document',document:key,...(bytes?{data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}:{}),
   selection:selected?.token,marks,color:selected?.removed?'removed':'added',reviewing,active:true});
 }
 function updateSelection(){
  if(panel&&ready&&cached?.data.id===runtime.review?.id&&cached.data.revision===runtime.review.revision)
   return publish(cached.data,cached.document,documentKey);
  return refresh();
 }
 async function refresh(){
  if(disposed||!panel||!ready)return;
  again=true;
  if(refreshing)return refreshing;
  refreshing=(async()=>{
   do{
    again=false;
    const ticket=generation,review=runtime.review?.id;
    if(!review)return;
    try{
    const data=await runtime.request('/summary');
    const preview=await runtime.request('/previews?scope=selected');
    if(ticket!==generation||runtime.review?.id!==review){again=Boolean(panel&&ready);continue;}
    if(!panel||!ready)return;
    if(preview.proposed!==data.result||preview.proposal!==data.proposed||preview.entry!==data.entry){again=true;continue;}
    const document=preview.documents.after;
    if(!document?.pdf){
     const pending=['queued','rendering'].includes(preview.preview_status);
     post({type:'status',text:pending?'Updating PDF…':preview.preview_error||document?.error||'No PDF for this manuscript.'});
     if(pending)schedule();
     return;
    }
    const key=review+'/'+preview.proposed+'/'+data.entry;
    let bytes;
    if(key!==documentKey){
     ({bytes}=await runtime.asset('/selected-assets/'+document.pdf));
     if(ticket!==generation||runtime.review?.id!==review||runtime.review.revision!==data.revision){again=Boolean(panel&&ready);continue;}
     if(!panel)return;
    }
    documentKey=key;
    cached={data,document};
    await publish(data,document,key,bytes);
    }catch(error){if(ticket===generation&&runtime.review?.id===review)throw error;again=Boolean(panel&&ready&&!disposed);}
   }while(again&&panel);
  })().finally(()=>{refreshing=undefined;});
  return refreshing;
 }
 async function show(){
  if(disposed)return;
  if(panel){panel.reveal(vscode.ViewColumn.Beside,true);return refresh();}
  if(opening)return opening;
  opening=create().finally(()=>{opening=undefined;});return opening;
 }
 async function create(){
  const id=randomUUID();instance=id;ready=false;generation++;
  const local=new URL('viewer.html',await viewer.start());
  const address=(await vscode.env.asExternalUri(vscode.Uri.parse(local.href))).toString(),origin=new URL(address).origin;
  if(disposed)return;
  panel=vscode.window.createWebviewPanel('manuscriptReview.pdf','PDF: '+path.basename(runtime.review.repo),
   {viewColumn:vscode.ViewColumn.Beside,preserveFocus:true},{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.file(path.join(context.extensionPath,'dist'))]});
  const current=panel,script=panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath,'dist/pdf-panel.js')));
  panel.webview.html='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src '+panel.webview.cspSource+'; style-src \'unsafe-inline\'; frame-src '+origin+';"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}iframe{width:100%;height:100%;border:0}#status{padding:24px;font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}[hidden]{display:none}</style></head><body data-instance="'+id+'"><p id="status">Updating PDF…</p><iframe id="pdf" title="Manuscript PDF" hidden></iframe><script src="'+script+'"></script></body></html>';
  const subscriptions=[
   panel.webview.onDidReceiveMessage(async message=>{
    if(panel!==current||message?.instance!==id)return;
    try{
     if(message.type==='loaded')await post({type:'viewer',url:address});
     else if(message.type==='ready'){ready=true;await refresh();}
     else if(message.type==='rendered'&&message.document===documentKey)displayed=message.selection;
     else if(message.type==='key'&&reviewing){
      const action=keys.get(message.key?.toLowerCase());
      if(['accept','reject','reset'].includes(action)&&(message.selection!==displayed||message.selection!==selection?.token||selection?.revision!==runtime.review.revision))return;
      if(action)await onAction(action,message.ctrlKey?'file':message.shiftKey?'passage':'edit');
     }else if(message.type==='error'&&message.document===documentKey){displayed=undefined;await post({type:'status',text:message.error});onError(new Error(message.error));}
    }catch(error){onError(error);}
   }),
   panel.onDidChangeViewState(()=>{if(current.active)void onAction('focus').catch(onError);}),
   panel.onDidDispose(()=>{if(panel!==current)return;panel=undefined;ready=false;generation++;cached=documentKey=displayed=undefined;clearTimeout(timer);for(const item of subscriptions)item.dispose();})
  ];
 }
 return {show,refresh,select(file,edit,revision,removed=false){
   const review=runtime.review.id,token=review+'/'+revision+'/'+file+'/'+edit;
   selection=file?{file,edit,revision,removed,review,token}:undefined;return updateSelection();
  },
  reset(){generation++;cached=selection=documentKey=displayed=undefined;clearTimeout(timer);post({type:'status',text:'Updating PDF…'});},
  setMode(value){reviewing=value;void updateSelection()?.catch(onError);},get active(){return Boolean(panel?.active);},
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
