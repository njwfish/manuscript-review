import path from 'node:path';
import {shellQuote} from './agent.mjs';

export const agents=[{id:'codex',label:'Codex',extension:'openai.chatgpt'},
 {id:'claude',label:'Claude Code',extension:'anthropic.claude-code'}];

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
 return `Read the Manuscript Review skill at ${path.join(skill,'SKILL.md')}. Use this exact command prefix for feedback, begin, finish, and respond: ${shellQuote(launcher)} --home ${shellQuote(home)}.
Review ${data.id} in ${data.repo}. The saved record is ${data.feedback_path}.
Address only discussion ${id}, at ${note.file}:${note.line}, including its earlier replies. Other comments are context, not additional tasks.

Author’s comment:
${note.comment}

Original quoted source (read the current manuscript before editing):
${note.before||note.proposed||''}

${scope}
Read the current feedback and repository instructions first. Use begin before any source changes, then finish to publish a reviewable round. Keep the original baseline and earlier rounds. For replies only, use the existing round. Append only your final, concise explanation to discussion ${id} using respond; keep your working conversation in this agent session. Reread feedback before responding and respect its current revision. Return the resulting review link: vscode://njwfish.manuscript-review/review/REVIEW_ID.`;
}

export async function openAgent(vscode,{agent,prompt,column}){
 const provider=agents.find(item=>item.id===agent);
 if(!provider)throw new Error('Choose Codex or Claude Code.');
 const extension=vscode.extensions.getExtension(provider.extension);
 if(!extension)throw new Error(`Install the ${provider.label} VS Code extension to open its task tab.`);
 await extension.activate();
 if(agent==='claude'){
  await vscode.commands.executeCommand('claude-vscode.editor.open',undefined,prompt,column,undefined,true);
 }else{
  const groups=['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth'];
  if(groups[column-1])await vscode.commands.executeCommand(`workbench.action.focus${groups[column-1]}EditorGroup`);
  await vscode.commands.executeCommand('chatgpt.newCodexPanel');
  await vscode.env.clipboard.writeText(prompt);
  await vscode.window.showInformationMessage('Comment request copied. Paste it into the new Codex tab, then send.');
 }
}
