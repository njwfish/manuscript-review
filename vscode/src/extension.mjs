import * as vscode from 'vscode';
import path from 'node:path';
import {createRuntime} from './runtime.mjs';
import {createComments,sourceFile,sourceDocument} from './comments.mjs';
import {createSourceEdits} from './source-edits.mjs';
import {createDelivery} from './delivery.mjs';
import {createSourceDocuments,sourceScheme,snapshotVersion} from './source-documents.mjs';
import {createPDFPanel,followWorkshopPDF} from './pdf-panel.mjs';
import {createNativeReview} from './native-review.mjs';
import {createDecorations} from './decorations.mjs';
import {createAgentTools} from './agent.mjs';
import {resolvePython} from './python.mjs';
import {createViewer} from './viewer-server.mjs';
import {agents} from './dispatch.mjs';
import {comparisonState,reviewComparison,refreshComparison,comparisonMatches,changeComparison,comparisonRequest} from './comparison.mjs';
import {createSidebar,sidebarState} from './sidebar.mjs';
import {manuscriptReviews} from '../../manuscript_review/review_model.js';

let disposeExtension;
export function activate(context){
 const output=vscode.window.createOutputChannel('Manuscript Review');
 const decorations=createDecorations(vscode);
 let runtime,pdf,sourceEdits,delivery,watcher,timer,opening,navigation,agentTools,viewer,starting,disposing,comparison,disposed=false,sending=false;
 let comparisonEpoch=0,inspection;
 function setComparison(value){comparison=value;comparisonEpoch++;if(value?.pending){decorations.clear();nativeReview.clear();}}
 const commentsEnabled=()=>context.globalState.get('commentsEnabled',true);
 const highlightsEnabled=()=>context.workspaceState.get('highlightsEnabled',false);
 const editingIntent=()=>context.workspaceState.get('editingIntent','author');
 const removalsEnabled=()=>context.workspaceState.get('removalsEnabled',true);
 const reviewedEnabled=()=>context.workspaceState.get('reviewedEnabled',false);
 decorations.setReviewed(reviewedEnabled());
 decorations.setEnabled(highlightsEnabled());
 const nativeReview=createNativeReview(vscode,{runtime:()=>runtime,sourceEdits:()=>sourceEdits,delivery:()=>delivery,enabled:()=>highlightsEnabled()&&!comparison?.pending,
  onOpen:openSource,isPDFActive:()=>pdf?.active,onComment:async selected=>{
   await vscode.commands.executeCommand('editor.action.hideHover');
   await vscode.window.showTextDocument(selected.editor.document,{viewColumn:selected.editor.viewColumn,preserveFocus:false});
   await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
   return comments.discuss(selected);
  },
  onMode:value=>{void vscode.commands.executeCommand('setContext','manuscriptReview.focused',value);pdf?.setMode(value);if(!value)decorations.reveal();},
  onChange:refreshSource,onFocus:(file,edit,selected,focused)=>{
   if(focused)decorations.focus(file,edit);else decorations.reveal();
   if(focused&&removalsEnabled()&&selected?.data.files.find(item=>item.path===file)?.edits.find(item=>item.id===edit)?.old)
    void vscode.commands.executeCommand('editor.action.showHover',{focus:'noAutoFocus'}).catch(fail);
   void pdf?.select(file,edit,selected?.data.revision,selected?.span.rejected,['accept','reject'].includes(selected?.data.decisions?.[edit])).catch(fail);
   if(!pdf?.visible)void followWorkshopPDF(vscode,selected).catch(error=>output.appendLine(error.message));
  },onError:error=>void fail(error)});
 const canComment=document=>commentsEnabled()&&vscode.workspace.isTrusted&&(sourceDocument(document)||document?.uri.scheme===sourceScheme&&sourceFile(runtime?.review,document));
 const selectedAgent=()=>{const agent=agents.find(agent=>agent.id===context.globalState.get('commentAgent'))||agents[0];return {...agent,model:context.globalState.get('commentModels',{})[agent.id]};};
 async function chooseAgent(){
  const current=selectedAgent(),options=[current,...agents.filter(agent=>agent.id!==current.id)];
  const agent=await vscode.window.showQuickPick(options,{title:'Comment agent',placeHolder:'Enter sends to this agent'});
  if(agent){await context.globalState.update('commentAgent',agent.id);await sidebar.refresh();}
  return selectedAgent().label;
 }
 async function chooseModel(){
  await start();
  const agent=selectedAgent(),data=await runtime.library('/agent-models',{agent:agent.id});
  const choices=[{label:'CLI default',id:undefined,description:'Use your '+agent.label+' settings'},
   ...data.models.map(model=>({...model,description:model.id})),{label:'Enter model name…',custom:true}];
  const choice=await vscode.window.showQuickPick(choices,{title:agent.label+' model',placeHolder:agent.model||'CLI default',matchOnDescription:true});
  if(!choice)return;
  const model=choice.custom?await vscode.window.showInputBox({title:agent.label+' model',value:agent.model||'',prompt:'Model name accepted by the installed CLI',validateInput:value=>/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)?undefined:'Enter a model name.'}):choice.id;
  if(choice.custom&&model===undefined)return;
  await context.globalState.update('commentModels',{...context.globalState.get('commentModels',{}),[agent.id]:model});
  await sidebar.refresh();
 }
 async function chooseEditing(){
  const choice=await vscode.window.showQuickPick([
   {label:'Your draft',intent:'author',description:'Your saves update the author side; agent changes remain reviewable'},
   {label:'Proposal',intent:'proposal',description:'Your saves refine proposed wording; From stays fixed'}
  ],{title:'Edit manuscript',placeHolder:editingIntent()==='author'?'Your draft':'Proposal'});
  if(choice)await context.workspaceState.update('editingIntent',choice.intent);
 }
 async function openAgentSession(){
  if(!await ensureReview())return;
  const {runs}=await runtime.request('/agents',{});
  if(!runs.length){await vscode.window.showInformationMessage('No agents dispatched from this review.');return;}
  const run=await vscode.window.showQuickPick(runs.map(run=>({label:run.title,description:agents.find(agent=>agent.id===run.agent)?.label+'  '+(run.model||'CLI default'),detail:run.status+'  '+run.created,run})),{title:'Agent sessions'});
  if(!run)return;
  const item=run.run;
  const actions=[...(item.session?[{label:'Open in terminal',action:'terminal'},{label:'Open in '+(item.agent==='codex'?'Codex':'Claude Desktop'),action:'desktop'}]:[]),{label:'View launch log',action:'log'}];
  const action=await vscode.window.showQuickPick(actions,{title:run.label});if(!action)return;
  if(action.action==='log')return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(item.log)),{viewColumn:vscode.ViewColumn.Beside});
  if(item.agent==='codex'&&action.action==='desktop')return vscode.env.openExternal(vscode.Uri.parse('codex://threads/'+item.session));
  const args=item.agent==='codex'?['resume',item.session]:action.action==='desktop'?['--desktop','--resume',item.session]:item.job?['attach',item.job]:['--resume',item.session];
  const terminal=vscode.window.createTerminal({name:agents.find(agent=>agent.id===item.agent).label,cwd:item.repo,shellPath:item.agent,shellArgs:args});
  terminal.show();
 }
 async function showAgentChanges(){
  const intended=runtime?.review?.id;
  if(!await ensureReview())return;
  if(intended&&runtime.review.id!==intended)throw new Error('The review changed. Choose Agent changes from its original review.');
  const epoch=comparisonEpoch,reviewId=runtime.review.id,entry=sourceFile(runtime.review,vscode.window.activeTextEditor?.document);
  await sourceEdits.flush();
  if(runtime.review?.id!==reviewId)throw new Error('The review changed. Choose Agent changes from its original review.');
  await runtime.request('/authoring',{entry});if(epoch===comparisonEpoch)setComparison(undefined);
  await context.workspaceState.update('editingIntent','proposal');
  await setHighlights(true);
  await delivery.refresh();await refreshSource();
 }
 const sources=createSourceDocuments(vscode,async()=>{await start();return runtime;});
 const subscriptions=[output,sources,nativeReview];
 const comments=createComments(vscode,()=>runtime,{onSource:ensureCommentSource,canComment,
  onInput:async(thread,document)=>{if(thread){nativeReview.holdComment(thread,document);await sidebar.show();}await sidebar.refresh();},
  onInputComplete:(thread,complete)=>nativeReview.finishComment(thread,async owns=>{
   if(!complete()||!owns())return false;
   await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
   return complete();
  }),
  openDocument:sources.open,
  onChange:async()=>{await sidebar.refresh();},onReview:entry=>showReview(entry),
  onProjection:(projection,data)=>{if(!comparison?.pending){decorations.update(projection,data);nativeReview.update(projection,data);}},onAgent:sendToAgent});comments.setEnabled(commentsEnabled());
 const sidebar=createSidebar(vscode,context,{load:loadSidebar,onAction:sidebarAction,onError:error=>output.appendLine(error.stack||error.message)});
 subscriptions.push(sidebar);
 function updateSourceContext(){
  const document=vscode.window.activeTextEditor?.document;
  const source=sourceDocument(document)||(document?.uri.scheme===sourceScheme&&sourceFile(runtime?.review,document));
  void vscode.commands.executeCommand('setContext','manuscriptReview.source',Boolean(vscode.workspace.isTrusted&&source));
  void vscode.commands.executeCommand('setContext','manuscriptReview.commentsEnabled',commentsEnabled());
 }
 async function discardUnopenedRuntime(){if(runtime&&!runtime.review){sourceEdits?.dispose();pdf?.dispose();await runtime.dispose();await viewer?.dispose();runtime=pdf=sourceEdits=viewer=undefined;updateSourceContext();}}
 const fail=async error=>{if(disposed)return;if(!opening)await discardUnopenedRuntime();output.appendLine(error.stack||error.message);vscode.window.showErrorMessage(error.message);};
 async function refreshSource(options){await Promise.all([comments.refresh(options),sidebar.refresh()]);}
 async function setHighlights(value){
  await context.workspaceState.update('highlightsEnabled',value);decorations.setEnabled(value);
  await vscode.commands.executeCommand('setContext','manuscriptReview.reviewVisible',value);
 }
 async function pdfAction(action,scope){
  const actions={accept:()=>nativeReview.decide('accept',scope),reject:()=>nativeReview.decide('reject',scope),
   reset:()=>nativeReview.decide('reset'),previous:()=>nativeReview.move(-1),next:()=>nativeReview.move(1),
  edit:async()=>{const editor=nativeReview.edit();if(editor)await vscode.window.showTextDocument(editor.document,{preserveFocus:false});},
  comment:()=>nativeReview.comment(),focus:()=>highlightsEnabled()?nativeReview.begin():undefined};
  if(!Object.hasOwn(actions,action))throw new Error('Choose a manuscript review action.');
  return actions[action]();
 }
 async function showAgentHighlights(message){
  await setHighlights(true);await refreshSource();
  vscode.window.setStatusBarMessage(message,5000);
 }
 function refreshComments(options){clearTimeout(timer);timer=setTimeout(()=>refreshSource(options).catch(fail),40);}
 async function start(){
  if(disposed)throw new Error('Manuscript Review has closed.');
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before opening its manuscript review.');
  if(runtime){await runtime.start();return;}
  if(starting)return starting;
  starting=(async()=>{
   const config=vscode.workspace.getConfiguration('manuscriptReview');
   const python=await resolvePython(config.get('pythonPath',''));
   if(disposed)throw new Error('Manuscript Review has closed.');
   if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before opening its manuscript review.');
   agentTools=createAgentTools({extensionPath:context.extensionPath,storagePath:context.globalStorageUri.fsPath,version:context.extension.packageJSON.version,python});
   runtime=createRuntime({extensionPath:path.join(context.extensionPath,'dist'),python,home:config.get('libraryDirectory',''),output});
   viewer=createViewer(path.join(context.extensionPath,'dist','viewer'));
   pdf=createPDFPanel(vscode,context,runtime,{viewer,showReviewed:reviewedEnabled,onAction:pdfAction,onError:error=>output.appendLine(error.stack||error.message)});
   sourceEdits=createSourceEdits(runtime,{state:context.workspaceState,intent:editingIntent,onChange:refreshSource,
    recoverDelivery:async({file})=>{
     const applied='Agent changes were applied',authored='They were not applied';
     const choice=await vscode.window.showWarningMessage('Confirm the interrupted delivery to '+file,{modal:true,detail:'The editor closed before recording whether agent changes reached this buffer. Did they reach it before your saved edits?'},applied,authored);
     return choice===applied?true:choice===authored?false:undefined;
    },resolveCapture:async({file})=>{
     const action='Review as proposal';
     return await vscode.window.showWarningMessage('Review this saved edit against the existing base?',{modal:true,detail:'Advancing the author base would lose a previous wording choice. Your file is saved. Review this edit as a proposal refinement, keeping the author base fixed, or cancel to retain it for later.'},action)===action;
    }});
   delivery=createDelivery(vscode,runtime,{sourceEdits,openDocument:sources.open,
    onConflict:()=>showAgentHighlights('Saved your wording; overlapping agent changes await review.'),
    onDelivered:()=>showAgentHighlights('Agent changes joined your saved draft.')});
   void prepareTools().catch(error=>output.appendLine('Agent tools: '+error.message));
  })().finally(()=>{starting=undefined;});
  return starting;
 }
 function watchRecord(){
  watcher?.dispose();
  const record=runtime.review.feedback_path;
  let observed=runtime.review.revision;
  watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(record),path.basename(record)));
  const id=runtime.review.id;
  const changed=async()=>{try{const value=await runtime.request('/status');if(runtime.review.id!==id||value.revision<=observed)return;observed=value.revision;void pdf.refresh().catch(fail);refreshComments();if(value.authoring)await delivery.refresh();}catch(error){output.appendLine(error.message);}};
  watcher.onDidChange(changed);
  watcher.onDidCreate(changed);
 }
 function navigateReview(action,key){
  if(opening&&key!==undefined&&navigation===key)return opening;
  const run=async()=>{await delivery?.flush();await sourceEdits?.flush();return action();};
  const pending=(opening?opening.catch(()=>{}).then(run):run()).catch(async error=>{
   await discardUnopenedRuntime();
   throw error;
  }).finally(()=>{if(opening===pending){opening=undefined;navigation=undefined;}});
  opening=pending;navigation=key;return pending;
 }
 function chooseReview(repo){return navigateReview(()=>selectReview(repo),'open:'+(repo||''));}
 function prepareTools(){return agentTools.setup();}
 function prepareReview(route,body,title){return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title},()=>runtime.prepare(route,body));}
 async function inspectRepository(folder){
  let info=await runtime.library('/inspect',{repo:folder});
  if(info.repositories){
   const selected=await vscode.window.showQuickPick(info.repositories.map(repo=>({label:repo,repo})),{title:'Choose manuscript repository'});
   if(!selected)return;info=await runtime.library('/inspect',{repo:selected.repo});
  }
  return info;
 }
 async function entryFile(info){
  const active=vscode.window.activeTextEditor?.document.uri;
  const entry=info.entries.find(file=>active?.fsPath===path.join(info.workspace||info.repo,file));
  if(entry||info.entries.length<2)return entry||info.entries[0]||'';
  return vscode.window.showQuickPick(info.entries,{title:'Choose the LaTeX document to render'});
 }
 async function selectRound(id,setup){
  const review=await runtime.open(id,{beforeSelect:async()=>{await delivery.flush();await sourceEdits.flush();},canSelect:()=>!sourceEdits.pending&&!delivery.pending});
  pdf.reset();decorations.clear();nativeReview.clear();setComparison(setup);await sourceEdits.flush();watchRecord();
  if(!review.files.some(file=>file.edits.length)){await setHighlights(false);}
  await refreshSource();void pdf.refresh().catch(fail);
  await vscode.commands.executeCommand('setContext','manuscriptReview.active',true);updateSourceContext();
  return review;
 }
 async function restoreSourceReview(document){
  if(!vscode.workspace.isTrusted||!sourceDocument(document)||sourceFile(runtime?.review,document))return;
  return navigateReview(async()=>{
   await start();const library=await runtime.library('/library-data');
   const review=library.reviews.find(review=>review.workspace&&sourceFile(review,document));
   if(review&&vscode.window.activeTextEditor?.document===document){await selectRound(review.id,comparison?.pending?comparison:undefined);}
  });
 }
 async function ensureCommentSource(document){
  if(!canComment(document))throw new Error('Turn on source comments in the Manuscript Review sidebar.');
  if(sourceFile(runtime?.review,document))return;
  return navigateReview(async()=>{
   if(sourceFile(runtime?.review,document))return;
   await start();await prepareTools();
   const info=await inspectRepository(path.dirname(document.uri.fsPath));if(!info)throw new Error('Choose a manuscript repository to leave a comment.');
   const library=await runtime.library('/library-data');
   const previous=library.reviews.find(review=>review.workspace&&sourceFile(review,document));
   const entry=info.entries.find(file=>document.uri.fsPath===path.join(info.workspace||info.repo,file))||info.entries[0]||'';
   const id=previous?.id||(await prepareReview('/prepare',{repo:info.repo,workspace:info.workspace||info.repo,
    manuscript:true,base:'working',proposed:'working',base_label:'Working files',proposed_label:'Working files',entry},'Opening manuscript comments')).review;
   await selectRound(id,comparison?.pending?comparison:undefined);
  },'comment:'+document.uri.toString());
 }
 async function selectReview(repo){
  await start();await prepareTools();
  const active=vscode.window.activeTextEditor?.document.uri;
  const folder=repo||(active?.scheme==='file'?path.dirname(active.fsPath):vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if(!folder)throw new Error('Open a manuscript folder in VS Code first.');
  const info=await inspectRepository(folder);if(!info)return;
  const library=await runtime.library('/library-data'),rounds=library.reviews.filter(review=>review.repo===info.repo);
  const options=rounds.length?rounds.map((review,index)=>({label:`Round ${rounds.length-index}`,description:`${review.base_label} → ${review.proposal_label}`,review})): [{label:'Open manuscript',description:'Read and annotate the current working files'}];
  const selected=rounds.length?await vscode.window.showQuickPick(options,{title:path.basename(info.repo)}):options[0];
  if(!selected)return;
  let id=selected.review?.id;
  if(!id){
   const entry=await entryFile(info);if(entry===undefined)return;
   id=(await prepareReview('/manuscript',{repo:info.repo,entry},'Opening manuscript')).review;
  }
  const review=await selectRound(id);
  if(review.files.some(file=>file.edits.length))await showReview();
  return review;
 }
 async function ensureReview(){
  if(opening)await opening;
  if(runtime?.review){await start();return true;}
  await chooseReview();
  return Boolean(runtime?.review);
 }
 async function showReview(entry){
  await context.workspaceState.update('editingIntent','proposal');
  await setHighlights(true);
  const source=vscode.window.activeTextEditor?.document;
  if(!sourceFile(runtime.review,source)&&runtime.review.workspace){
   const data=await runtime.request('/summary');
   if(data.entry)await openSource({file:data.entry});
  }
  await delivery.refresh({force:true});await refreshSource();await nativeReview.begin(entry||nativeReview.selection());
 }
 async function focusReview(){if(await ensureReview())await showReview();}
 async function sendToAgent(identifier,saveComment,sourceUri){
  if(sending)throw new Error('The previous comment is still being sent.');
  sending=true;
  try{return await dispatchComment(identifier,saveComment,sourceUri);}finally{sending=false;}
 }
 async function dispatchComment(identifier,saveComment,sourceUri){
  const reviewId=runtime?.review?.id,epoch=comparisonEpoch;
  if(!reviewId)throw new Error('Open the comment’s review before sending it to an agent.');
  if(!await ensureReview())return;
  if(runtime.review.id!==reviewId)throw new Error('The review changed. Send the comment from its original round.');
  await sourceEdits.flush();
  if(runtime.review.id!==reviewId)throw new Error('The review changed. Send the comment from its original round.');
  if(saveComment){
   identifier=await saveComment();
   if(!identifier)return false;
   if(runtime.review.id!==reviewId)throw new Error('The review changed. Send the comment from its original round.');
  }
  const agent=selectedAgent();
  if(runtime.review.id!==reviewId)throw new Error('The review changed. Send the comment from its original round.');
  await prepareTools();
  if(runtime.review.id!==reviewId)throw new Error('The review changed. Send the comment from its original round.');
  const result=await runtime.request('/agent',{revision:runtime.review.revision,id:identifier,
   authoring:Boolean(sourceUri)&&editingIntent()==='author',entry:sourceFile(runtime.review,sourceUri?{uri:sourceUri}:vscode.window.activeTextEditor?.document),
   launcher:agentTools.launcher,skill:agentTools.skill,agent:agent.id,...(agent.model?{model:agent.model}:{})});
  if(sourceUri){if(epoch===comparisonEpoch)setComparison(undefined);refreshComments();}
  output.appendLine(result.message+' Output: '+result.log);
  vscode.window.setStatusBarMessage(result.message,4000);
  return true;
 }
 async function reviewManuscript(resource){
  const document=resource?.scheme==='file'?{uri:resource}:vscode.window.activeTextEditor?.document;
  if(document?.uri.scheme==='file'&&(!runtime?.review||!sourceFile(runtime.review,document))){
   if(!await chooseReview(path.dirname(document.uri.fsPath)))return;
  }
  await focusReview();
 }
 async function openSource(message){
  await sourceEdits.flush();
  const {id}=runtime.review,document=await sources.open(message.file);
  if(runtime.review?.id!==id)throw new Error('The manuscript review changed. Open this location again.');
  const version=document.version,text=document.getText();
  const saved=snapshotVersion(document);
  const source=await runtime.request('/editor',{file:sourceFile(runtime.review,document)||message.file,text,...(saved?{version:saved}:{}),...(Number.isInteger(message.position)?{point:message.position}:{})});
  if(runtime.review?.id!==id||document.version!==version)throw new Error('The source or review changed while opening this location. Try again.');
  const range=source.notes.find(note=>note.id===message.comment)||source.ranges.find(range=>range.id===message.edit);
  const start=source.position??range?.from??0,end=message.comment?range?.to??start:start;
  const editor=await vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn.One,preserveFocus:Boolean(pdf?.active)});
  if(runtime.review?.id!==id||document.version!==version)throw new Error('The source or review changed while opening this location. Try again.');
  editor.selection=new vscode.Selection(document.positionAt(start),document.positionAt(end));
  editor.revealRange(editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  if(document.uri.scheme===sourceScheme)vscode.window.setStatusBarMessage('File removed from editing folder; showing saved review source.',5000);
  await comments.refresh({file:message.file});return editor;
 }
 async function reviewSavedChanges(){
  if(!await ensureReview())return;
  return navigateReview(saveChangesRound);
 }
 async function editingFolder(){
  if(!await ensureReview())return;await sourceEdits.flush();
  await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(runtime.review.workspace||runtime.review.repo),{forceNewWindow:true});
 }
 function requireSavedSource(){
  requireRepositorySaved(runtime.review.workspace||runtime.review.repo);
 }
 function requireRepositorySaved(repo){
  if(vscode.workspace.textDocuments.some(document=>document.isDirty&&document.uri.scheme==='file'&&document.uri.fsPath.startsWith(repo+path.sep)))
   throw new Error('Save or discard your manuscript edits before applying or comparing changes.');
 }
 async function applyReview(body){
  if(sourceEdits.pending)throw new Error('Wait for saved source edits to finish refreshing before applying.');
  return runtime.request('/apply',body,requireSavedSource);
 }
 async function saveChangesRound(){
  requireSavedSource();
  const result=await prepareReview('/update',{id:runtime.review.id,expected_revision:runtime.review.revision,require_changes:true},'Comparing saved changes');
  await selectRound(result.review);await showReview();
 }
 async function inspectComparison(repo){
  await start();
  const active=vscode.window.activeTextEditor?.document.uri;
  let folder=repo||(active?.scheme==='file'?path.dirname(active.fsPath):runtime.review?.repo||vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if(!folder)return;
  const info=await inspectRepository(folder);if(!info)return;
  const entry=info.entries.find(file=>active?.fsPath===path.join(info.workspace||info.repo,file));
  return comparisonState(vscode,info,entry);
 }
 function compareVersions(repo){return navigateReview(async()=>{
  if(repo&&(!comparison||![comparison.info.repo,comparison.info.workspace].includes(repo))){const epoch=comparisonEpoch;const next=await inspectComparison(repo);if(epoch===comparisonEpoch)setComparison(next);}
  await sidebar.show();await sidebar.refresh();
 });}
 async function currentComparison(){
  if(comparison)return comparison;
  const epoch=comparisonEpoch;
  if(runtime?.review){const id=runtime.review.id,data=await runtime.request('/summary');if(epoch!==comparisonEpoch||runtime.review?.id!==id)return currentComparison();return comparison=reviewComparison(undefined,data);}
  if(inspection?.epoch!==epoch)inspection={epoch,promise:inspectComparison(runtime?.review?.workspace||runtime?.review?.repo)};
  const pending=inspection;
  let next;
  try{next=await pending.promise;}finally{if(inspection===pending)inspection=undefined;}
  if(disposed)return;
  if(epoch!==comparisonEpoch)return currentComparison();
  comparison??=next;return comparison;
 }
 async function loadSidebar(){
  if(!vscode.workspace.isTrusted)return sidebarState(undefined,undefined,commentsEnabled(),selectedAgent().label,highlightsEnabled());
  try{
   const epoch=comparisonEpoch;
   await currentComparison();
   const data=runtime?.review&&runtime.review.repo===comparison?.info.repo?await runtime.request('/summary'):undefined;
   if(epoch!==comparisonEpoch)return loadSidebar();
   if(data&&!comparison.pending)comparison=reviewComparison(comparison,data);
   const state=sidebarState(comparison,data,commentsEnabled(),selectedAgent().label,highlightsEnabled(),selectedAgent().model||'CLI default',removalsEnabled(),editingIntent());
   state.comment=comments.input();return state;
  }catch(error){if(!opening)await discardUnopenedRuntime();throw error;}
 }
 function checkSidebar(expected){
   if(expected?.folder&&expected.folder!==(comparison?.info.workspace||comparison?.info.repo)
    ||expected?.fromVersion&&expected.fromVersion!==comparison?.base.revision
    ||expected?.toVersion&&expected.toVersion!==comparison?.proposed.revision
    ||expected?.entry!==undefined&&expected.entry!==(comparison?.entry||'Source only'))
    throw new Error('The comparison changed. Use the current sidebar controls.');
   if(expected?.review&&expected.review!==runtime?.review?.id)throw new Error('The review changed. Use the current sidebar controls.');
 }
 async function sidebarAction(action,expected){
  if(!['comments','agent','model','sessions','agentChanges','repository','highlights','removals','commentDraft','commentSave','commentSend','commentClose','commentResolve'].includes(action))checkSidebar(expected);
  const actions={
   commentDraft:()=>comments.editInput(expected.input,expected.text),
   commentSave:()=>comments.submitInput(expected.input,expected.text),
   commentSend:()=>comments.submitInput(expected.input,expected.text,true),
   commentClose:()=>comments.cancelInput(expected.input),
   commentResolve:()=>comments.resolveInput(expected.input),
   editing:chooseEditing,
   removals:async()=>{const value=!removalsEnabled();await context.workspaceState.update('removalsEnabled',value);if(!value)await vscode.commands.executeCommand('editor.action.hideHover');},
   highlights:async()=>{const enabled=!highlightsEnabled();await setHighlights(enabled);nativeReview.refresh();if(!enabled)nativeReview.edit();if(enabled)await comments.refresh();},
   comments:async()=>{const enabled=!commentsEnabled();await context.globalState.update('commentsEnabled',enabled);comments.setEnabled(enabled);updateSourceContext();if(enabled)await restoreSourceReview(vscode.window.activeTextEditor?.document);},
   agent:chooseAgent,model:chooseModel,sessions:openAgentSession,agentChanges:showAgentChanges,previous:()=>comments.move(-1),next:()=>comments.move(1),
   repository:async()=>{await start();const info=await chooseComparisonRepository();if(info)setComparison({...comparisonState(vscode,info),pending:true});},
   base:()=>editComparison('base'),proposed:()=>editComparison('proposed'),entry:()=>runtime?.review&&!comparison?.pending?choosePDFEntry():editComparison('entry'),pdf:showPDF,
   review:()=>navigateReview(()=>openComparison(expected)),
   apply:async()=>{if(!await ensureReview())return;const review=runtime.review.id;await sourceEdits.flush();const data=await runtime.data();
    if(data.id!==review||expected?.review&&expected.review!==data.id||!comparisonMatches(comparison,data)||expected?.revision!==undefined&&expected.revision!==data.revision)throw new Error('The review changed. Check the current choices before applying.');
    await applyReview({revision:data.revision,decisions:data.decisions,comments:data.comments});await refreshSource();void pdf.refresh().catch(fail);}
  };
  if(!Object.hasOwn(actions,action))throw new Error('Choose a review control.');
  return actions[action]();
 }
 async function choosePDFEntry(open=false){
  const id=runtime.review.id,epoch=comparisonEpoch;
  const data=await runtime.request('/pdf-entry');
  if(runtime.review?.id!==id||epoch!==comparisonEpoch)throw new Error('The comparison changed. Open PDF setup again.');
  if(open&&data.entries.includes(data.entry))return true;
  if(open&&!data.entries.length)throw new Error('This selected version has no LaTeX document to render. Choose a version containing a documentclass declaration.');
  const choice=open&&data.entries.length===1?data.entries[0]:await vscode.window.showQuickPick(
   open?data.entries:[...data.entries,'Source only'],{title:'PDF document',placeHolder:'LaTeX root in the selected manuscript version'});
  if(choice===undefined)return false;
  if(runtime.review?.id!==id||epoch!==comparisonEpoch)throw new Error('The comparison changed. Open PDF setup again.');
  const entry=choice==='Source only'?'':choice;
  if(entry!==data.entry){
   await runtime.request('/pdf-entry',{revision:data.revision,entry});
   const summary=await runtime.request('/summary');
   if(runtime.review?.id!==id||epoch!==comparisonEpoch)throw new Error('The comparison changed while setting its PDF document.');
   comparison=reviewComparison(comparison,summary);
   pdf.reset();await refreshSource();await pdf.refresh();
  }
  return Boolean(entry);
 }
 async function showPDF(){
  if(!await ensureReview())return;
  if(comparison?.pending)throw new Error('Compare the selected versions before opening their PDF.');
  const id=runtime.review.id,epoch=comparisonEpoch;
  const check=()=>{if(runtime.review?.id!==id||comparisonEpoch!==epoch||comparison?.pending)throw new Error('The comparison changed. Open its PDF again.');};
  await sourceEdits.flush();check();
  if(!await choosePDFEntry(true))return;check();
  await refreshSource();check();
  const active=vscode.window.activeTextEditor;
  const editor=sourceFile(runtime.review,active?.document)?active:vscode.window.visibleTextEditors.find(editor=>sourceFile(runtime.review,editor.document));
  await pdf.show(editor?.viewColumn,check);
 }
 async function editComparison(field){
  const current=await currentComparison();if(!current)return;
  const epoch=comparisonEpoch;
  const updated=await changeComparison(vscode,current,field,async()=>{
   const info=await inspectRepository(current.info.workspace||current.info.repo);
   if(epoch!==comparisonEpoch)throw new Error('The comparison changed while loading its history. Choose the field again.');
   return info?refreshComparison(vscode,current,info):current;
  });
  if(epoch!==comparisonEpoch)throw new Error('The comparison changed while choosing a version. Choose the field again.');
  setComparison(updated);
 }
 async function openComparison(expected){
  checkSidebar(expected);await start();await currentComparison();if(!comparison)return;
  const current=comparison,epoch=comparisonEpoch;
  const check=()=>{checkSidebar(expected);if(epoch!==comparisonEpoch)throw new Error('The comparison changed. Use the current sidebar controls.');};
  const data=runtime?.review?await runtime.data():undefined;
  check();if(comparisonMatches(current,data)){await showReview();return;}
  await prepareTools();
  check();if([current.base.revision,current.proposed.revision].includes('working'))requireRepositorySaved(current.info.workspace||current.info.repo);
  const job=await prepareReview('/prepare',comparisonRequest(current),'Preparing comparison');
  check();await selectRound(job.review);await showReview();
 }
 async function chooseComparisonRepository(){
  const folders=vscode.workspace.workspaceFolders||[];
  const options=folders.map(folder=>({label:folder.name||path.basename(folder.uri.fsPath),description:folder.uri.fsPath,folder:folder.uri.fsPath}));
  options.push({label:'Choose another folder…'});
  const selected=await vscode.window.showQuickPick(options,{title:'Manuscript folder',matchOnDescription:true});if(!selected)return;
  let folder=selected.folder;
  if(!folder){const chosen=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Choose manuscript'});if(!chosen)return;folder=chosen[0].fsPath;}
  return inspectRepository(folder);
 }
 async function cloneRepository(){
  await start();const url=await vscode.window.showInputBox({title:'Clone manuscript repository',prompt:'GitHub repository URL'});if(!url)return;
  const folders=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Clone here'});if(!folders)return;
  const result=await prepareReview('/clone',{url,directory:folders[0].fsPath},'Cloning manuscript');await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(result.repo));
 }
 async function reviewLibrary(){
  await start();
  const data=await runtime.library('/library-data');
  const choice=await vscode.window.showQuickPick(manuscriptReviews(data.reviews).map(rounds=>({label:path.basename(rounds[0].repo),description:rounds[0].repo,repo:rounds[0].repo})),{title:'Review library',matchOnDescription:true});
  if(choice)await chooseReview(choice.repo);
 }
 async function fetchRepository(){
  if(!await ensureReview())return;
  await prepareReview('/fetch',{repo:runtime.review.repo},'Fetching manuscript history');await compareVersions(runtime.review.workspace||runtime.review.repo);
 }
 function importReview(){return navigateReview(async()=>{
  await start();await prepareTools();
  const files=await vscode.window.showOpenDialog({canSelectFolders:false,canSelectFiles:true,canSelectMany:false,openLabel:'Import review',filters:{'Review record':['json']}});if(!files)return;
  const result=await runtime.library('/import',{source:files[0].fsPath});await selectRound(result.review);await showReview();
 });}
 async function setup(){
  await start();const info=await agentTools.setup({refresh:true});
  const tools=Object.entries(info.preview_tools).filter(([,value])=>!value).map(([name])=>name);
  const options=info.agents.map(agent=>({label:'Install skill for '+agent.name,agent:agent.id,description:agent.installed?'Existing skill preserved':'Bundled agent commands'}));
  options.unshift({label:'Prerequisites',description:!info.git?'Git is missing':tools.length?'PDF tools missing: '+tools.join(', '):'Git and PDF tools ready'});
  options.push({label:'Copy agent command',copy:true});
  const choice=await vscode.window.showQuickPick(options,{title:'Manuscript Review Setup'});if(!choice)return;
  if(choice.agent){const result=await agentTools.install(choice.agent);await vscode.window.showInformationMessage(result.message);}
  else if(choice.copy)await vscode.env.clipboard.writeText(agentTools.command);
  else await vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(path.join(context.extensionPath,'dist','README.md')));
 }
 async function sourceDrafts(){
  if(!await ensureReview())return;
  const data=await runtime.data(),drafts=Object.entries(data.drafts);
  if(!drafts.length){await vscode.window.showInformationMessage('No saved source drafts. VS Code retains unsaved editor buffers.');return;}
  const choice=await vscode.window.showQuickPick(drafts.map(([file,draft])=>({label:file,file,draft})),{title:'Saved source drafts'});if(!choice)return;
  const action=await vscode.window.showQuickPick(['Open draft in editor','Discard saved draft'],{title:choice.file});if(!action)return;
  if(runtime.review.id!==data.id)throw new Error('Return to the original review before handling its draft.');
  if(action==='Open draft in editor'){
   const document=await vscode.workspace.openTextDocument({content:choice.draft.text,language:choice.file.endsWith('.tex')?'latex':'plaintext'});
   await vscode.window.showTextDocument(document,{preserveFocus:false});
  }else{await runtime.request('/draft',{revision:data.revision,id:choice.file,draft:null});await comments.refresh();void pdf.refresh().catch(fail);}
 }
 function command(name,action){subscriptions.push(vscode.commands.registerCommand('manuscriptReview.'+name,async(...args)=>{try{return await action(...args);}catch(error){await fail(error);}}));}
 command('open',()=>chooseReview());
 command('review',reviewManuscript);
 command('focusedReview',focusReview);
 command('acceptChange',scope=>nativeReview.decide('accept',scope));
 command('rejectChange',scope=>nativeReview.decide('reject',scope));
 command('resetChange',()=>nativeReview.decide('reset'));
 command('previousChange',()=>nativeReview.move(-1));
 command('nextChange',()=>nativeReview.move(1));
 command('commentChange',()=>nativeReview.comment());
 command('toggleReviewedChanges',async()=>{const value=!reviewedEnabled();await context.workspaceState.update('reviewedEnabled',value);decorations.setReviewed(value);await pdf?.refresh();});
 command('editSource',()=>nativeReview.edit());
 command('exitReview',async()=>{nativeReview.edit();await setHighlights(false);await refreshSource();});
 command('reviewPDF',showPDF);
 command('refresh',async()=>{if(!await ensureReview())return;await refreshSource();void pdf.refresh().catch(fail);});
 command('reviewSavedChanges',reviewSavedChanges);
 command('compare',()=>compareVersions());
 command('clone',cloneRepository);
 command('fetch',fetchRepository);
 command('setup',setup);
 command('sourceDrafts',sourceDrafts);
 command('editingFolder',editingFolder);
 command('chooseAgent',chooseAgent);
 command('chooseModel',chooseModel);
 command('agentSessions',openAgentSession);
 command('agentChanges',showAgentChanges);
 command('library',reviewLibrary);
 command('import',importReview);
 command('comment',()=>comments.annotate(vscode.window.activeTextEditor));
 command('toggleComments',()=>sidebarAction('comments'));
 command('toggleHighlights',async()=>{await sidebarAction('highlights');await sidebar.refresh();});
 command('previousComment',()=>comments.move(-1));
 command('nextComment',()=>comments.move(1));
 subscriptions.push(vscode.window.registerUriHandler({handleUri:uri=>{const id=uri.path.match(/^\/review\/([a-f0-9]{24})$/)?.[1];if(!id)return;return navigateReview(async()=>{await start();await prepareTools();await selectRound(id);await showReview();}).catch(fail);}}));
 command('livePDF',async()=>{if(!vscode.window.activeTextEditor)throw new Error('Select a location in the LaTeX source first.');const extension=vscode.extensions.getExtension('James-Yu.latex-workshop');if(!extension)throw new Error('Install LaTeX Workshop to use source-to-PDF navigation.');await extension.activate();await vscode.commands.executeCommand('latex-workshop.synctex');});
 subscriptions.push(vscode.workspace.onDidSaveTextDocument(document=>sourceEdits?.save(document).then(()=>delivery?.refresh()).catch(fail)));
 subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{sourceEdits?.change(event.document);if(runtime?.review&&event.document.uri.scheme==='file')refreshComments({sourceOnly:true});}));
 subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(()=>{if(runtime?.review)refreshComments();}));
 subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor=>{if(!comparison&&!runtime?.review)comparisonEpoch++;updateSourceContext();if(sourceFile(runtime?.review,editor?.document))decorations.reveal();void restoreSourceReview(editor?.document).catch(error=>output.appendLine(error.message));}));
 disposeExtension=()=>disposing??=(async()=>{
  disposed=true;
  await starting?.catch(()=>{});
  delivery?.dispose();
  try{await delivery?.flush();await sourceEdits?.flush();}catch(error){output.appendLine('Saved source remains on disk; compare saved changes to recover its diff: '+error.message);}
  clearTimeout(timer);watcher?.dispose();delivery?.dispose();sourceEdits?.dispose();comments?.dispose();pdf?.dispose();decorations.dispose();for(const subscription of subscriptions)subscription.dispose();await runtime?.dispose();await viewer?.dispose();
 })();
 context.subscriptions.push({dispose:()=>{void disposeExtension();}});
 updateSourceContext();void vscode.commands.executeCommand('setContext','manuscriptReview.reviewVisible',highlightsEnabled());void restoreSourceReview(vscode.window.activeTextEditor?.document).catch(error=>output.appendLine(error.message));
}
export function deactivate(){return disposeExtension?.();}
