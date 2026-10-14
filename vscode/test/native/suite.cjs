const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),{execFileSync}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<300;i++){if(await predicate())return;await delay(30);}throw new Error('Native workflow timed out.');}
exports.run=async()=>{
 const state=await vscode.extensions.getExtension('review-test.native-workflow').activate();
 const {fixture,document}=state;let editor=state.editor;
 const sourceColumn=editor.viewColumn;
 const engine=(script,...args)=>JSON.parse(execFileSync(fixture.python,['-c',script,fixture.home,fixture.review,...args],{cwd:fixture.package+'/dist/runtime',encoding:'utf8'}));
 const record=async()=>JSON.parse(await fs.readFile(fixture.home+'/reviews/'+fixture.review+'/review.json','utf8'));
 const inspect=async(stage)=>{
  await fs.writeFile(fixture.root+'/visual-'+stage+'-ready','');console.log('Visual '+stage+' fixture ready: '+fixture.root);
  for(let i=0;i<2400;i++){
   try{await fs.access(fixture.root+'/continue-'+stage);break;}catch{}
   await delay(200);
  }
 };
 assert.equal(document.getText(),fixture.text);
 if(process.env.MR_NATIVE_VISUAL==='review')await inspect('startup');
 // Dispatch is detached, saves the native thread, and preserves dirty source.
 editor.selection=new vscode.Selection(document.positionAt(0),document.positionAt(24));
 const thread=await state.comments.annotate(editor);
 await until(()=>state.runtime?.review?.id===fixture.review);await state.comments.refresh();
 assert.equal(thread.range.isEmpty,true);
 assert.equal(thread.range.start.line,1);
 if(process.env.MR_NATIVE_VISUAL==='comment')await inspect('comment');
 // Composition stays in the sidebar; the manuscript remains the sole text editor.
 const initial=state.comments.input();assert.equal(initial.editing,false);
 assert.equal(thread.comments.length,0);assert.equal(thread.canReply,false);
 state.comments.editInput(initial.id,'Typing in a comment');
 assert.equal(document.getText(),fixture.text);assert.equal(document.isDirty,false);
 const began=performance.now();
 assert.equal(await state.comments.submitInput(initial.id,'Keep this surgical.',true),true);
 const dispatchMs=performance.now()-began;
 assert.equal(document.getText(),fixture.text);assert.equal(document.isDirty,false);
 // Set authoring through the existing explicit workflow, then emulate a completed CLI task.
 assert.equal((await record()).metadata.authoring,true);
 const original=(await record()).baseline;
 const task=engine("import sys,json;from manuscript_review.library import Library;print(json.dumps(Library(sys.argv[1]).begin(sys.argv[2],parallel=True)))");
 let authorText=fixture.text.replace('the explanation','the concise explanation');
 let typing=document.getText().indexOf('the explanation');
 await editor.edit(builder=>builder.replace(new vscode.Range(document.positionAt(typing),document.positionAt(typing+15)),'the concise explanation'));
 assert.equal(document.isDirty,true);
 const second=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.repo+'/second.tex'));
 const target=task.workspace+'/main.tex';await fs.writeFile(target,fixture.text.replace('measured','observed'));
 await fs.writeFile(task.workspace+'/second.tex','We retain useful context.\n');
 engine("import sys,json;from manuscript_review.library import Library;print(json.dumps(Library(sys.argv[1]).finish_parallel(sys.argv[2],sys.argv[3],sys.argv[4])))",task.starting_version,task.workspace);
 await until(()=>second.getText().includes('useful')&&!second.isDirty);
 assert.equal(document.getText(),authorText);assert.equal(document.isDirty,true);
 await document.save();
 await until(()=>document.getText().includes('observed')&&!document.isDirty);
 // Automatic highlights must not silently turn subsequent drafting into refinement.
 typing=document.getText().indexOf('the concise explanation');
 await editor.edit(builder=>builder.replace(new vscode.Range(document.positionAt(typing),document.positionAt(typing+23)),'the concise, explicit explanation'));
 authorText=authorText.replace('the concise explanation','the concise, explicit explanation');
 await document.save();
 await until(async()=>execFileSync('git',['show',(await record()).snapshot.base+':main.tex'],{cwd:fixture.repo,encoding:'utf8'})===authorText);
 const authorBase=(await record()).snapshot.base;
 assert.equal(execFileSync('git',['show',authorBase+':main.tex'],{cwd:fixture.repo,encoding:'utf8'}),authorText);
 await until(async()=> (await record()).metadata.workspace_version!==(await record()).snapshot.base);
 await vscode.commands.executeCommand('manuscriptReview.focusedReview');
 await vscode.commands.executeCommand('manuscriptReview.refresh');
 assert.equal(vscode.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.label.startsWith('Review:')),false,'Review must use native source without another text tab');
 // C opens the same sidebar composer for edits and anchored follow-ups.
 const root=(await record()).history.find(entry=>entry.comment==='Keep this surgical.');
 await state.comments.refresh();
 editor.selection=new vscode.Selection(document.positionAt(document.getText().indexOf('observed')),document.positionAt(document.getText().indexOf('observed')));
 await vscode.commands.executeCommand('manuscriptReview.focusedReview');
 await vscode.commands.executeCommand('manuscriptReview.commentChange');
 const originalInput=state.comments.input();assert.equal(originalInput.editing,true);
 assert.equal(originalInput.body,'Keep this surgical.');
 const sourceBeforeRootEdit=document.getText();
 if(process.env.MR_NATIVE_VISUAL==='review')await inspect('root-submit');
 else await state.comments.submitInput(originalInput.id,'Keep this surgical. Add context.');
 await until(async()=> (await record()).history.find(entry=>entry.id===root.id)?.comment==='Keep this surgical. Add context.');
 assert.equal(document.getText(),sourceBeforeRootEdit);
 await until(async()=> (await vscode.commands.executeCommand('vscode.executeCodeLensProvider',document.uri))?.some(lens=>lens.command?.title==='Next F'));
 engine("import sys,json;from manuscript_review.library import Library;from manuscript_review.session import ReviewSession;s=ReviewSession(Library(sys.argv[1]).directory(sys.argv[2]));r=s.store.read();s.import_responses([{'id':sys.argv[3],'text':'Updated the wording.'}],r['revision']);print(json.dumps({'ready':True}))",root.id);
 await state.comments.refresh();
 await vscode.commands.executeCommand('manuscriptReview.focusedReview');
 const discussion=await vscode.commands.executeCommand('manuscriptReview.commentChange');
 const followup=state.comments.input();assert.equal(followup.editing,false);
 state.comments.editInput(followup.id,'Additional');
 const sourceBeforeComment=document.getText();
 editor=await vscode.window.showTextDocument(document,{viewColumn:sourceColumn,preserveFocus:false});
 await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
 await vscode.commands.executeCommand('manuscriptReview.commentChange');
 assert.equal(state.comments.input().id,followup.id);assert.equal(state.comments.input().body,'Additional');
 await state.comments.submitInput(followup.id,'Additional feedback from C',true);
 await until(async()=> (await record()).history.some(entry=>entry.comment==='Additional feedback from C'));
 assert.equal(document.getText(),sourceBeforeComment);
 assert.equal((await record()).history.at(-1).origin_id,root.origin_id);
 await until(async()=> (await vscode.commands.executeCommand('vscode.executeCodeLensProvider',document.uri))?.some(lens=>lens.command?.title==='Next F'));
 if(process.env.MR_NATIVE_VISUAL==='review'){
  discussion.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
  editor=await vscode.window.showTextDocument(document,{viewColumn:sourceColumn,preserveFocus:false});
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('manuscriptReview.focusedReview');
  await inspect('review');
 }
 editor=await vscode.window.showTextDocument(document,{viewColumn:sourceColumn,preserveFocus:false});
 let at=document.getText().indexOf('observed');
 await editor.edit(builder=>builder.replace(new vscode.Range(document.positionAt(at),document.positionAt(at+8)),'recorded'));
 await document.save();
 await until(async()=> (await record()).snapshot.files.some(file=>file.edits.some(edit=>edit.new==='recorded')));
 assert.equal((await record()).snapshot.base,authorBase);assert.equal((await record()).baseline,original);
 assert.equal(document.getText(),authorText.replace('measured','recorded'));
 await state.comments.refresh();
 at=document.getText().indexOf('recorded');editor.selection=new vscode.Selection(document.positionAt(at),document.positionAt(at));
 let lenses;await until(async()=>{lenses=await vscode.commands.executeCommand('vscode.executeCodeLensProvider',document.uri);return lenses?.some(lens=>lens.command?.command==='manuscriptReview.decideSource');});
 const reject=lenses.find(lens=>lens.command?.command==='manuscriptReview.decideSource'&&lens.command.arguments.at(-1)==='reject');
 await vscode.commands.executeCommand(reject.command.command,...reject.command.arguments);
 await until(()=>document.getText()===authorText&&!document.isDirty);
 assert.equal((await record()).snapshot.base,authorBase);
 assert.equal((await record()).history.find(entry=>entry.id===root.id).comment,'Keep this surgical. Add context.');
 editor=await vscode.window.showTextDocument(document,{viewColumn:sourceColumn,preserveFocus:false});
 await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
 await vscode.commands.executeCommand('undo');
 await until(()=>document.getText()===authorText.replace('measured','recorded'));
 await document.save();
 await until(()=>document.getText().includes('recorded')&&!document.isDirty);
 await vscode.commands.executeCommand('manuscriptReview.focusedReview');
 await vscode.commands.executeCommand('manuscriptReview.nextChange');
 await state.runtime.request('/pdf-entry',{entry:'pdf.tex'});
 // Verify real webview transport and PDF.js rendering with a synthetic selected PDF.
 const selected=await record(),edit=selected.snapshot.files.find(file=>file.path==='main.tex').edits[0];
 const lines=document.getText().trim().split('\n').filter(Boolean),content='BT /F1 12 Tf 36 700 Td '+lines.map((line,index)=>(index?'0 -24 Td ':'')+'('+line.replace(/[\\()]/g,'\\$&')+') Tj').join(' ')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>','<< /Length '+Buffer.byteLength(content)+' >>\nstream\n'+content+'\nendstream'];
 let bytes='%PDF-1.4\n',offsets=[0];objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(bytes));bytes+=(index+1)+' 0 obj\n'+value+'\nendobj\n';});
 const xref=Buffer.byteLength(bytes);bytes+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
 const preview=fixture.home+'/reviews/'+fixture.review+'/selected-renders';await fs.mkdir(preview,{recursive:true});await fs.writeFile(preview+'/native-test.pdf',bytes);
 engine("import sys,json;from pathlib import Path;from manuscript_review.library import Library;from manuscript_review.storage import atomic_json;from manuscript_review.render_latex import RENDER_VERSION;from manuscript_review.session import ReviewSession;session=ReviewSession(Library(sys.argv[1]).directory(sys.argv[2]));record=session.store.read();atomic_json(session.directory/'selected-renders/manifest.json',{'base':record['snapshot']['base'],'proposed':record['result'],'proposal':record['snapshot']['proposed'],'entry':record['snapshot']['entry'],'renderer':RENDER_VERSION,'documents':{'after':{'pdf':'native-test.pdf','pages':[{'width':612,'height':792}],'edits':{edit['id']:[{'page':1,'bounds':[90,80,138,96]}] for file in record['snapshot']['files'] for edit in file['edits']}}}});record['metadata']['selected_preview_status']='ready';session.store.patch({'metadata':record['metadata']});print(json.dumps({'ready':True}))",edit.id);
 const pairedSource=vscode.window.activeTextEditor.document.uri.fsPath,pairedColumn=vscode.window.activeTextEditor.viewColumn;
 await vscode.commands.executeCommand('manuscriptReview.reviewPDF');
 await until(()=>state.pdfMessages.some(message=>message.type==='rendered')).catch(async error=>{await fs.writeFile(fixture.root+'/pdf-messages.json',JSON.stringify(state.pdfMessages));throw error;});
 const pdfGroup=vscode.window.tabGroups.all.find(group=>group.tabs.some(tab=>tab.label.startsWith('PDF: ')));
 assert.equal(vscode.window.visibleTextEditors.some(editor=>editor.document.uri.fsPath===pairedSource&&editor.viewColumn===pairedColumn),true,'Paired PDF must keep source visible');
 assert.equal(state.pdfMessages.filter(message=>message.direction==='out'&&message.type==='document').at(-1).marks.length,1,'Selected edit must be highlighted in PDF');
 assert.equal(pdfGroup.viewColumn,pairedColumn+1,'PDF must sit beside source');
 if(process.env.MR_NATIVE_VISUAL==='pdf')await inspect('pdf');
 assert.equal(state.pdfMessages.some(message=>message.type==='error'),false,'The real PDF webview must decode and render selected PDF bytes');
 assert.equal(vscode.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.label.startsWith('Review:')),false);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:fixture.repo,encoding:'utf8'}).trim(),fixture.head);
 assert.equal(execFileSync('git',['diff','--cached','--name-only'],{cwd:fixture.repo,encoding:'utf8'}).trim(),'');
 await state.actual.deactivate();
 await fs.writeFile(fixture.root+'/passed.json',JSON.stringify({nativeDispatchMs:dispatchMs,manualRefinementKeepsBase:true,inlineDecisionAndUndo:true,singleNativeReviewEditor:true,selectedPDFRendered:true,dirtyFileDoesNotBlockCleanDelivery:true,typingDuringDeliveryRemainsAuthoring:true,deliveryPreservesEditingIntent:true,sourceAndGitPreserved:true}));
};
