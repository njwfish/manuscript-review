import path from 'node:path';

function versions(vscode,info){
 const groups=[
  ['Selected drafts',(info.checkpoints||[]).map(item=>({...item,label:item.subject,description:`${item.short}  ${item.date}`}))],
  ['Branches and tags',(info.references||[]).map(item=>({...item,label:item.name,description:item.revision.slice(0,7),detail:item.subject}))],
  ['Commits',(info.commits||[]).map(item=>({...item,label:item.subject,description:`${item.short}  ${item.date}`,detail:item.refs}))]
 ];
 return groups.flatMap(([label,items])=>items.length?[{label,kind:vscode.QuickPickItemKind.Separator},...items]:[]);
}

function pickVersion(vscode,items,current,title){
 const picker=vscode.window.createQuickPick();
 picker.title=title;picker.placeholder='Search by branch, commit message, date, or hash';
 picker.matchOnDescription=picker.matchOnDetail=true;picker.items=items;
 picker.buttons=[vscode.QuickInputButtons.Back];
 const active=items.find(item=>item.revision===current?.revision&&item.label===current?.label);
 if(active)picker.activeItems=[active];
 return new Promise(resolve=>{
  const listeners=[picker.onDidAccept(()=>{const item=picker.selectedItems[0];if(item){resolve(item);picker.hide();}}),
   picker.onDidTriggerButton(()=>picker.hide()),picker.onDidHide(()=>{resolve(undefined);listeners.forEach(listener=>listener.dispose());picker.dispose();})];
  picker.show();
 });
}

function defaults(vscode,info,entry){
 const choices=versions(vscode,info),base=choices.find(item=>item.revision===info.base)
  ||choices.find(item=>item.revision)||{label:info.base.slice(0,7),revision:info.base};
 return {info,choices,base,proposed:{label:'Working files',revision:'working',detail:'Saved tracked files, including staged new files'},
  entry:entry||info.checkpoints?.[0]?.entry||info.entries[0]||''};
}

/** One native overview keeps the pair visible while either endpoint is changed. */
export async function chooseComparison(vscode,{info,entry,chooseRepository,fetch}){
 let state=defaults(vscode,info,entry);
 while(true){
  const {info,choices,base,proposed,entry}=state;
  const nextRound=Boolean(base.review);
  const options=[
   {label:'Review changes',description:`${base.label} → ${proposed.label}`,detail:nextRound?'New round, preserving the original baseline and discussion.':'New comparison, with the starting version as its baseline.',action:'review'},
   {label:'From',description:base.label,detail:`Starting wording   ${base.revision.slice(0,7)}`,action:'base'},
   {label:'To',description:proposed.label,detail:proposed.revision==='working'?'Saved tracked files. The review captures a fixed snapshot.':`Proposed wording   ${proposed.revision.slice(0,7)}`,action:'proposed'},
   ...(info.entries.length?[{label:'PDF document',description:entry||'Source only',action:'entry'}]:[]),
   {label:'Folder',description:info.workspace||info.repo,action:'repository'},
   ...(info.has_origin?[{label:'Fetch latest commits',detail:'Updates Git history; keeps your selected versions and working files.',action:'fetch'}]:[])
  ];
  const selected=await vscode.window.showQuickPick(options,{title:`Compare versions: ${path.basename(info.repo)}`,matchOnDescription:true});
  if(!selected)return;
  const actions={
   review:()=>state,
   base:async()=>{const item=await pickVersion(vscode,choices,base,`From: starting wording in ${path.basename(info.repo)}`);if(item)state.base=item;},
   proposed:async()=>{const item=await pickVersion(vscode,[state.proposed.revision==='working'?state.proposed:{label:'Working files',revision:'working',detail:'Saved tracked files, including staged new files'},...choices],proposed,`To: proposed wording in ${path.basename(info.repo)}`);if(item)state.proposed=item;},
   entry:async()=>{const item=await vscode.window.showQuickPick([...info.entries,'Source only'],{title:'PDF document',placeHolder:entry||'Source only'});if(item!==undefined)state.entry=item==='Source only'?'':item;},
   repository:async()=>{const next=await chooseRepository();if(next)state=defaults(vscode,next);},
   fetch:async()=>{const updated=await fetch(info.workspace||info.repo);if(updated){state.info=updated;state.choices=versions(vscode,updated);}}
  };
  const result=await actions[selected.action]();
  if(result)return result;
 }
}

export function comparisonRequest({info,base,proposed,entry}){
 return {repo:info.repo,...(info.workspace?{workspace:info.workspace}:{}),base:base.revision,base_label:base.label,proposed:proposed.revision,proposed_label:proposed.label,entry,
  ...(base.review?{previous:base.review,expected_revision:base.review_revision,require_changes:true}:{})};
}
