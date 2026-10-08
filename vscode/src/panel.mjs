import {readFile} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const theme=`
body.vscode-review{
 --bg:var(--vscode-sideBar-background);--paper:var(--vscode-editor-background);
 --panel:var(--vscode-editor-background);--control:var(--vscode-button-secondaryBackground);
 --field:var(--vscode-input-background);--ink:var(--vscode-editor-foreground);
 --muted:var(--vscode-descriptionForeground);--faint:var(--vscode-descriptionForeground);
 --line:var(--vscode-panel-border);--accent:var(--vscode-focusBorder);
 --toolbar:var(--vscode-editor-background);--bar:var(--vscode-editor-background);
 --mono:var(--vscode-editor-font-family,ui-monospace,monospace);font-family:var(--vscode-font-family);
 --hover:var(--vscode-list-hoverBackground);--selection:var(--vscode-editor-selectionBackground);
 --shadow:none;
}
.vscode-review.vscode-light{--del:#b0303f;--delbg:#f9edee;--ins:#1e7a47;--insbg:#eaf5ed;--notice:#fdf4dc}
.vscode-review.vscode-dark,.vscode-review.vscode-high-contrast{--del:#ff8fa0;--delbg:#46262c;--ins:#86dba5;--insbg:#20392b;--notice:#3d3420}
.vscode-review #library,.vscode-review #hide-files,.vscode-review #draft-status,
.vscode-review #apply,.vscode-review #finish-review,.vscode-review #handoff-hint{display:none}
.vscode-review .review-summary{padding-block:10px}
.vscode-review header{backdrop-filter:none}
.vscode-review .pdf-viewer{width:100%;height:calc(100vh - 235px);min-height:420px;border:0}
`;

export function webviewHTML(html,webview,assets,vscode){
 const uri=file=>webview.asWebviewUri(vscode.Uri.file(path.join(assets,file))).toString();
 const csp=`default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; frame-src ${webview.cspSource};`;
 return html.replace('<head>','<head>\n<meta http-equiv="Content-Security-Policy" content="'+csp+'">')
  .replace('<body>','<body class="vscode-review wide">')
  .replace('</style>',theme+'\n</style>')
  .replace('src="/app.js"','src="'+uri('app.js')+'"');
}

export function createPanel(vscode,context,runtime,{onSource,onChange}){
 let panel,waiting=new Map(),loaded,resolveLoaded,rejectLoaded,selection,revision,pending=0,changedRevision,ready=false;
 const assets=path.join(context.extensionPath,'dist','runtime','manuscript_review');
 const viewer=path.join(context.extensionPath,'dist','viewer');
 function changed(value=runtime.review.revision){
  if(!panel||!Number.isInteger(value)||value<=(revision??-1))return;
  if(pending||!ready){changedRevision=Math.max(value,changedRevision??-1);return;}
  panel.webview.postMessage({type:'review-changed'});
 }
 function reconcile(){const value=changedRevision;changedRevision=undefined;if(value!==undefined)changed(value);}
 function select(){if(selection){const {file,target,id}=selection;panel?.webview.postMessage({type:'review-select',file,target:target.id,...(id?{note:id}:{}),...(target.kind?{kind:target.kind}:{})});selection=undefined;}}
 const acknowledge=(message)=>{const request=waiting.get(message.id);if(!request)return;clearTimeout(request.timer);waiting.delete(message.id);message.ok?request.resolve():request.reject(new Error(message.error));};
 async function flush(){
  const origin=panel;if(!origin)return;
  await loaded;
  if(origin!==panel)throw new Error('The focused review closed.');
  const id=crypto.randomUUID();
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('The focused review did not finish saving.'));},30000);waiting.set(id,{resolve,reject,timer});origin.webview.postMessage({type:'review-command',action:'flush',id});});
 }
 async function handle(origin,message){
  if(origin!==panel)return;
  if(message?.type==='review-ready'){
   if(message.error)rejectLoaded(new Error(message.error));else{ready=true;resolveLoaded();select();reconcile();}return;
  }
  if(message?.type==='review-flushed'){acknowledge(message);return;}
  if(message?.type!=='review-request'||typeof message.id!=='string')return;
  let result;
  try{
   const actions={
    request:async()=>{
     pending++;
     try{const data=await runtime.request(message.path,message.body);if(origin===panel)revision=Math.max(revision??-1,data.data?.revision??data.revision??-1);if(message.body)onChange();return {status:200,data};}
     catch(error){return {status:error.status||500,data:{error:error.message,stale:Boolean(error.stale)}};}
     finally{if(!--pending)reconcile();}
    },
    source:()=>onSource(message),
    asset:async()=>{const {bytes,mime}=await runtime.asset(message.path);return `data:${mime.split(';')[0]};base64,${bytes.toString('base64')}`;},
    viewer:()=>origin.webview.asWebviewUri(vscode.Uri.file(path.join(viewer,'viewer.html'))).toString(),
    copy:async()=>{if(typeof message.text!=='string')throw new Error('Invalid clipboard text.');await vscode.env.clipboard.writeText(message.text);},
    export:async()=>{const {bytes}=await runtime.download(message.path);const uri=await vscode.window.showSaveDialog({saveLabel:'Export',defaultUri:vscode.Uri.file(path.join(runtime.review.repo,message.path.startsWith('/feedback')?'manuscript-feedback.json':'manuscript-selected.patch'))});if(uri)await vscode.workspace.fs.writeFile(uri,bytes);}
   };
   if(!Object.hasOwn(actions,message.action))throw new Error('Unknown review action.');
   result={type:'review-response',id:message.id,ok:true,data:await actions[message.action]()};
  }catch(error){result={type:'review-response',id:message.id,ok:false,error:error.message};}
  if(origin===panel)origin.webview.postMessage(result);
 }
 async function load(origin){
  loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The focused review did not load.')),30000);resolveLoaded=()=>{clearTimeout(timer);resolve();};rejectLoaded=error=>{clearTimeout(timer);reject(error);};});loaded.catch(()=>{});
  revision=undefined;ready=false;
  origin.webview.html=webviewHTML(await readFile(path.join(assets,'index.html'),'utf8'),origin.webview,assets,vscode);
 }
 async function show(entry){
  if(entry?.target)selection=entry;
  if(!panel){
   panel=vscode.window.createWebviewPanel('manuscriptReview.focus','Focused review',vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[vscode.Uri.file(assets),vscode.Uri.file(viewer)],retainContextWhenHidden:true});
   const origin=panel;
   panel.webview.onDidReceiveMessage(message=>handle(origin,message));
   panel.onDidDispose(()=>{if(panel!==origin)return;panel=undefined;rejectLoaded?.(new Error('The focused review closed.'));for(const request of waiting.values()){clearTimeout(request.timer);request.reject(new Error('The focused review closed.'));}waiting.clear();});
   await load(origin);
  }else{panel.reveal();await loaded;select();}
 }
 return {show,flush,
  changed,
  refresh:async()=>{if(!panel)return;await flush();await load(panel);},
  dispose:()=>{panel?.dispose();}
 };
}
