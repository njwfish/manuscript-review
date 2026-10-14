import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {commentThreads,reviewProgress} from '../../manuscript_review/review_model.js';

export function sidebarState(comparison,data,commentsEnabled,agent,highlights=true,model='CLI default',removals=true,intent='author'){
 const progress=data?.progress||(data?reviewProgress(data.files,data.decisions):undefined);
 const unresolved=data?.unresolved??(data?commentThreads(data,data.comments).filter(thread=>!thread.resolved).length:0);
 return {commentsEnabled,agent,highlights,model,removals,editing:data?.authoring?intent:'proposal',authoring:Boolean(data?.authoring),folder:comparison?.info.workspace||comparison?.info.repo,
  from:comparison?.base.label,to:comparison?.proposed.label,entry:comparison?.entry||'Source only',
  fromVersion:comparison?.base.revision,toVersion:comparison?.proposed.revision,
  active:Boolean(data),review:data?.id,revision:data?.revision,pending:Boolean(comparison?.pending),
  progress:data?.delivery_conflicts?.length?'Review overlapping edits before applying':progress?.total?`${progress.done} of ${progress.total} reviewed`:'',
  canApply:Boolean(progress?.total&&progress.complete&&!data.applied&&!Object.keys(data.drafts).length),
  applied:Boolean(data?.applied),unresolved};
}

function html(vscode,webview,extensionPath){
 const nonce=randomUUID();
 const asset=file=>webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath,'dist',file)));
 const icon=(label,action,points)=>`<button class="icon" data-action="${action}" title="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${points}"/></svg></button>`;
 return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('sidebar.css')}"></head><body>
<div id="setup">
 <button id="folder" class="folder" data-action="repository">Choose manuscript folder</button>
 <p id="empty" class="empty">Open a manuscript folder to compare versions.</p>
 <div id="comparison" hidden>
  <div class="versions">
   <span>From</span><button id="from" class="version" aria-label="From" data-action="base"></button>
   <span>To</span><button id="to" class="version" aria-label="To" data-action="proposed"></button>
   <span>PDF</span><button id="entry" class="version" aria-label="PDF" data-action="entry"></button>
  </div>
  <div class="actions">
   <button id="review" class="primary" data-action="review">Review</button>
   <button id="pdf" class="secondary" data-action="pdf" title="Open PDF beside source">PDF beside source</button>
   <button class="secondary" data-action="agentChanges" title="Compare your saved draft to accumulated agent changes">Agent changes</button>
   <button id="apply" class="primary" data-action="apply" hidden>Apply review</button>
  </div>
  <p id="progress" class="progress" hidden></p>
 </div>
 <div id="discussion" class="discussion section" hidden>
  <span>Comments</span><span id="unresolved" class="muted"></span>
  ${icon('Previous comment','previous','M10 3 5 8l5 5')}
  ${icon('Next comment','next','m6 3 5 5-5 5')}
 </div>
 <div class="section">
  <label class="toggle"><input id="highlights" type="checkbox" checked>Review highlights</label>
  <details class="preferences"><summary>Display options</summary>
   <label class="toggle"><input id="removals" type="checkbox" checked>Original on focus</label>
   <label class="toggle"><input id="comments" type="checkbox" checked>Source comments</label>
  </details>
 </div>
 <div id="editing-row" class="versions section" hidden><span>Edit</span><button id="editing" class="version" data-action="editing"></button></div>
 <div class="versions agent">
  <span>Agent</span><button id="agent" class="version" data-action="agent"><span id="agent-label">Codex</span></button>
  <span>Model</span><button id="model" class="version" data-action="model">CLI default</button>
 </div>
 <button class="sessions" data-action="sessions">Agent sessions</button>
</div>
<section id="composer" hidden aria-label="Comment">
 <header class="composer-head">
  ${icon('Close comment (Escape)','commentClose','M13 8H3m5-5L3 8l5 5')}
  <span id="comment-location" class="location spacer"></span>
  <button id="comment-resolve" class="icon" data-action="commentResolve" title="Resolve comment" aria-label="Resolve comment"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg></button>
 </header>
 <div id="comment-history"></div>
 <textarea id="comment-input" rows="2" placeholder="Comment…" aria-label="Comment" spellcheck="false"></textarea>
 <div class="composer-actions">
  <button id="comment-agent" class="provider" data-action="agent" title="Choose agent"></button>
  <button id="comment-model" class="provider" data-action="model" title="Choose model"></button>
  <span class="spacer"></span>
  <button id="comment-save" class="secondary" data-action="commentSave" title="Save without sending (⌘/Ctrl+Enter)">Save</button>
  <button id="comment-send" class="primary" data-action="commentSend" title="Enter sends; Shift+Enter adds a line">Send</button>
 </div>
</section>
<p id="error" class="error" role="alert" hidden></p>
<script nonce="${nonce}" src="${asset('sidebar.js')}"></script></body></html>`;
}

export function createSidebar(vscode,context,{load,onAction,onError}){
 let view,generation=0,disposed=false,busy=false;
 const actions=new Set(['repository','base','proposed','entry','review','apply','previous','next','agent','model','sessions','agentChanges','comments','highlights','removals','editing','pdf','commentDraft','commentSave','commentSend','commentClose','commentResolve']);
 const subscriptions=[vscode.window.registerWebviewViewProvider('manuscriptReview.start',{
  resolveWebviewView(next){
   view=next;next.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.file(path.join(context.extensionPath,'dist'))]};
   next.webview.html=html(vscode,next.webview,context.extensionPath);
   subscriptions.push(next.onDidDispose(()=>{if(view===next){view=undefined;generation++;}}),
    next.onDidChangeVisibility(()=>{if(next.visible)void refresh();}),
    next.webview.onDidReceiveMessage(async message=>{
     if(disposed||view!==next)return;
     if(message?.action==='ready')return refresh();
     if(!actions.has(message?.action))return;
     if(message.action==='commentDraft'){
      try{await onAction(message.action,{input:message.input,text:message.text});}
      catch(error){await next.webview.postMessage({type:'error',message:error.message});onError(error);}
      return;
     }
     if(busy)return;
     busy=true;await next.webview.postMessage({type:'busy',busy:true});
     try{await onAction(message.action,{review:message.review,revision:message.revision,folder:message.folder,fromVersion:message.fromVersion,toVersion:message.toVersion,entry:message.entry,input:message.input,text:message.text});await refresh();}
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
