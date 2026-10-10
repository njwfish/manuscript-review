// Review rules only: no DOM, network, or persistent-storage side effects.
export function comparisonContext(data){
 const label=(name,revision)=>name?name.replace(/ \([a-f0-9]{7,40}\)$/,''):revision.slice(0,7);
 const from=label(data.base_label,data.base),to=label(data.proposal_label,data.proposed);
 return {from,to,title:`${data.repo}\nFrom: ${from} (${data.base})\nTo: ${to} (${data.proposed})\n${data.scope==='baseline'?'Original baseline to your selected manuscript.':'Starting draft to the proposed draft, before accept/reject decisions.'}`};
}

export const choiceFor=(id,decisions)=>decisions[id]||'pending';
export function selectedSource(file,decisions){
 if(file.status==='new'&&choiceFor(file.edits[0].id,decisions)==='reject')return null;
 if(file.status==='deleted'&&choiceFor(file.edits[0].id,decisions)!=='reject')return null;
 const groups=new Map(file.edits.map(group=>[group.start,group]));
 let text='',index=0;
 while(index<file.pieces.length){
  const group=groups.get(index);
  if(group){text+=choiceFor(group.id,decisions)==='reject'?group.old:group.new;index=group.stop;}
  else{text+=file.pieces[index].new;index++;}
 }
 return text;
}

export const editLocations=snapshot=>snapshot.files.flatMap((file,fi)=>file.hunks.flatMap((hunk,hi)=>hunk.edits.map((group,ei)=>[fi,hi,ei])));
export function reviewPosition(file,hunk,group){
 const hunks=file?.hunks||[];
 for(let hi=0;hi<hunks.length;hi++){const ei=hunks[hi].edits.findIndex(item=>item.id===group?.id);if(ei>=0)return [hi,ei];}
 const nearest=(items,anchor)=>items.reduce((best,item,index)=>Math.abs((item.base_span?.[0]||0)-anchor)<Math.abs((items[best]?.base_span?.[0]||0)-anchor)?index:best,0);
 let hi=hunks.findIndex(item=>item.id===hunk?.id);
 if(hi<0)hi=nearest(hunks,group?.base_span?.[0]??hunk?.base_span?.[0]??0);
 return [hi,nearest(hunks[hi]?.edits||[],group?.base_span?.[0]??0)];
}
export function reviewProgress(files,decisions){
 const edits=files.flatMap(file=>file.edits),done=edits.filter(edit=>choiceFor(edit.id,decisions)!=='pending').length;
 return {total:edits.length,done,complete:done===edits.length};
}
export function manuscriptReviews(reviews){
 const manuscripts=new Map();
 for(const review of [...reviews].sort((a,b)=>b.created.localeCompare(a.created))){
  if(!manuscripts.has(review.repo))manuscripts.set(review.repo,[]);
  manuscripts.get(review.repo).push(review);
 }
 return [...manuscripts.values()];
}
export const feedbackForPassage=(history,hunk)=>{
 const ids=new Set([hunk?.id,...(hunk?.edits||[]).map(group=>group.id)]);
 return history.filter(entry=>ids.has(entry.target?.id));
};


export function currentFeedback(data,comments){
 const notes=[];
 for(const file of data.files)for(const passage of file.hunks)for(const [item,kind] of [[passage,'passage'],...passage.edits.map(edit=>[edit,'edit'])]){
  if(!comments[item.id]?.trim())continue;
  notes.push({id:item.id,origin_id:`${data.id}:${item.id}`,author:'user',current:true,kind,file:file.path,line:passage.line,
   base:data.base,source_proposed:data.proposed,before:kind==='passage'?item.before:item.old,
   proposed:kind==='passage'?item.after:item.new,context_before:passage.before,
   comment:comments[item.id],replies:[],target:{kind,id:item.id}});
 }
 return notes;
}

export function discussionGroups(entries){
 const groups=new Map();
 for(const entry of entries){
  if(!entry.comment.trim())continue;
  const origin=entry.origin_id||entry.id;
  if(!groups.has(origin))groups.set(origin,[]);
  groups.get(origin).push(entry);
 }
 return [...groups.values()];
}

export function commentThreads(data,comments){
 return discussionGroups([...data.history,...currentFeedback(data,comments)]).map(messages=>{
  const first=messages[0],latest=messages.at(-1),origin=latest.origin_id||latest.id;
  return {...latest,origin_id:origin,line:first.line,resolved:threadResolved(data,latest)};
 }).sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
}

export const threadResolved=(data,entry)=>new Set(data.resolved).has(entry.origin_id||entry.id);

export function commentShortcut(event){
 if(!(event.metaKey||event.ctrlKey)||!event.shiftKey||event.altKey||event.repeat)return 0;
 return {BracketLeft:-1,BracketRight:1}[event.code]||0;
}

export function sourceRange(file,edit,view,decisions){
 if(view==='before')return edit.base_span;
 if(view==='after')return edit.proposal_span;
 const groups=new Map(file.edits.map(group=>[group.start,group]));let offset=0,index=0;
 while(index<edit.start){const group=groups.get(index);if(group){offset+=(choiceFor(group.id,decisions)==='reject'?group.old:group.new).length;index=group.stop;}else{offset+=file.pieces[index].new.length;index++;}}
 return [offset,offset+(choiceFor(edit.id,decisions)==='reject'?edit.old:edit.new).length];
}

export function agentRequest(data){
 const tools=data.agent_launcher?` Agent commands are bundled at ${data.agent_launcher}.`:'';
 return `Use $manuscript-review for review ${data.id} in ${data.workspace||data.repo}, saved at ${data.feedback_path}.${tools} Read its decisions, unresolved threads, manual edits, and earlier replies. Respond to unresolved feedback and make only the requested surgical revisions. Treat existing prose as settled wording; a style guide alone does not authorize rewriting it. I may keep reviewing and editing while you work. For text changes, use begin --parallel before editing and work in its returned workspace. Follow the repository’s Git workflow, run its checks, and use finish --workspace with the returned starting_version to accumulate your changes into this review. New changes remain undecided; leave my source files and buffers untouched. For replies only, use this review. Reread feedback before appending your final responses, identifying the published revision. Preserve thread resolution, the original baseline ${data.baseline}, and earlier rounds. The author decides when a thread is resolved and when to apply the review.`;
}

export function decisionShortcut(event){
 const value={a:'accept',s:'reject',u:'pending'}[event.key.toLowerCase()];
 if(!value||event.metaKey||event.altKey||event.repeat)return null;
 return {value,scope:event.ctrlKey?'file':event.shiftKey?'passage':'edit'};
}

export function editContext(passage,index,limit=180){
 const segments=passage.grouped_segments,at=segments.findIndex(segment=>segment.id===passage.edits[index].id);
 const before=segments[at-1]?.text||'',after=segments[at+1]?.text||'';
 const trimBefore=before.length>limit,trimAfter=after.length>limit;
 return {before:trimBefore?before.slice(-limit).replace(/^\S*\s+/,''):before,
  after:trimAfter?after.slice(0,limit).replace(/\s+\S*$/,''):after,
  leading:Boolean(passage.leading||at>1||trimBefore),trailing:Boolean(passage.trailing||at<segments.length-2||trimAfter),
  trimmed:at>1||at<segments.length-2||trimBefore||trimAfter};
}
