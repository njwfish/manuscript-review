import {readFile} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {sourceFile} from './comments.mjs';

const theme=`
body.vscode-review{
 --bg:var(--vscode-sideBar-background);--paper:var(--vscode-editor-background);
 --panel:var(--vscode-editor-background);--control:var(--vscode-button-secondaryBackground);
 --field:var(--vscode-input-background);--ink:var(--vscode-editor-foreground);
 --muted:var(--vscode-descriptionForeground);--faint:var(--vscode-descriptionForeground);
 --line:var(--vscode-panel-border);--accent:var(--vscode-focusBorder);
 --del:var(--vscode-gitDecoration-deletedResourceForeground,#b0303f);
 --delbg:var(--vscode-diffEditor-removedTextBackground,#f9edee);
 --ins:var(--vscode-gitDecoration-addedResourceForeground,#1e7a47);
 --insbg:var(--vscode-diffEditor-insertedTextBackground,#eaf5ed);
 --notice:var(--vscode-inputValidation-warningBackground);
 --toolbar:var(--vscode-editor-background);--bar:var(--vscode-editor-background);
 --mono:var(--vscode-editor-font-family,ui-monospace,monospace);
 --header-h:36px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);
 --hover:var(--vscode-list-hoverBackground);--selection:var(--vscode-editor-selectionBackground);
 --shadow:none;
}
.vscode-review button,.vscode-review select{border-radius:4px}
.vscode-review .primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.vscode-review .primary:hover{background:var(--vscode-button-hoverBackground)}
.vscode-review #manuscript-title{display:none}
.vscode-review #progress{min-width:0;overflow:hidden;text-overflow:ellipsis}
.vscode-review main{padding:20px 24px 16px}
.vscode-review .passage-body,.vscode-review .passage-body.code,.vscode-review .exact-edit,.vscode-review #preview{font-size:var(--vscode-editor-font-size,14px);line-height:1.65}
.vscode-review .passage-body.code{background:transparent;padding:0;border-radius:0}
.vscode-review .active-edit{outline-width:1px;outline-offset:2px}
.vscode-review .focused-source{padding-block:clamp(24px,8vh,72px)}
.vscode-review .agent-choice{color:var(--muted);padding-inline:0}
.vscode-review .agent-choice::after{content:'';display:inline-block;width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(45deg);vertical-align:3px;margin-left:8px}
.vscode-review .contextbar{flex-wrap:wrap;row-gap:8px}
.vscode-review .context{flex:1 1 160px}
.vscode-review .decisionbar{flex-wrap:wrap;backdrop-filter:none}
.vscode-review .key{border:0;margin-left:6px;padding:0}
.vscode-review #library,.vscode-review #hide-files,.vscode-review #draft-status,
 .vscode-review #copy-request-header,.vscode-review #copy-request-feedback,
.vscode-review [data-standalone]{display:none}
.vscode-review .review-summary{padding-block:10px}
.vscode-review header{backdrop-filter:none}
.vscode-review #round-state{cursor:pointer}
.vscode-review #comparison-versions{max-width:100%;padding:7px 24px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:12px;border-radius:0;border-bottom:1px solid var(--line)}
.vscode-review #comparison-versions:hover{color:var(--ink);background:var(--hover)}
.vscode-review .pdf-viewer{display:block;width:100%;height:100%;min-height:240px;border:1px solid var(--line);border-radius:6px}
.vscode-review.pdf-review{height:100vh;display:flex;flex-direction:column}
.vscode-review.pdf-review header,.vscode-review.pdf-review #comparison-versions,.vscode-review.pdf-review .review-summary,.vscode-review.pdf-review .review-notice{flex-shrink:0}
.vscode-review.pdf-review .shell{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
.vscode-review.pdf-review main{display:flex;flex-direction:column;height:100%;min-height:0;max-width:none;align-self:stretch;overflow:auto;padding:16px 20px 0}
.vscode-review.pdf-review .contextbar{flex-shrink:0}
.vscode-review.pdf-review .selected-passage{display:flex;flex-direction:column;flex:1;min-height:240px}
.vscode-review.pdf-review .pdf-pair{flex:1;min-height:0}
.vscode-review.pdf-review .typeset-pane{display:flex;flex-direction:column;min-height:0}
.vscode-review.pdf-review .typeset-pane figcaption{flex-shrink:0}
.vscode-review.pdf-review .pdf-viewer{flex:1;min-height:0}
.vscode-review.pdf-review .selected-change{flex-shrink:0}
.vscode-review.pdf-review .decisionbar{flex-shrink:0;flex-wrap:wrap;margin-top:12px;backdrop-filter:none}
.vscode-review.pdf-review .statusline{margin:0 0 0 auto;min-height:0;white-space:nowrap}
.vscode-review.pdf-review .selected-change{max-height:96px;overflow:auto}
.vscode-review.pdf-review .decision-state{display:none}
.vscode-review.pdf-review #discussion{height:100%;top:0}
@media(max-width:650px){.vscode-review.pdf-review .pdf-pair{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}
`;

