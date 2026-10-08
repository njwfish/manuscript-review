import * as vscode from 'vscode';
import path from 'node:path';
import {realpath,readFile} from 'node:fs/promises';
import {createRuntime} from './runtime.mjs';
import {createComments,sourceFile} from './comments.mjs';
import {createPanel} from './panel.mjs';
import {createDecorations} from './decorations.mjs';
import {createAgentTools} from './agent.mjs';
import {manuscriptReviews} from '../../manuscript_review/review_model.js';

let disposeExtension;
export function activate(context){
 const output=vscode.window.createOutputChannel('Manuscript Review');
 const decorations=createDecorations(vscode);
 let runtime,comments,panel,watcher,timer,opening,navigation,agentTools;
 const subscriptions=[output];
 subscriptions.push(vscode.window.registerTreeDataProvider('manuscriptReview.start',{getTreeItem:item=>item,getChildren:()=>[]}));
 function updateSourceContext(){void vscode.commands.executeCommand('setContext','manuscriptReview.source',Boolean(sourceFile(runtime?.review,vscode.window.activeTextEditor?.document)));}
 async function discardUnopenedRuntime(){if(runtime&&!runtime.review){comments?.dispose();panel?.dispose();await runtime.dispose();runtime=comments=panel=undefined;updateSourceContext();}}
 const fail=async error=>{if(!opening)await discardUnopenedRuntime();output.appendLine(error.stack||error.message);vscode.window.showErrorMessage(error.message);};
 function refreshComments(){clearTimeout(timer);timer=setTimeout(()=>comments?.refresh().catch(fail),180);}
 function start(){
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before opening its manuscript review.');
  if(runtime)return;
  const config=vscode.workspace.getConfiguration('manuscriptReview');
  agentTools=createAgentTools({extensionPath:context.extensionPath,storagePath:context.globalStorageUri.fsPath,version:context.extension.packageJSON.version,python:config.get('pythonPath','python3')});
  runtime=createRuntime({extensionPath:path.join(context.extensionPath,'dist'),python:config.get('pythonPath','python3'),home:config.get('libraryDirectory',''),output});
  const actions={rounds:()=>chooseReview(runtime.review.repo),library:reviewLibrary,reviewSavedChanges,compare:()=>compareVersions(runtime.review.repo),setup,sourceDrafts};
  panel=createPanel(vscode,context,runtime,{onSource:openSource,onChange:refreshComments,onApply:applyReview,agentLauncher:agentTools.launcher,
   onCommand:name=>{if(!Object.hasOwn(actions,name))throw new Error('Unknown review command.');return actions[name]();}});
  comments=createComments(vscode,runtime,{onChange:()=>{panel.changed();},onReview:entry=>panel.show(entry),onProjection:(projection,data)=>decorations.update(projection,data)});
 }
 function watchRecord(){
  watcher?.dispose();
  const record=runtime.review.feedback_path;
  watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(record),path.basename(record)));
  const changed=async()=>{try{const value=JSON.parse(await readFile(record,'utf8'));panel.changed(value.revision);refreshComments();}catch(error){output.appendLine(error.message);}};
  watcher.onDidChange(changed);
  watcher.onDidCreate(changed);
 }
 function navigateReview(action,key){
  if(opening&&key!==undefined&&navigation===key)return opening;
  const pending=(opening?opening.catch(()=>{}).then(action):action()).catch(async error=>{
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
  const entry=info.entries.find(file=>active?.fsPath===path.join(info.repo,file));
  if(entry||info.entries.length<2)return entry||info.entries[0]||'';
  return vscode.window.showQuickPick(info.entries,{title:'Choose the LaTeX document to render'});
 }
 async function selectRound(id){
  panel.dispose();decorations.clear();const review=await runtime.open(id);watchRecord();await comments.refresh();
  await vscode.commands.executeCommand('setContext','manuscriptReview.active',true);updateSourceContext();
  return review;
 }
 async function selectReview(repo){
  start();await prepareTools();await panel.flush();
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
  if(review.files.some(file=>file.edits.length))await panel.show();
  return review;
 }
 async function ensureReview(){
  if(opening)await opening;
  if(runtime?.review)return true;
  await chooseReview();
  return Boolean(runtime?.review);
 }
 async function focusReview(){if(await ensureReview())await panel.show();}
 async function reviewManuscript(resource){
  const document=resource?.scheme==='file'?{uri:resource}:vscode.window.activeTextEditor?.document;
  if(document?.uri.scheme==='file'&&(!runtime?.review||!sourceFile(runtime.review,document))){
   if(!await chooseReview(path.dirname(document.uri.fsPath)))return;
  }
  await focusReview();
 }
 async function openSource(message){
  const {id,repo}=runtime.review,requested=path.resolve(repo,message.file||'');
  const relative=path.relative(repo,requested);
  if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith(`..${path.sep}`))throw new Error('Choose a source file in this manuscript.');
  const canonical=await realpath(requested),resolvedRepo=await realpath(repo),resolved=path.relative(resolvedRepo,canonical);
  if(resolved==='..'||resolved.startsWith(`..${path.sep}`)||path.isAbsolute(resolved))throw new Error('The source file points outside this manuscript.');
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(requested));
  if(runtime.review?.id!==id)throw new Error('The manuscript review changed. Open this location again.');
  const version=document.version,text=document.getText();
  const source=await runtime.request('/editor',{file:relative.split(path.sep).join('/'),text,...(Number.isInteger(message.position)?{point:message.position}:{})});
  if(runtime.review?.id!==id||document.version!==version)throw new Error('The source or review changed while opening this location. Try again.');
  const range=source.notes.find(note=>note.id===message.comment)||source.ranges.find(range=>range.id===message.edit);
  const start=source.position??range?.from??0,end=message.comment?range?.to??start:start;
  const editor=await vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn.One,preserveFocus:false});
  if(runtime.review?.id!==id||document.version!==version)throw new Error('The source or review changed while opening this location. Try again.');
  editor.selection=new vscode.Selection(document.positionAt(start),document.positionAt(end));
  editor.revealRange(editor.selection,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
 }
 async function reviewSavedChanges(){
  if(!await ensureReview())return;
  return navigateReview(saveChangesRound);
 }
 function requireSavedSource(){
  requireRepositorySaved(runtime.review.repo);
 }
 function requireRepositorySaved(repo){
  if(vscode.workspace.textDocuments.some(document=>document.isDirty&&document.uri.scheme==='file'&&document.uri.fsPath.startsWith(repo+path.sep)))
   throw new Error('Save or discard your manuscript edits before applying or comparing changes.');
 }
 async function applyReview(body){
  return runtime.request('/apply',body,requireSavedSource);
 }
 async function saveChangesRound(){
  requireSavedSource();
  await panel.flush();
  requireSavedSource();
  const result=await prepareReview('/update',{id:runtime.review.id,expected_revision:runtime.review.revision,require_changes:true},'Comparing saved changes');
  await selectRound(result.review);await panel.show();
 }
 function compareVersions(repo){return navigateReview(()=>prepareComparison(repo));}
 async function prepareComparison(repo){
  start();await prepareTools();await panel.flush();
  let folder=repo||vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if(!folder){const folders=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Choose manuscript'});if(!folders)return;folder=folders[0].fsPath;}
  const info=await inspectRepository(folder);if(!info)return;
  const choices=[...(info.checkpoints||[]).map(item=>({label:item.subject,description:item.short+' '+item.date,revision:item.revision})),
   ...(info.references||[]).map(item=>({label:item.name,description:item.subject,revision:item.revision})),
   ...(info.commits||[]).map(item=>({label:item.subject,description:item.short+' '+item.date,revision:item.revision}))];
  const base=await vscode.window.showQuickPick(choices,{title:'Compare from',matchOnDescription:true});if(!base)return;
  const proposed=await vscode.window.showQuickPick([{label:'Working files',description:'Saved tracked source',revision:'working'},...choices],{title:'Compare to',matchOnDescription:true});if(!proposed)return;
  if(proposed.revision==='working')requireRepositorySaved(info.repo);
  const entry=await entryFile(info);if(entry===undefined)return;
  if(proposed.revision==='working')requireRepositorySaved(info.repo);
  const job=await prepareReview('/prepare',{repo:info.repo,base:base.revision,base_label:base.label,proposed:proposed.revision,entry},'Preparing comparison');
  await selectRound(job.review);await panel.show();
 }
 async function cloneRepository(){
  start();const url=await vscode.window.showInputBox({title:'Clone manuscript repository',prompt:'GitHub repository URL'});if(!url)return;
  const folders=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Clone here'});if(!folders)return;
  const result=await prepareReview('/clone',{url,directory:folders[0].fsPath},'Cloning manuscript');await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(result.repo));
 }
 async function reviewLibrary(){
  start();await panel.flush();
  const data=await runtime.library('/library-data');
  const choice=await vscode.window.showQuickPick(manuscriptReviews(data.reviews).map(rounds=>({label:path.basename(rounds[0].repo),description:rounds[0].repo,repo:rounds[0].repo})),{title:'Review library',matchOnDescription:true});
  if(choice)await chooseReview(choice.repo);
 }
 async function fetchRepository(){
  if(!await ensureReview())return;
  await prepareReview('/fetch',{repo:runtime.review.repo},'Fetching manuscript history');await compareVersions(runtime.review.repo);
 }
 function importReview(){return navigateReview(async()=>{
  start();await prepareTools();await panel.flush();
  const files=await vscode.window.showOpenDialog({canSelectFolders:false,canSelectFiles:true,canSelectMany:false,openLabel:'Import review',filters:{'Review record':['json']}});if(!files)return;
  const result=await runtime.library('/import',{source:files[0].fsPath});await selectRound(result.review);await panel.show();
 });}
 async function setup(){
  start();const info=await prepareTools();
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
  if(!await ensureReview())return;await panel.flush();
  const data=await runtime.data(),drafts=Object.entries(data.drafts);
  if(!drafts.length){await vscode.window.showInformationMessage('No saved source drafts. VS Code retains unsaved editor buffers.');return;}
  const choice=await vscode.window.showQuickPick(drafts.map(([file,draft])=>({label:file,file,draft})),{title:'Saved source drafts'});if(!choice)return;
  const action=await vscode.window.showQuickPick(['Open draft in editor','Discard saved draft'],{title:choice.file});if(!action)return;
  if(runtime.review.id!==data.id)throw new Error('Return to the original review before handling its draft.');
  if(action==='Open draft in editor'){
   const document=await vscode.workspace.openTextDocument({content:choice.draft.text,language:choice.file.endsWith('.tex')?'latex':'plaintext'});
   await vscode.window.showTextDocument(document,{preserveFocus:false});
  }else{await runtime.request('/draft',{revision:data.revision,id:choice.file,draft:null});await comments.refresh();await panel.refresh();}
 }
 function command(name,action){subscriptions.push(vscode.commands.registerCommand('manuscriptReview.'+name,async(...args)=>{try{return await action(...args);}catch(error){await fail(error);}}));}
 command('open',()=>chooseReview());
 command('review',reviewManuscript);
 command('focusedReview',focusReview);
 command('refresh',async()=>{if(!await ensureReview())return;await comments.refresh();await panel.refresh();});
 command('reviewSavedChanges',reviewSavedChanges);
 command('compare',()=>compareVersions());
 command('clone',cloneRepository);
 command('fetch',fetchRepository);
 command('setup',setup);
 command('sourceDrafts',sourceDrafts);
 command('library',reviewLibrary);
 command('import',importReview);
 command('comment',async()=>{const editor=vscode.window.activeTextEditor;if(await ensureReview())await comments.annotate(editor);});
 command('previousComment',async()=>{if(await ensureReview())await comments.move(-1);});
 command('nextComment',async()=>{if(await ensureReview())await comments.move(1);});
 subscriptions.push(vscode.window.registerUriHandler({handleUri:uri=>{const id=uri.path.match(/^\/review\/([a-f0-9]{24})$/)?.[1];if(!id)return;return navigateReview(async()=>{start();await prepareTools();await panel.flush();await selectRound(id);await panel.show();}).catch(fail);}}));
 command('livePDF',async()=>{if(!vscode.window.activeTextEditor)throw new Error('Select a location in the LaTeX source first.');const extension=vscode.extensions.getExtension('James-Yu.latex-workshop');if(!extension)throw new Error('Install LaTeX Workshop to use source-to-PDF navigation.');await extension.activate();await vscode.commands.executeCommand('latex-workshop.synctex');});
 subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(runtime?.review&&event.document.uri.scheme==='file')refreshComments();}));
 subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(()=>{if(runtime?.review)refreshComments();}));
 subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateSourceContext));
 disposeExtension=async()=>{clearTimeout(timer);watcher?.dispose();comments?.dispose();panel?.dispose();decorations.dispose();for(const subscription of subscriptions)subscription.dispose();await runtime?.dispose();};
 context.subscriptions.push({dispose:()=>{void disposeExtension();}});
}
export function deactivate(){return disposeExtension?.();}
