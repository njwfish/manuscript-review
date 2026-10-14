import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {commentThreads,currentFeedback,discussionGroups} from '../../manuscript_review/review_model.js';
import {snapshotFile,snapshotVersion} from './source-documents.mjs';

export function sourceDocument(document){
 return document?.uri.scheme==='file'&&['.tex','.bib','.md','.txt','.typ','.rst'].includes(path.extname(document.uri.fsPath));
}

export function sourceFile(review,document){
 const snapshot=snapshotFile(review,document);if(snapshot)return snapshot;
 if(!review||!sourceDocument(document))return null;
 const relative=path.relative(review.workspace||review.repo,document.uri.fsPath);
 return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)
  ?relative.split(path.sep).join('/'):null;
}

export function createComments(vscode,getRuntime,{openDocument,onChange,onReview,onProjection,onAgent,onSource,onInputComplete,onInput,canComment=document=>sourceDocument(document)||document?.uri.scheme==='manuscript-review-source'}={}) {
  const controller=vscode.comments.createCommentController('manuscript-review','Manuscript Review');
  const subscriptions=[controller],threads=new Map(),pending=new Set();
  let generation=0,inputEpoch=0,disposed=false,activeThread,includeResolved=false,enabled=true;
  let refreshing,requested=false,needsData=false,cachedData,cachedRuntime,cachedFile,selectedFile,activeInput;
  const projected=new WeakMap();

  const fileFor=document=>sourceFile(getRuntime()?.review,document);
  const threadKey=(reviewId,uri,origin)=>JSON.stringify([reviewId,uri.toString(),origin]);

  function checkReview(state) {
    if(disposed)throw new Error('Manuscript Review has closed.');
    if(state.reviewId!==getRuntime()?.review?.id)throw new Error('Return to this comment’s review before continuing.');
  }

  function command(name,handler) {
    subscriptions.push(vscode.commands.registerCommand(`manuscriptReview.${name}`,async(...args)=>{
      try{return await handler(...args);}
      catch(error){await vscode.window.showErrorMessage(error.message);return false;}
    }));
  }

  const documentFor=file=>openDocument(file);

  async function project(document) {
    if(!fileFor(document))await onSource?.(document);
    const runtime=getRuntime();
    const review=runtime?.review,file=fileFor(document),reviewId=review?.id;
    if(!file)throw new Error('Choose a source file in the reviewed repository.');
    const version=document.version,cached=projected.get(document);
    if(cached?.runtime===runtime&&cached.value.reviewId===reviewId&&cached.value.revision===runtime.review.revision
      &&cached.value.documentVersion===version)return cached.value;
    const text=document.getText(),saved=snapshotVersion(document);
    const result=await runtime.request('/editor',{file,text,...(saved?{version:saved}:{})});
    if(getRuntime()!==runtime||runtime?.review?.id!==reviewId||document.version!==version||document.getText()!==text)
      throw Object.assign(new Error('The source changed while locating this comment. Try again.'),{code:'SourceChanged'});
    const value={...result,file,text,document,documentVersion:version,reviewId};
    projected.set(document,{runtime,value});
    return value;
  }

  function rangeFor(entry,projection) {
    const item=projection.notes.find(note=>note.id===entry.id)
      ||(entry.target?.kind==='edit'?projection.ranges:projection.passages)
        .find(item=>item.id===entry.target?.id);
    return item?new vscode.Range(projection.document.positionAt(item.from),projection.document.positionAt(item.to)):undefined;
  }

  function makeThread(document,range,comments=[]) {
    const thread=controller.createCommentThread(document.uri,markerRange(document,range),comments);
    thread.contextValue='manuscriptReview';
    thread.canReply=false;
    thread.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
    return thread;
  }

  function markerRange(document,range) {
    if(!range)return range;
    const lastLine=range.end.character===0&&range.end.line>range.start.line?range.end.line-1:range.end.line;
    let point=lastLine<range.end.line?document.lineAt(lastLine).range.end:range.end;
    // Native whole-line icons repeat on wrapped rows. Paragraph breaks do not wrap.
    if(lastLine+1<document.lineCount&&document.lineAt(lastLine+1).isEmptyOrWhitespace)point=document.lineAt(lastLine+1).range.start;
    else if(range.start.line>0&&document.lineAt(range.start.line-1).isEmptyOrWhitespace)point=document.lineAt(range.start.line-1).range.start;
    return new vscode.Range(point,point);
  }

  function suspendThread(state) {
    if(state.thread.label!=='Other review')state.restoreCollapse=state.thread.collapsibleState;
    state.thread.label='Other review';state.thread.contextValue='manuscriptReview.other';
    state.thread.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
  }

  function resumeThread(state) {
    if(state.thread.label==='Other review') {
      state.thread.collapsibleState=state.restoreCollapse;delete state.restoreCollapse;
    }
    const resolved=Boolean(state.entry?.resolved);
    state.thread.label=resolved?'Resolved':undefined;
    state.thread.contextValue=state.entry?(resolved?'manuscriptReview.resolved':'manuscriptReview'):'manuscriptReview.pending';
    const status=resolved?vscode.CommentThreadState.Resolved:vscode.CommentThreadState.Unresolved;
    if(resolved&&state.thread.state!==status)state.thread.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
    state.thread.state=status;
  }

  function commentsFor(state,entries) {
    const old=state.thread.comments,comments=[];
    let changed=false;
    for(const entry of entries) {
      const latest=entry===entries.at(-1);
      const editable=latest&&(entry.current||(entry.kind==='source'&&entry.author==='user'&&!entry.replies.length));
      const values=[{id:entry.id,text:entry.comment,author:entry.author,entry,editable},
        ...entry.replies.map(reply=>({id:reply.id,text:reply.text,author:'agent',entry,editable:false}))];
      for(const value of values) {
        let comment=old.find(comment=>comment.id===value.id);
        // A response pins a current note as history, preserving its draft identity.
        if(!comment&&value.id===entry.id&&!entry.current&&entry.author==='user'&&entry.origin_id)
          comment=old.find(comment=>comment.current&&comment.entry.origin_id===entry.origin_id&&comment.savedBody===value.text);
        if(!comment) {
          comment={id:value.id,body:value.text,savedBody:value.text,mode:vscode.CommentMode.Preview,
            author:{name:value.author==='user'?'You':'Agent'},parent:state.thread};
          changed=true;
        }
        if(state.draft?.comment===comment) {
          comment.conflict=!value.editable||comment.savedBody!==value.text;
          if(!comment.conflict)comment.editRevision=state.data.revision;
        } else {
          changed ||= comment.body!==value.text||comment.contextValue!==(value.editable?'manuscriptReview.editable':undefined);
          comment.body=comment.savedBody=value.text;
          comment.conflict=false;
          comment.contextValue=value.editable?'manuscriptReview.editable':undefined;
        }
        Object.assign(comment,{id:value.id,entry:value.entry,current:Boolean(value.entry.current),editable:value.editable});
        comments.push(comment);
      }
    }
    if(changed||comments.length!==old.length||comments.some((comment,index)=>comment!==old[index]))
      state.thread.comments=comments;
  }

  async function update(ticket) {
    const runtime=getRuntime();
    const review=runtime?.review;
    if(!review||disposed)return;
    if(needsData||cachedRuntime!==runtime||cachedData?.id!==review.id||cachedData.revision!==review.revision||cachedFile!==selectedFile){
      needsData=false;
      cachedData=await runtime.data(selectedFile);cachedRuntime=runtime;cachedFile=selectedFile;
    }
    const data=cachedData;
    const current=()=>{
      if(ticket!==generation||disposed||getRuntime()!==runtime||runtime.review?.id!==data.id)return false;
      if(runtime.review.revision!==data.revision){requested=needsData=true;return false;}
      return true;
    };
    if(!current())return;
    const groups=new Map(discussionGroups([...data.history,...currentFeedback(data,data.comments)]).map(messages=>[messages[0].origin_id||messages[0].id,messages])),latest=commentThreads(data,data.comments);
    const projections=new Map(),present=new Set(),reviewed=new Set(data.files.map(file=>file.path));
    const visible=(vscode.window.visibleTextEditors||[]).map(editor=>fileFor(editor.document)).filter(file=>reviewed.has(file));
    for(const file of new Set([...latest.map(entry=>entry.file),...visible])) {
      try {
        const document=await documentFor(file);
        if(fileFor(document)){
          if(data.files.find(item=>item.path===file)?.loaded===false){
            const full=await runtime.data(file);
            if(!current())return;
            const replacement=full.files.find(item=>item.path===file);
            if(full.id!==data.id||full.revision!==data.revision||full.proposed!==data.proposed||!replacement)return;
            const index=data.files.findIndex(item=>item.path===file);data.files[index]=replacement;
          }
          projections.set(file,await project(document));
        }
      } catch(error) {
        if(error.code==='SourceChanged')return;
        if(error.code!=='ENOENT'&&error.code!=='FileNotFound')throw error;
      }
      if(!current())return;
    }
    if([...projections.values()].some(projection=>projection.revision!==data.revision||projection.document.version!==projection.documentVersion))return;
    for(const projection of projections.values())onProjection?.(projection,data);
    for(const entry of latest) {
      const projection=projections.get(entry.file);
      if(!projection)continue;
      const origin=entry.origin_id,key=threadKey(review.id,projection.document.uri,origin),range=rangeFor(entry,projection);
      let state=threads.get(key);
      if(!state) {
        state={thread:makeThread(projection.document,range)};
        threads.set(key,state);state.thread.reviewState=state;
      }
      Object.assign(state,{entry,origin,key,data,projection,range,reviewId:review.id});
      resumeThread(state);
      state.thread.range=markerRange(projection.document,range);
      commentsFor(state,groups.get(origin));

      present.add(key);
    }
    for(const [key,state] of threads)if(!present.has(key)) {
      if(state.reviewId!==review.id)suspendThread(state);
      else if(!state.draft) {
        state.thread.dispose();threads.delete(key);
      }
    }
    for(const state of pending)state.reviewId===review.id?resumeThread(state):suspendThread(state);
    return true;
  }

  function refresh({sourceOnly=false,file}={}){
    selectedFile=file||fileFor(vscode.window.activeTextEditor?.document)||selectedFile;
    generation++;requested=true;needsData||=!sourceOnly;
    refreshing??=(async()=>{let result;do{requested=false;result=await update(generation);}while(requested&&!disposed);return result;})()
      .finally(()=>{refreshing=undefined;});
    return refreshing;
  }

  async function openInput(state,comment,ticket=++inputEpoch) {
    checkReview(state);
    if(ticket!==inputEpoch)return;
    state.inputEpoch=ticket;
    if(!state.draft){
      state.draft={id:randomUUID(),body:comment?.savedBody||'',comment};
      if(comment){comment.editRevision=state.data.revision;comment.conflict=false;}
    }
    activeInput=state;
    state.thread.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
    await onInput?.(state.thread,state.projection.document);
    return state.thread;
  }

  async function annotate(editor=vscode.window.activeTextEditor,explicitRange) {
    const ticket=++inputEpoch;
    if(!editor)throw new Error('Select text in a source editor to leave a comment.');
    const saved=editor.document.uri.scheme==='manuscript-review-source'&&fileFor(editor.document);
    if(!sourceDocument(editor.document)&&!saved)throw new Error('Choose a manuscript source file to leave a comment.');
    if(!enabled||!canComment(editor.document))throw new Error('Turn on source comments in the Manuscript Review sidebar.');
    const version=editor.document.version;
    const range=explicitRange||(editor.selection.isEmpty
      ? editor.document.lineAt(editor.selection.start.line).range : editor.selection);
    const projection=await project(editor.document);
    if(ticket!==inputEpoch||disposed)return;
    if(editor.document.version!==version)throw new Error('The source changed while opening comments. Select the text again.');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    if(ticket!==inputEpoch||disposed)return;
    if(editor.document.version!==version||getRuntime()?.review?.id!==projection.reviewId)
      throw new Error('The source comparison changed while opening comments. Select the text again.');
    const start=editor.document.offsetAt(range.start),end=editor.document.offsetAt(range.end);
    const retained=[...pending].find(state=>state.reviewId===projection.reviewId&&state.projection.file===projection.file
      &&state.projection.text===projection.text&&state.start===start&&state.end===end);
    if(retained)return openInput(retained,undefined,ticket);
    const thread=makeThread(editor.document,range);
    const state={thread,projection,reviewId:projection.reviewId,inputEpoch:ticket,
      start,end};
    thread.reviewState=state;
    thread.contextValue='manuscriptReview.pending';
    pending.add(state);
    return openInput(state,undefined,ticket);
  }

  async function discuss({editor,source,span}) {
    const ticket=++inputEpoch;
    const current=()=>source.reviewId===getRuntime()?.review?.id&&source.revision===getRuntime().review.revision&&editor.document.getText()===source.text;
    if(!current())throw new Error('The source changed. Select its current change to comment.');
    await refresh({file:source.file});
    if(ticket!==inputEpoch||disposed)return;
    if(!current())throw new Error('The source changed. Select its current change to comment.');
    const state=[...threads.values()].find(state=>state.reviewId===getRuntime()?.review?.id
      &&state.entry.file===source.file&&state.range
      &&(span.from===span.to?state.range.contains(editor.document.positionAt(span.from))
       :editor.document.offsetAt(state.range.start)<span.to&&editor.document.offsetAt(state.range.end)>span.from));
    if(state){activeThread=state.key;return openInput(state,state.thread.comments.at(-1)?.editable?state.thread.comments.at(-1):undefined,ticket);}
    const draft=[...pending].find(state=>state.reviewId===source.reviewId&&state.projection.file===source.file&&state.start===span.from&&state.end===span.to);
    if(draft)return openInput(draft,undefined,ticket);
    const start=editor.document.positionAt(span.from),end=editor.document.positionAt(span.to);
    editor.selection=new vscode.Selection(start,start);
    return annotate(editor,new vscode.Range(start,end));
  }

  async function changed() {await refresh();if(!disposed)await onChange?.();}

  async function reply({thread,text}) {
    if(!text.trim())return false;
    const state=thread.reviewState;
    checkReview(state);
    const runtime=getRuntime();
    if(state.entry?.current)throw new Error('Edit this note to add detail; it will support replies after an agent responds.');
    let projection=state.projection,start=state.start,end=state.end;
    if(state.entry) {
      projection=await project(await documentFor(state.entry.file));
      const range=rangeFor(state.entry,projection);
      if(!range)throw new Error('This comment has no current source anchor. Open its original context in review.');
      start=projection.document.offsetAt(range.start);end=projection.document.offsetAt(range.end);
    } else {
      const current=await project(await documentFor(projection.file));
      projection={...projection,revision:current.revision,source:current.source};
    }
    checkReview(state);
    if(getRuntime()!==runtime||projection.reviewId!==state.reviewId)
      throw new Error('The review changed while preparing this comment. Return to its original round.');
    const result=await runtime.request('/note',{revision:projection.revision,file:projection.file,
      text:projection.text,source:projection.source,start,end,comment:text,
      ...(state.entry?{parent:state.entry.id}:{})});
    if(!state.entry) {
      pending.delete(state);state.entry=result.entry;state.origin=result.entry.origin_id;
      state.key=threadKey(state.reviewId,state.thread.uri,state.origin);
      threads.set(state.key,state);activeThread=state.key;
    }
    state.data={...(state.data||cachedData),revision:result.revision};
    const messages=state.thread.comments.filter(comment=>comment.entry&&comment.id===comment.entry.id).map(comment=>comment.entry);
    state.entry={...result.entry,resolved:state.data.resolved?.includes(result.entry.origin_id)||state.entry.resolved};
    commentsFor(state,[...messages,state.entry]);
    resumeThread(state);
    return result.entry.id;
  }

  function editComment(comment) {
    if(!comment.editable)return false;
    return openInput(comment.parent.reviewState,comment);
  }

  async function saveComment(state,input) {
    const comment=input.comment,text=input.body;
    checkReview(state);
    if(comment.conflict||!comment.editable)throw new Error('This comment changed or received a response. Close this input and leave a follow-up.');
    let result;
    if(comment.current) {
      result=await getRuntime().request('/save',{revision:comment.editRevision,decisions:state.data.decisions,
        comments:{...state.data.comments,[comment.entry.id]:text}});
    } else result=await getRuntime().request('/note',{revision:comment.editRevision,id:comment.entry.id,comment:text});
    comment.entry={...comment.entry,comment:text};
    if(state.entry.id===comment.entry.id)state.entry=comment.entry;
    state.data={...state.data,revision:result.revision};
    if(comment.current)state.data.comments={...state.data.comments,[comment.entry.id]:text};
    comment.body=comment.savedBody=text;
    comment.contextValue=comment.editable?'manuscriptReview.editable':undefined;
    return text.trim()?comment.entry.id:undefined;
  }

  function inputState(id) {
    const state=activeInput;
    if(!state?.draft||state.draft.id!==id)throw new Error('Use the current comment input.');
    checkReview(state);return state;
  }
  function editInput(id,text) {
    if(typeof text!=='string')throw new Error('A comment needs text.');
    if(activeInput?.draft?.id!==id)return false;
    activeInput.draft.body=text;
  }
  function input() {
    const state=activeInput,draft=state?.draft;
    if(!draft||state.reviewId!==getRuntime()?.review?.id)return;
    const document=state.projection.document;
    const point=state.range?.start||document.positionAt(state.start);
    return {id:draft.id,review:state.reviewId,file:state.projection.file,line:point.line+1,
      body:draft.body,editing:Boolean(draft.comment),saved:Boolean(state.entry),resolved:Boolean(state.entry?.resolved),
      history:state.thread.comments.filter(comment=>comment!==draft.comment).map(comment=>({
        id:comment.id,author:comment.author.name,body:typeof comment.body==='string'?comment.body:comment.body.value}))};
  }
  async function finishInput(state,draft,ticket,text=draft.body) {
    const owns=state.draft===draft&&state.inputEpoch===ticket&&draft.body===text;
    if(owns){
      delete state.draft;
      if(activeInput===state)activeInput=undefined;
    }
    const complete=()=>owns&&!disposed&&inputEpoch===ticket&&state.inputEpoch===ticket&&!state.draft
      &&state.reviewId===getRuntime()?.review?.id;
    try{await onInput?.();await changed();}
    catch(error){if(!disposed)await vscode.window.showErrorMessage('Comment saved. Could not refresh: '+error.message);return;}
    if(complete())try{await onInputComplete?.(state.thread,complete);}
    catch(error){if(!disposed)await vscode.window.showErrorMessage('Could not return to review: '+error.message);}
  }
  async function submitInput(id,text,dispatch=false) {
    const state=inputState(id);
    editInput(id,text);
    const draft=state.draft,ticket=state.inputEpoch;
    if(!draft.comment&&!text.trim())return false;
    let saved=false;
    const save=async()=>{
      const identifier=draft.comment?await saveComment(state,{...draft,body:text}):await reply({thread:state.thread,text});
      saved=true;return identifier;
    };
    try {
      const result=dispatch&&text.trim()?await onAgent?.(undefined,save,state.thread.uri):await save();
      return result!==false;
    } finally {
      if(saved)void finishInput(state,draft,ticket,text);
    }
  }
  async function cancelInput(id) {
    const state=inputState(id),draft=state.draft,ticket=state.inputEpoch;
    if(!state.entry){pending.delete(state);state.thread.dispose();}
    await finishInput(state,draft,ticket);
  }

  async function move(direction) {
    const ticket=++inputEpoch,runtime=getRuntime();
    if(!await refresh()||ticket!==inputEpoch||disposed)return false;
    const states=[...threads.values()].filter(state=>state.reviewId===runtime.review?.id&&state.range&&(includeResolved||!state.entry.resolved))
      .sort((a,b)=>a.entry.file.localeCompare(b.entry.file)||a.range.start.compareTo(b.range.start));
    if(!states.length)return false;
    const native=vscode.window.activeTextEditor,file=fileFor(native?.document),cursor=native?.selection.active;
    let current=states.findIndex(state=>state.key===activeThread),next;
    if(file&&cursor) {
      const contains=state=>state.projection.document===native.document&&state.range.contains(cursor);
      if(current<0||!contains(states[current]))current=states.findIndex(contains);
      if(current<0) {
        const after=states.findIndex(state=>state.entry.file.localeCompare(file)>0
          ||(state.entry.file===file&&state.range.start.compareTo(cursor)>0));
        next=direction<0?(after<0?states.length-1:Math.max(0,after-1)):(after<0?states.length-1:after);
      }
    }
    next??=current<0?(direction<0?states.length-1:0):Math.max(0,Math.min(states.length-1,current+direction));
    const state=states[next],{document,text}=state.projection,{id,revision}=runtime.review,version=document.version;
    if(document.getText()!==text)return false;
    const editor=await vscode.window.showTextDocument(document,{preserveFocus:false});
    if(ticket!==inputEpoch||disposed||runtime.review?.id!==id||runtime.review.revision!==revision||document.version!==version||document.getText()!==text)return false;
    editor.selection=new vscode.Selection(state.range.start,state.range.start);
    editor.revealRange(state.range,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    activeThread=state.key;
    await openInput(state,state.entry?.current?state.thread.comments.at(-1):undefined,ticket);
    return true;
  }

  // Source annotations use the selection action. Native commenting ranges draw a
  // persistent gutter stripe even when every comment is collapsed.
  const rangeProvider={provideCommentingRanges:()=>[]};
  function setEnabled(value){enabled=value;controller.commentingRangeProvider=enabled?rangeProvider:undefined;}
  setEnabled(true);
  command('editComment',editComment);
  function openThread(thread){const state=thread.reviewState;return openInput(state,state.entry?.current?thread.comments.at(-1):undefined);}
  command('openComment',openThread);
  async function resolveInput(id){const state=inputState(id);await setResolved(state.thread,!state.entry?.resolved);}
  async function setResolved(thread,resolved){
    const state=thread?.reviewState;
    if(!state?.entry)return false;
    checkReview(state);
    await getRuntime().request('/thread',{revision:state.data.revision,id:state.entry.origin_id,resolved});
    await changed();return true;
  }
  command('resolveComment',thread=>setResolved(thread,true));
  command('reopenComment',thread=>setResolved(thread,false));
  command('commentFilter',async()=>{
    const choices=[{label:'Unresolved',value:false},{label:'All',value:true}];
    const selected=await vscode.window.showQuickPick(choices,{title:'Comment navigation',placeHolder:includeResolved?'All':'Unresolved'});
    if(selected)includeResolved=selected.value;
    return includeResolved;
  });
  command('viewCommentChange',thread=>{
    const state=thread.reviewState;
    if(!state?.entry)return false;
    checkReview(state);
    return onReview?.(state.entry);
  });
  command('commentAgent',thread=>{
    const state=thread.reviewState;
    if(!state?.entry)return false;
    checkReview(state);
    if(state.draft)
      throw new Error('Save your comment edit before sending it to an agent.');
    return onAgent?.(state.entry.id,undefined,thread.uri);
  });

  function dispose() {
    disposed=true;generation++;
    for(const state of [...threads.values(),...pending])state.thread.dispose();
    for(const subscription of subscriptions)subscription.dispose();
    threads.clear();pending.clear();
  }
  return {refresh,annotate,discuss,move,dispose,setEnabled,input,editInput,submitInput,cancelInput,openThread,resolveInput};
}
