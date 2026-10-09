import {randomUUID} from 'node:crypto';
import {nativeSend} from './native-send.mjs';

export const agents=[{id:'codex',label:'Codex',extension:'openai.chatgpt',tab:'chatgpt.conversationEditor'},
 {id:'claude',label:'Claude Code',extension:'anthropic.claude-code',tab:'mainThreadWebview-claudeVSCodePanel'}];

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
