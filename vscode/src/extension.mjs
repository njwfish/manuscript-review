import * as vscode from 'vscode';
import path from 'node:path';
import {realpath,readFile} from 'node:fs/promises';
import {createRuntime} from './runtime.mjs';
import {createComments,sourceFile} from './comments.mjs';
import {createPanel} from './panel.mjs';
import {createDecorations} from './decorations.mjs';

let disposeExtension;
export function activate(context){
 const output=vscode.window.createOutputChannel('Manuscript Review');
 const decorations=createDecorations(vscode);
 let runtime,comments,panel,watcher,timer,opening;
 const subscriptions=[output];
 function updateSourceContext(){void vscode.commands.executeCommand('setContext','manuscriptReview.source',Boolean(sourceFile(runtime?.review,vscode.window.activeTextEditor?.document)));}
 const fail=error=>{output.appendLine(error.stack||error.message);vscode.window.showErrorMessage(error.message);};
 function refreshComments(){decorations.clear();clearTimeout(timer);timer=setTimeout(()=>comments?.refresh().catch(fail),180);}
 function start(){
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before opening its manuscript review.');
  if(runtime)return;
  const config=vscode.workspace.getConfiguration('manuscriptReview');
  runtime=createRuntime({extensionPath:path.join(context.extensionPath,'dist'),python:config.get('pythonPath','python3'),home:config.get('libraryDirectory',''),output});
  panel=createPanel(vscode,context,runtime,{onSource:openSource,onChange:refreshComments});
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
 function navigateReview(action){
  opening??=action().catch(async error=>{
   if(!runtime?.review){comments?.dispose();panel?.dispose();await runtime?.dispose();runtime=comments=panel=undefined;updateSourceContext();}
   throw error;
  }).finally(()=>{opening=undefined;});return opening;
 }
 function chooseReview(){return navigateReview(selectReview);}
 async function selectReview(){
  start();await panel.flush();
  const active=vscode.window.activeTextEditor?.document.uri;
  const folder=active?.scheme==='file'?path.dirname(active.fsPath):vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if(!folder)throw new Error('Open a manuscript folder in VS Code first.');
  let info=await runtime.library('/inspect',{repo:folder});
  if(info.repositories){
   const selected=await vscode.window.showQuickPick(info.repositories.map(repo=>({label:repo,repo})),{title:'Choose manuscript repository'});
   if(!selected)return;info=await runtime.library('/inspect',{repo:selected.repo});
  }
  const library=await runtime.library('/library-data'),rounds=library.reviews.filter(review=>review.repo===info.repo);
  const options=[...rounds.map((review,index)=>({label:index===0?'Current review':`Earlier review ${rounds.length-index}`,description:`${review.base_label} → ${review.proposal_label}`,review})),{label:'Open manuscript',description:'Read and annotate the current working files'}];
  const selected=rounds.length?await vscode.window.showQuickPick(options,{title:path.basename(info.repo)}):options[0];
  if(!selected)return;
  let id=selected.review?.id;
  if(!id){
   let entry=info.entries.find(file=>active?.fsPath===path.join(info.repo,file));
   if(!entry&&info.entries.length>1){const item=await vscode.window.showQuickPick(info.entries,{title:'Choose the LaTeX document to render'});if(!item)return;entry=item;}
   entry??=info.entries[0]||'';
   id=(await runtime.prepare('/manuscript',{repo:info.repo,entry})).review;
  }
  panel.dispose();decorations.clear();await runtime.open(id);watchRecord();await comments.refresh();
  await vscode.commands.executeCommand('setContext','manuscriptReview.active',true);
  updateSourceContext();
  await panel.show();
 }
 async function ensureReview(){
  if(opening)await opening;
  if(runtime?.review)return;
  await chooseReview();
  if(!runtime?.review)throw new Error('Choose a manuscript review to continue.');
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
  await ensureReview();
  return navigateReview(saveChangesRound);
 }
 async function saveChangesRound(){
  const repo=runtime.review.repo;
  if(vscode.workspace.textDocuments.some(document=>document.isDirty&&document.uri.scheme==='file'&&document.uri.fsPath.startsWith(repo+path.sep)))
   throw new Error('Save your manuscript files before comparing their changes.');
  await panel.flush();
  const result=await runtime.prepare('/update',{id:runtime.review.id,expected_revision:runtime.review.revision,require_changes:true});
  panel.dispose();decorations.clear();await runtime.open(result.review);watchRecord();await comments.refresh();await panel.show();
  updateSourceContext();
 }
 function command(name,action){subscriptions.push(vscode.commands.registerCommand('manuscriptReview.'+name,async(...args)=>{try{return await action(...args);}catch(error){fail(error);}}));}
 command('open',chooseReview);
 command('focusedReview',async()=>{await ensureReview();await panel.show();});
 command('refresh',async()=>{await ensureReview();await comments.refresh();await panel.refresh();});
 command('reviewSavedChanges',reviewSavedChanges);
 command('comment',async()=>{const editor=vscode.window.activeTextEditor;await ensureReview();await comments.annotate(editor);});
 command('previousComment',async()=>{await ensureReview();await comments.move(-1);});
 command('nextComment',async()=>{await ensureReview();await comments.move(1);});
 command('livePDF',async()=>{if(!vscode.window.activeTextEditor)throw new Error('Select a location in the LaTeX source first.');const extension=vscode.extensions.getExtension('James-Yu.latex-workshop');if(!extension)throw new Error('Install LaTeX Workshop to use source-to-PDF navigation.');await extension.activate();await vscode.commands.executeCommand('latex-workshop.synctex');});
 subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(runtime?.review&&event.document.uri.scheme==='file')refreshComments();}));
 subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(()=>{if(runtime?.review)refreshComments();}));
 subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateSourceContext));
 disposeExtension=async()=>{clearTimeout(timer);watcher?.dispose();comments?.dispose();panel?.dispose();decorations.dispose();for(const subscription of subscriptions)subscription.dispose();await runtime?.dispose();};
 context.subscriptions.push({dispose:()=>{void disposeExtension();}});
}
export function deactivate(){return disposeExtension?.();}