export function webviewHTML(html,webview,assets,vscode,viewerOrigin){
 const uri=file=>webview.asWebviewUri(vscode.Uri.file(path.join(assets,file))).toString();
 const csp=`default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; frame-src ${viewerOrigin};`;
 return html.replace('<head>','<head>\n<meta http-equiv="Content-Security-Policy" content="'+csp+'">')
  .replace(/<body(?:\s[^>]*)?>/,'<body class="vscode-review wide">')
  .replace('</style>',theme+'\n</style>')
  .replace('src="/app.js"','src="'+uri('app.js')+'"');
}

export function createPanel(vscode,context,runtime,{viewer,onSource,onFocus,onAgent,onChange,onApply,onCommand,onHidden,agentLauncher,agentLabel}){
 let panel,page,selection;
 const assets=path.join(context.extensionPath,'dist','runtime','manuscript_review');
 const current=(origin,load)=>origin===panel&&load===page;
 const post=(message)=>panel?.webview.postMessage({...message,instance:page.id});
 function changed(value=runtime.review.revision){
  if(!panel||!Number.isInteger(value)||value<=(page.revision??-1))return;
  if(page.pending||!page.ready){page.changedRevision=Math.max(value,page.changedRevision??-1);return;}
  post({type:'review-changed'});
 }
 function reconcile(){const value=page.changedRevision;page.changedRevision=undefined;if(value!==undefined)changed(value);}
 function select(){if(selection?.review!==runtime.review.id)selection=undefined;if(selection){const {file,target,id}=selection;post({type:'review-select',file,target:target.id,...(id?{note:id}:{}),...(selection.source?{source:true}:{}),...(target.kind?{kind:target.kind}:{})});selection=undefined;}}
 function release(load,error){
  load?.reject(error);load?.lock?.release();if(load)load.lock=undefined;
  for(const request of load?.waiting.values()||[]){clearTimeout(request.timer);request.reject(error);}
  load?.waiting.clear();
 }
 function unlock(id){
  if(!id||page?.lock?.id!==id)return;
  post({type:'review-command',action:'unlock',id});
  const held=page.lock;page.lock=undefined;held.release();
 }
 function flush({lock=false}={}){
  const origin=panel,load=page;if(!origin)return Promise.resolve();
  const run=async()=>{
   await load.loaded;
   if(load.lock)await load.lock.gate;
   if(!current(origin,load))throw new Error('The focused review changed.');
   const id=crypto.randomUUID();
   if(lock){const held={id};held.gate=new Promise(resolve=>held.release=resolve);load.lock=held;}
   try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{load.waiting.delete(id);reject(new Error('The focused review did not finish saving.'));},30000);load.waiting.set(id,{resolve,reject,timer});post({type:'review-command',action:'flush',id,...(lock?{lock:true}:{})});});}
   catch(error){if(lock&&current(origin,load))unlock(id);throw error;}
   return lock?id:undefined;
  };
  load.flushing=load.flushing.catch(()=>{}).then(run);
  return load.flushing;
 }
 async function handle(origin,message){
  const load=page;
  if(origin!==panel||message?.instance!==load.id)return;
  if(message.type==='review-ready'){
   if(message.error)load.reject(new Error(message.error));else{load.ready=true;load.resolve();select();reconcile();}return;
  }
  if(message.type==='review-flushed'){
   const request=load.waiting.get(message.id);if(!request)return;clearTimeout(request.timer);load.waiting.delete(message.id);
   message.ok?request.resolve():request.reject(new Error(message.error));return;
  }
  if(message.type!=='review-request'||typeof message.id!=='string')return;
  let result;
  try{
   const actions={
    request:async()=>{
     load.pending++;
     try{const data=await (message.path==='/apply'?onApply(message.body):runtime.request(message.path,message.body));if(message.path.startsWith('/data')){data.agent_launcher=agentLauncher;data.agent_label=agentLabel?.();data.interface='vscode';}if(current(origin,load))load.revision=Math.max(load.revision??-1,data.data?.revision??data.revision??-1);if(message.body)onChange();return {status:200,data};}
     catch(error){return {status:error.status||500,data:{error:error.message,stale:Boolean(error.stale)}};}
     finally{if(!--load.pending&&current(origin,load))reconcile();}
    },
    source:()=>onSource(message),
    focus:()=>onFocus?.(message.file,message.edit),
    agent:()=>{if(message.review!==runtime.review.id)throw new Error('The review changed. Send the comment from its original round.');return onAgent?.(message.comment);},
    command:()=>onCommand(message.name),
    asset:async()=>{const {bytes,mime}=await runtime.asset(message.path);return `data:${mime.split(';')[0]};base64,${bytes.toString('base64')}`;},
    viewer:()=>load.viewerURL,
    copy:async()=>{if(typeof message.text!=='string')throw new Error('Invalid clipboard text.');await vscode.env.clipboard.writeText(message.text);},
    export:async()=>{const {bytes}=await runtime.download(message.path);const uri=await vscode.window.showSaveDialog({saveLabel:'Export',defaultUri:vscode.Uri.file(path.join(runtime.review.repo,message.path.startsWith('/feedback')?'manuscript-feedback.json':'manuscript-selected.patch'))});if(uri)await vscode.workspace.fs.writeFile(uri,bytes);}
   };
   if(!Object.hasOwn(actions,message.action))throw new Error('Unknown review action.');
   result={type:'review-response',instance:load.id,id:message.id,ok:true,data:await actions[message.action]()};
  }catch(error){result={type:'review-response',instance:load.id,id:message.id,ok:false,error:error.message};}
  if(current(origin,load))origin.webview.postMessage(result);
 }
 async function load(origin,focus=true){
  release(page,new Error('The focused review reloaded.'));
  const next={id:crypto.randomUUID(),waiting:new Map(),pending:0,ready:false,flushing:Promise.resolve()};
  next.loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The focused review did not load.')),30000);next.resolve=()=>{clearTimeout(timer);resolve();};next.reject=error=>{clearTimeout(timer);reject(error);};});next.loaded.catch(()=>{});
  page=next;
  const address=await vscode.env.asExternalUri(vscode.Uri.parse(await viewer.start()));
  const base=address.toString().replace(/\/?$/,'/');
  next.viewerURL=new URL('viewer.html',base).href;
  const html=await readFile(path.join(assets,'index.html'),'utf8');
  if(!current(origin,next))return;
  origin.webview.html=webviewHTML(html,origin.webview,assets,vscode,new URL(next.viewerURL).origin)
   .replace('<body class="vscode-review wide">','<body class="vscode-review wide" data-review-instance="'+next.id+'" data-review-focus="'+focus+'">');
 }
 async function show(entry){
  if(entry?.target)selection={...entry,review:runtime.review.id};
  if(!panel){
   const source=[vscode.window.activeTextEditor,...(vscode.window.visibleTextEditors||[])].find(editor=>editor?.viewColumn&&sourceFile(runtime.review,editor.document));
   const column=source?source.viewColumn+1:vscode.ViewColumn.Beside;
   panel=vscode.window.createWebviewPanel('manuscriptReview.focus','Review: '+path.basename(runtime.review.repo),column,{enableScripts:true,localResourceRoots:[vscode.Uri.file(assets)],retainContextWhenHidden:true});
   panel.iconPath=vscode.Uri.file(path.join(context.extensionPath,'dist','review.svg'));
   const origin=panel;
   panel.webview.onDidReceiveMessage(message=>handle(origin,message));
   panel.onDidChangeViewState?.(()=>{if(origin===panel&&!origin.visible)onHidden?.();});
   panel.onDidDispose(()=>{if(panel!==origin)return;panel=undefined;release(page,new Error('The focused review closed.'));page=undefined;onHidden?.();});
   await load(origin);
  }else{panel.reveal();await page.loaded;select();}
 }
 return {show,flush,select:entry=>{selection={...entry,review:runtime.review.id,source:true};if(page?.ready)select();},get visible(){return Boolean(panel?.visible);},unlock,
  setAgent:label=>post({type:'review-agent',label}),changed,
  refresh:async({flushed=false}={})=>{if(!panel)return;if(!flushed)await flush();await load(panel,false);},
  dispose:()=>{selection=undefined;panel?.dispose();}
 };
}
