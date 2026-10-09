import path from 'node:path';
import {comparisonContext} from '../../manuscript_review/review_model.js';

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
 picker.matchOnDescription=picker.matchOnDetail=true;
 const active=items.find(item=>item.revision===current.revision&&item.label===current.label)||current;
 picker.items=items.includes(active)?items:[active,...items];picker.activeItems=[active];
 return new Promise(resolve=>{
  const listeners=[picker.onDidAccept(()=>{const item=picker.selectedItems[0];if(item){resolve(item);picker.hide();}}),
   picker.onDidHide(()=>{resolve(undefined);listeners.forEach(listener=>listener.dispose());picker.dispose();})];
  picker.show();
 });
}

export function comparisonState(vscode,info,entry){
 const choices=versions(vscode,info),base=choices.find(item=>item.revision===info.base)
  ||choices.find(item=>item.revision)||{label:info.base.slice(0,7),revision:info.base};
 return {info,choices,base,proposed:{label:'Working files',revision:'working',detail:'Saved tracked files, including staged new files'},
  entry:entry||info.checkpoints?.[0]?.entry||info.entries[0]||''};
}

export function reviewComparison(state,data){
 const labels=comparisonContext(data);
 const checkpoint=state.choices.find(item=>item.revision===data.base&&item.review);
 const base={...checkpoint,revision:data.base,label:labels.from};
 return {...state,base,proposed:{revision:data.proposed,label:labels.to},entry:data.entry||''};
}

export function comparisonMatches(state,data){
 return Boolean(state&&data&&!state.pending&&state.info.repo===data.repo
  &&(state.info.workspace||state.info.repo)===(data.workspace||data.repo)
  &&state.base.revision===data.base&&state.proposed.revision===data.proposed&&state.entry===(data.entry||''));
}

export function refreshComparison(vscode,state,info){
 const choices=versions(vscode,info);
 const pinned=item=>{
  const found=choices.find(choice=>choice.revision===item.revision&&choice.review===item.review&&(item.review||choice.label===item.label));
  return found?{...found,label:item.label}:item;
 };
 return {...state,info,choices,base:pinned(state.base),proposed:pinned(state.proposed)};
}

export async function changeComparison(vscode,state,field){
 const {info,choices,base,proposed,entry}=state;
 const name=path.basename(info.repo);
 const actions={
  base:()=>pickVersion(vscode,choices,base,`From: ${name}`),
  proposed:()=>pickVersion(vscode,[{label:'Working files',revision:'working',detail:'Saved tracked files, including staged new files'},...choices],proposed,`To: ${name}`),
  entry:()=>vscode.window.showQuickPick([...info.entries,'Source only'],{title:'PDF document',placeHolder:entry||'Source only'})
 };
 if(!Object.hasOwn(actions,field))throw new Error('Choose a comparison field.');
 const choice=await actions[field]();
 if(choice===undefined)return state;
 const value=field==='entry'?(choice==='Source only'?'':choice):choice;
 if(field==='entry'?value===entry:value.revision===state[field].revision&&value.review===state[field].review&&value.label===state[field].label)
  return field==='entry'||value===state[field]?state:{...state,[field]:value};
 return {...state,[field]:value,pending:true};
}

export function comparisonRequest({info,base,proposed,entry}){
 return {repo:info.repo,...(info.workspace?{workspace:info.workspace}:{}),base:base.revision,base_label:base.label,proposed:proposed.revision,proposed_label:proposed.label,entry,
  ...(base.review?{previous:base.review,expected_revision:base.review_revision,require_changes:true}:{})};
}
