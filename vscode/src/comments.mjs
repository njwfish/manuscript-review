import path from 'node:path';
import {commentThreads,currentFeedback,discussionGroups} from '../../manuscript_review/review_model.js';

export function sourceDocument(document){
 return document?.uri.scheme==='file'&&['.tex','.bib','.md','.txt','.typ','.rst'].includes(path.extname(document.uri.fsPath));
}

export function sourceFile(review,document){
 if(!review||!sourceDocument(document))return null;
 const relative=path.relative(review.workspace||review.repo,document.uri.fsPath);
 return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)
  ?relative.split(path.sep).join('/'):null;
}

export function createComments(vscode,getRuntime,{onChange,onReview,onProjection,onAgent,onSource,canComment=sourceDocument}={}) {
  const controller=vscode.comments.createCommentController('manuscript-review','Manuscript Review');
  const subscriptions=[controller],threads=new Map(),pending=new Set();
  let generation=0,disposed=false,activeThread,includeResolved=false;

  const fileFor=document=>sourceFile(getRuntime()?.review,document);
  const threadKey=(uri,origin)=>JSON.stringify([uri.toString(),origin]);

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

  async function documentFor(file) {
    const runtime=getRuntime();
    const uri=vscode.Uri.file(path.join(runtime.review.workspace||runtime.review.repo,file));
    return vscode.workspace.textDocuments.find(document=>document.uri.toString()===uri.toString())
      || await vscode.workspace.openTextDocument(uri);
  }

  async function project(document) {
    if(!fileFor(document))await onSource?.(document);
    const runtime=getRuntime();
    const review=runtime?.review,file=fileFor(document),reviewId=review?.id;
    if(!file)throw new Error('Choose a source file in the reviewed repository.');
    const text=document.getText(),version=document.version;
    const result=await runtime.request('/editor',{file,text});
    if(getRuntime()!==runtime||runtime?.review?.id!==reviewId||document.version!==version||document.getText()!==text)
      throw Object.assign(new Error('The source changed while locating this comment. Try again.'),{code:'SourceChanged'});
    return {...result,file,text,document,reviewId};
  }

  function rangeFor(entry,projection) {
    const item=projection.notes.find(note=>note.id===entry.id)
      ||(entry.target?.kind==='edit'?projection.ranges:projection.passages)
        .find(item=>item.id===entry.target?.id);
    return item?new vscode.Range(projection.document.positionAt(item.from),projection.document.positionAt(item.to)):undefined;
  }

  function makeThread(document,range) {
    const thread=controller.createCommentThread(document.uri,range,[]);
    thread.contextValue='manuscriptReview';
    thread.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
    return thread;
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
        // A response pins a current note as history, preserving its native editor.
        if(!comment&&value.id===entry.id&&!entry.current&&entry.author==='user'&&entry.origin_id)
          comment=old.find(comment=>comment.current&&comment.entry.origin_id===entry.origin_id&&comment.savedBody===value.text);
        if(!comment) {
          comment={id:value.id,body:value.text,savedBody:value.text,mode:vscode.CommentMode.Preview,
            author:{name:value.author==='user'?'You':'Agent'},parent:state.thread};
          changed=true;
        }
        if(comment.mode===vscode.CommentMode.Editing) {
          comment.conflict=!value.editable||comment.savedBody!==value.text;
          if(!comment.conflict)comment.editRevision=state.data.revision;
        } else {
          changed ||= comment.body!==value.text||comment.contextValue!==(value.editable?'manuscriptReview.editable':undefined);
          comment.body=comment.savedBody=value.text;
          comment.contextValue=value.editable?'manuscriptReview.editable':undefined;
        }
        Object.assign(comment,{id:value.id,entry:value.entry,current:Boolean(value.entry.current),editable:value.editable});
        comments.push(comment);
      }
    }
    if(changed||comments.length!==old.length||comments.some((comment,index)=>comment!==old[index]))
      state.thread.comments=comments;
  }

  async function refresh() {
    const runtime=getRuntime();
    const ticket=++generation,review=runtime?.review;
    if(!review||disposed)return;
    const data=await runtime.data('round');
    if(ticket!==generation||disposed||runtime.review?.id!==review.id)return;
    const groups=new Map(discussionGroups([...data.history,...currentFeedback(data,data.comments)]).map(messages=>[messages[0].origin_id||messages[0].id,messages])),latest=commentThreads(data,data.comments);
    const projections=new Map(),present=new Set(),reviewed=new Set(data.files.map(file=>file.path));
    const visible=(vscode.window.visibleTextEditors||[]).map(editor=>fileFor(editor.document)).filter(file=>reviewed.has(file));
    for(const file of new Set([...latest.map(entry=>entry.file),...visible])) {
      try {
        const document=await documentFor(file);
        if(fileFor(document))projections.set(file,await project(document));
      } catch(error) {
        if(error.code==='SourceChanged')return;
        if(error.code!=='ENOENT'&&error.code!=='FileNotFound')throw error;
      }
      if(ticket!==generation||disposed||runtime.review?.id!==review.id)return;
    }
    if([...projections.values()].some(projection=>projection.revision!==data.revision||projection.document.getText()!==projection.text))return;
    for(const projection of projections.values())onProjection?.(projection,data);
    for(const entry of latest) {
      const projection=projections.get(entry.file);
      if(!projection)continue;
      const origin=entry.origin_id,key=threadKey(projection.document.uri,origin),range=rangeFor(entry,projection);
      let state=threads.get(key);
      if(!state) {
        state={thread:makeThread(projection.document,range)};
        threads.set(key,state);state.thread.reviewState=state;
      }
      Object.assign(state,{entry,origin,key,data,projection,reviewId:review.id});
      resumeThread(state);
      state.thread.range=range;
      state.thread.canReply=!entry.current;
      commentsFor(state,groups.get(origin));
      present.add(key);
    }
    for(const [key,state] of threads)if(!present.has(key)) {
      if(state.reviewId!==review.id)suspendThread(state);
      else if(!state.thread.comments.some(comment=>comment.mode===vscode.CommentMode.Editing)) {
        state.thread.dispose();threads.delete(key);
      }
    }
    for(const state of pending)state.reviewId===review.id?resumeThread(state):suspendThread(state);
    return true;
  }

  async function annotate(editor=vscode.window.activeTextEditor) {
    if(!editor)throw new Error('Select text in a source editor to leave a comment.');
    if(!sourceDocument(editor.document))throw new Error('Choose a manuscript source file to leave a comment.');
    if(!canComment(editor.document))throw new Error('Turn on source comments in the Manuscript Review sidebar.');
    const version=editor.document.version;
    const range=editor.selection.isEmpty
      ? editor.document.lineAt(editor.selection.start.line).range : editor.selection;
    const projection=await project(editor.document);
    if(editor.document.version!==version)throw new Error('The source changed while opening comments. Select the text again.');
    const thread=makeThread(editor.document,range);
    const state={thread,projection,reviewId:projection.reviewId,
      start:editor.document.offsetAt(range.start),end:editor.document.offsetAt(range.end)};
    thread.reviewState=state;thread.canReply=true;
    thread.contextValue='manuscriptReview.pending';
    thread.collapsibleState=vscode.CommentThreadCollapsibleState.Expanded;
    pending.add(state);
    return thread;
  }

  async function changed() {await refresh();await onChange?.();}

  async function reply({thread,text}) {
    if(!text.trim())return false;
    let state=thread.reviewState;
    if(!state) {
      const document=await vscode.workspace.openTextDocument(thread.uri),projection=await project(document);
      state={thread,projection,reviewId:projection.reviewId,
        start:document.offsetAt(thread.range.start),end:document.offsetAt(thread.range.end)};
      thread.contextValue='manuscriptReview.pending';
      thread.reviewState=state;pending.add(state);
    }
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
      state.key=threadKey(state.thread.uri,state.origin);
      threads.set(state.key,state);activeThread=state.key;
    }
    await changed();
    return result.entry.id;
  }

  function editComment(comment) {
    if(!comment.editable)return false;
    comment.mode=vscode.CommentMode.Editing;comment.contextValue='manuscriptReview.editing';
    comment.editRevision=comment.parent.reviewState.data.revision;comment.conflict=false;
    comment.parent.comments=[...comment.parent.comments];
    return true;
  }

  async function saveComment(incoming) {
    const runtime=getRuntime();
    const state=incoming.parent.reviewState,comment=state.thread.comments.find(comment=>comment.id===incoming.id);
    const text=typeof incoming.body==='string'?incoming.body:incoming.body.value;
    comment.body=text;
    checkReview(state);
    if(comment.conflict||!comment.editable)throw new Error('This comment changed or received a response. Cancel editing and leave a follow-up.');
    if(comment.current) {
      await runtime.request('/save',{revision:comment.editRevision,decisions:state.data.decisions,
        comments:{...state.data.comments,[comment.entry.id]:text}});
    } else await runtime.request('/note',{revision:comment.editRevision,id:comment.entry.id,comment:text});
    comment.body=comment.savedBody=text;comment.mode=vscode.CommentMode.Preview;
    await changed();
    return true;
  }

  function cancelComment(comment) {
    comment.body=comment.savedBody;comment.mode=vscode.CommentMode.Preview;
    comment.contextValue=comment.editable?'manuscriptReview.editable':undefined;
    comment.parent.comments=[...comment.parent.comments];
  }

  async function move(direction) {
    const runtime=getRuntime();
    if(!await refresh())return false;
    const states=[...threads.values()].filter(state=>state.reviewId===runtime.review?.id&&state.thread.range&&(includeResolved||!state.entry.resolved))
      .sort((a,b)=>a.entry.file.localeCompare(b.entry.file)||a.thread.range.start.compareTo(b.thread.range.start));
    if(!states.length)return false;
    const native=vscode.window.activeTextEditor,file=fileFor(native?.document),cursor=native?.selection.active;
    let current=states.findIndex(state=>state.key===activeThread),next;
    if(file&&cursor) {
      const contains=state=>state.projection.document===native.document&&state.thread.range.contains(cursor);
      if(current<0||!contains(states[current]))current=states.findIndex(contains);
      if(current<0) {
        const after=states.findIndex(state=>state.entry.file.localeCompare(file)>0
          ||(state.entry.file===file&&state.thread.range.start.compareTo(cursor)>0));
        next=direction<0?(after<0?states.length-1:Math.max(0,after-1)):(after<0?states.length-1:after);
      }
    }
    next??=current<0?(direction<0?states.length-1:0):Math.max(0,Math.min(states.length-1,current+direction));
    const state=states[next],{document,text}=state.projection,{id,revision}=runtime.review,version=document.version;
    if(document.getText()!==text)return false;
    const editor=await vscode.window.showTextDocument(document,{preserveFocus:false});
    if(runtime.review?.id!==id||runtime.review.revision!==revision||document.version!==version||document.getText()!==text)return false;
    editor.selection=new vscode.Selection(state.thread.range.start,state.thread.range.end);
    editor.revealRange(state.thread.range,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    state.thread.collapsibleState=vscode.CommentThreadCollapsibleState.Expanded;
    activeThread=state.key;
    return true;
  }

  const rangeProvider={provideCommentingRanges:document=>canComment(document)
    ? [new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length))] : []};
  function setEnabled(enabled){controller.commentingRangeProvider=enabled?rangeProvider:undefined;}
  setEnabled(true);
  command('reply',async input=>Boolean(await reply(input)));command('editComment',editComment);command('saveComment',saveComment);command('cancelComment',cancelComment);
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
  command('sendComment',async input=>{
    if(!input.text.trim())return false;
    if(input.thread.reviewState)checkReview(input.thread.reviewState);
    else await onSource?.(await vscode.workspace.openTextDocument(input.thread.uri));
    return onAgent?.(undefined,()=>reply(input),input.thread.uri);
  });
  command('commentAgent',thread=>{
    const state=thread.reviewState;
    if(!state?.entry)return false;
    checkReview(state);
    if(state.thread.comments.some(comment=>comment.mode===vscode.CommentMode.Editing))
      throw new Error('Save your comment edit before sending it to an agent.');
    return onAgent?.(state.entry.id,undefined,thread.uri);
  });

  function dispose() {
    disposed=true;generation++;
    for(const state of [...threads.values(),...pending])state.thread.dispose();
    for(const subscription of subscriptions)subscription.dispose();
    threads.clear();pending.clear();
  }
  return {refresh,annotate,move,dispose,setEnabled,setAgent:label=>{controller.options={prompt:`Comment for ${label}…`,placeHolder:`Enter sends to ${label}. Shift+Enter adds a newline.`};}};
}
