import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {commentThreads,reviewProgress} from '../../manuscript_review/review_model.js';

export function sidebarState(comparison,data,commentsEnabled,agent,highlights=true){
 const progress=data?reviewProgress(data.files,data.decisions):undefined;
 const unresolved=data?commentThreads(data,data.comments).filter(thread=>!thread.resolved).length:0;
 return {commentsEnabled,agent,highlights,folder:comparison?.info.workspace||comparison?.info.repo,
  from:comparison?.base.label,to:comparison?.proposed.label,entry:comparison?.entry||'Source only',
  fromVersion:comparison?.base.revision,toVersion:comparison?.proposed.revision,
  active:Boolean(data),review:data?.id,revision:data?.revision,pending:Boolean(comparison?.pending),
  progress:progress?.total?`${progress.done} of ${progress.total} reviewed`:'',
  canApply:Boolean(progress?.total&&progress.complete&&!data.applied&&!Object.keys(data.drafts).length),
  applied:Boolean(data?.applied),unresolved};
}

function html(vscode,webview,extensionPath){
 const nonce=randomUUID(),script=webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath,'dist/sidebar.js')));
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:16px 16px 20px;color:var(--vscode-foreground);font:var(--vscode-font-size)/1.5 var(--vscode-font-family)}
button,input{font:inherit}button{cursor:pointer;color:inherit;border:0;border-radius:3px;background:transparent}button:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
.folder{display:block;max-width:100%;padding:0;font-weight:600;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:14px}
.versions{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px 10px;align-items:center;margin-bottom:16px}.versions>span{color:var(--vscode-descriptionForeground)}.version{display:block;text-align:left;padding:5px 8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent)}.version:hover{border-color:var(--vscode-focusBorder)}
.actions{display:flex;gap:8px;flex-wrap:wrap}.primary{padding:5px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.primary:hover{background:var(--vscode-button-hoverBackground)}.secondary{padding:5px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
.progress{color:var(--vscode-descriptionForeground);margin:8px 0 0;font-size:11px}.comments{margin-top:24px}.toggle{display:flex;gap:7px;align-items:center}.toggle input{margin:0;accent-color:var(--vscode-button-background)}.discussion{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:var(--vscode-descriptionForeground)}.discussion button{padding:3px 6px}.discussion button:hover{background:var(--vscode-toolbar-hoverBackground)}.agent{display:inline-flex;align-items:center;gap:7px;padding:3px 0;text-align:left;color:var(--vscode-descriptionForeground);margin-top:9px}.error{color:var(--vscode-errorForeground);margin:14px 0 0}.empty{margin:0 0 16px;color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}
</style></head><body>
<button id="folder" class="folder" data-action="repository">Choose manuscript folder</button>
<p id="empty" class="empty">Open a manuscript folder to compare versions.</p>
<div id="comparison" hidden><div class="versions">
 <span>From</span><button id="from" class="version" aria-label="From" data-action="base"></button>
 <span>To</span><button id="to" class="version" aria-label="To" data-action="proposed"></button>
 <span>PDF</span><button id="entry" class="version" aria-label="PDF" data-action="entry"></button>
</div><div class="actions"><button id="review" class="primary" data-action="review">Review changes</button><button id="apply" class="secondary" data-action="apply" hidden>Apply review</button></div><p id="progress" class="progress" hidden></p></div>
<div class="comments"><label class="toggle"><input id="highlights" type="checkbox" checked>Review highlights</label>
 <label class="toggle"><input id="comments" type="checkbox" checked>Source comments</label>
 <div id="discussion" class="discussion" hidden><span id="unresolved"></span><div><button data-action="previous" aria-label="Previous comment">Previous</button><button data-action="next" aria-label="Next comment">Next</button></div></div>
 <button id="agent" class="agent" data-action="agent"><span id="agent-label">Codex</span><svg width="9" height="5" viewBox="0 0 9 5" aria-hidden="true"><path d="m1 .5 3.5 3.5L8 .5" fill="none" stroke="currentColor"/></svg></button>
</div><p id="error" class="error" role="alert" hidden></p><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

export function createSidebar(vscode,context,{load,onAction,onError}){
 let view,generation=0,disposed=false,busy=false;
 const actions=new Set(['repository','base','proposed','entry','review','apply','previous','next','agent','comments','highlights']);
 const subscriptions=[vscode.window.registerWebviewViewProvider('manuscriptReview.start',{
  resolveWebviewView(next){
   view=next;next.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.file(path.join(context.extensionPath,'dist'))]};
   next.webview.html=html(vscode,next.webview,context.extensionPath);
   subscriptions.push(next.onDidDispose(()=>{if(view===next){view=undefined;generation++;}}),
    next.onDidChangeVisibility(()=>{if(next.visible)void refresh();}),
    next.webview.onDidReceiveMessage(async message=>{
     if(disposed||view!==next)return;
     if(message?.action==='ready')return refresh();
     if(busy||!actions.has(message?.action))return;
     busy=true;await next.webview.postMessage({type:'busy',busy:true});
     try{await onAction(message.action,{review:message.review,revision:message.revision,folder:message.folder,fromVersion:message.fromVersion,toVersion:message.toVersion,entry:message.entry});await refresh();}
     catch(error){await refresh();await next.webview.postMessage({type:'error',message:error.message});onError(error);}
     finally{busy=false;if(view===next)await next.webview.postMessage({type:'busy',busy:false});}
    }));
  }
 })];
 async function refresh(){
  if(disposed||!view?.visible)return;
  const target=view,ticket=++generation;
  try{const state=await load();if(!disposed&&view===target&&ticket===generation)await target.webview.postMessage({type:'state',state});}
  catch(error){if(!disposed&&view===target&&ticket===generation)await target.webview.postMessage({type:'error',message:error.message});onError(error);}
 }
 return {refresh,show:()=>vscode.commands.executeCommand('manuscriptReview.start.focus'),dispose(){disposed=true;generation++;for(const item of subscriptions)item.dispose();}};
}
