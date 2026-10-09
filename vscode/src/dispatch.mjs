import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {shellQuote} from './agent.mjs';
import {nativeSend} from './native-send.mjs';

export const agents=[{id:'codex',label:'Codex',extension:'openai.chatgpt',tab:'chatgpt.conversationEditor'},
 {id:'claude',label:'Claude Code',extension:'anthropic.claude-code',tab:'mainThreadWebview-claudeVSCodePanel'}];

/** A task contains one saved comment, its context, and instructions to return one final reply. */
export function commentTask(data,report,identifier,{launcher,skill,dirty=false}){
 const note=report.comments.find(item=>item.id===identifier||item.discussion_id===identifier)
  ||report.history.find(item=>item.id===identifier);
 if(!note?.comment.trim())throw new Error('Save this comment before sending it to an agent.');
 const id=note.discussion_id||note.id;
 const home=path.dirname(path.dirname(path.dirname(data.feedback_path)));
 const complete=report.edits.every(edit=>edit.decision!=='pending');
 const scope=dirty?'The manuscript has unsaved editor text. Think through this comment and reply without changing files.'
  :!complete?'The author is still reviewing this round. Think through this comment and reply without changing manuscript files or decisions.'
  :'Work through this comment. Make only the surgical source changes it requires, preserving the author’s wording. Do not apply review decisions automatically.';
 const prompt=`Address only discussion ${id}, at ${note.file}:${note.line}, including its earlier replies. Other comments are context, not additional tasks.
Read the Manuscript Review skill at ${path.join(skill,'SKILL.md')}. Use this exact command prefix for feedback, begin, finish, and respond: ${shellQuote(launcher)} --home ${shellQuote(home)}.
Review ${data.id} in ${data.repo}. The saved record is ${data.feedback_path}.

Author’s comment:
${note.comment}

Original quoted source (read the current manuscript before editing):
${note.before||note.proposed||''}

${scope}
Read the current feedback and repository instructions first. Use begin before any source changes, follow the repository’s Git workflow, run its checks, then finish to publish a reviewable revision. Keep the original baseline and earlier rounds. For replies only, use the existing round. Append only your final, concise explanation to discussion ${id} using respond; identify the published revision when wording changes, and keep your working conversation in this agent session. Preserve thread resolution and review decisions; the author owns both. Reread feedback before responding and respect its current revision. Return the resulting review link: vscode://njwfish.manuscript-review/review/REVIEW_ID.`;
 return {prompt,discussion:id};
}

export async function openAgent(vscode,{agent,prompt,discussion,column,helper,signal,submit=nativeSend}){
 const provider=agents.find(item=>item.id===agent);
 if(!provider)throw new Error('Choose Codex or Claude Code.');
 const extension=vscode.extensions.getExtension(provider.extension);
 if(!extension)throw new Error(`Install the ${provider.label} VS Code extension to open its task tab.`);
 await extension.activate();
 let openedTab,tabObserver;
 const open=async(track=false)=>{
  if(signal?.aborted)throw new Error('The native agent request was cancelled.');
  if(track)tabObserver=vscode.window.tabGroups.onDidChangeTabs(({opened})=>{
   openedTab??=opened.find(tab=>tab.group.viewColumn===column&&tab.input?.viewType===provider.tab);
  });
  if(agent==='claude')await vscode.commands.executeCommand('claude-vscode.editor.open',undefined,prompt,column,undefined,true);
  else{
   const uri=vscode.Uri.from({scheme:'openai-codex',authority:'route',path:'/',query:`manuscriptReview=${randomUUID()}`});
   await vscode.commands.executeCommand('vscode.openWith',uri,'chatgpt.conversationEditor',{viewColumn:column,preserveFocus:false,preview:false});
  }
 };
 let permission;
 if(helper){
  try{await submit(helper,{extension:provider.extension,prompt,discussion},()=>open(true),{signal});return openedTab;}
  catch(error){if(!['permission','ENOENT'].includes(error.code))throw error;permission=error;}
  finally{tabObserver?.dispose();}
 }
 await open();
 if(agent==='codex'){
  await vscode.env.clipboard.writeText(prompt);
 }
 const message=agent==='codex'?'Comment request copied. Paste it into the new Codex tab, then send.':'Comment request ready in Claude Code. Press Send to start.';
 if(permission)await vscode.window.showWarningMessage(permission.message+' '+message);
 else await vscode.window.showInformationMessage(message);
 return false;
}
