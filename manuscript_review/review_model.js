// Review rules only: no DOM, network, or persistent-storage side effects.
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
  notes.push({id:item.id,author:'user',current:true,kind,file:file.path,line:passage.line,
   base:data.base,source_proposed:data.proposed,before:kind==='passage'?item.before:item.old,
   proposed:kind==='passage'?item.after:item.new,context_before:passage.before,
   comment:comments[item.id],replies:[],target:{kind,id:item.id}});
 }
 return notes;
}

export function sourceRange(file,edit,view,decisions){
 if(view==='before')return edit.base_span;
 if(view==='after')return edit.proposal_span;
 const groups=new Map(file.edits.map(group=>[group.start,group]));let offset=0,index=0;
 while(index<edit.start){const group=groups.get(index);if(group){offset+=(choiceFor(group.id,decisions)==='reject'?group.old:group.new).length;index=group.stop;}else{offset+=file.pieces[index].new.length;index++;}}
 return [offset,offset+(choiceFor(edit.id,decisions)==='reject'?edit.old:edit.new).length];
}

export function agentRequest(data,complete){
 const scope=complete?'Use my completed accept/reject decisions as the starting draft. If text changes are needed, apply these choices when necessary before beginning the pass; preserve outside edits.':'My decisions are still in progress. Respond to my comments now, and leave manuscript revisions until I finish reviewing.';
 return `Use $manuscript-review for review ${data.id} in ${data.repo}, saved at ${data.feedback_path}. Read its decisions, comments, manual edits, and earlier replies. Respond to my comments and make only the requested surgical revisions. ${scope} For text changes, use begin before editing and finish to create a new review round, then add responses there. For replies only, add responses to this review without creating a new round. Preserve the original baseline ${data.baseline} and earlier rounds, and open the result in Manuscript Review.`;
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
