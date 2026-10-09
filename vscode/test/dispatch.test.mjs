import assert from 'node:assert/strict';
import test from 'node:test';
import {commentTask,openAgent} from '../src/dispatch.mjs';

const data={id:'review',repo:'/manuscript',feedback_path:'/library/reviews/review/review.json'};
const note={id:'edit',discussion_id:'discussion',file:'main.tex',line:12,comment:'Keep my exact wording.',before:'The \\alpha state.'};
const tools={launcher:'/agent tools/review-agent',skill:'/agent tools/manuscript-review'};
const report={comments:[note],history:[],edits:[{decision:'accept'}]};

test('a task addresses the saved discussion and returns only the final reply through existing commands',()=>{
 const {prompt,discussion}=commentTask(data,report,'edit',tools);assert.equal(discussion,note.discussion_id);
 assert.ok(prompt.startsWith('Address only discussion '+discussion),'the native conversation’s collapsed preview identifies the saved comment');
 assert.match(prompt,/discussion discussion/);assert.match(prompt,/Keep my exact wording\./);
 assert.match(prompt,/Original quoted source/);assert.match(prompt,/The \\alpha state\./);assert.match(prompt,/agent tools\/manuscript-review\/SKILL.md/);
 assert.match(prompt,/begin before any source changes/);assert.match(prompt,/finish to publish/);
 assert.match(prompt,/Append only your final, concise explanation/);
 assert.match(prompt,/Do not apply review decisions automatically/);
 assert.match(prompt,/--home '\/library'/);
 assert.throws(()=>commentTask(data,report,'other',tools),/Save this comment/);
});

test('custom libraries and quoted paths stay pinned in the agent command prefix',()=>{
 const {prompt}=commentTask({...data,feedback_path:"/my library/author's review/reviews/id/review.json"},report,'edit',tools);
 assert.ok(prompt.includes("'/agent tools/review-agent' --home '/my library/author'\"'\"'s review'"));
});

test('unfinished decisions and unsaved source keep dispatched tasks on discussion rather than source changes',()=>{
 assert.match(commentTask(data,{...report,edits:[{decision:'pending'}]},'discussion',tools).prompt,/without changing manuscript files or decisions/);
 assert.match(commentTask(data,report,'edit',{...tools,dirty:true}).prompt,/unsaved editor text.*without changing files/);
 const history={id:'source-comment',file:'other.tex',line:2,comment:'Reconsider this.',before:'Saved draft',replies:[{text:'Earlier answer'}]};
 const task=commentTask(data,{comments:[],history:[history],edits:[]},history.id,tools);
 assert.match(task.prompt,/discussion source-comment.*including its earlier replies/);assert.equal(task.discussion,history.id);
});

test('native agent tabs use public commands and keep the prepared prompt literal',async()=>{
 const commands=[],clipboard=[],information=[],activations=[];
 const vscode={Uri:{from:value=>value},extensions:{getExtension:id=>({activate:async()=>activations.push(id)})},
  commands:{executeCommand:async(...args)=>commands.push(args)},env:{clipboard:{writeText:async text=>clipboard.push(text)}},
  window:{showInformationMessage:async text=>information.push(text)}};
 const prompt='Literal `text`, $(commands), "quotes", and\nnewlines.';
 await openAgent(vscode,{agent:'claude',prompt,column:2});
 assert.deepEqual(commands,[['claude-vscode.editor.open',undefined,prompt,2,undefined,true]]);
 assert.deepEqual(clipboard,[]);
 await openAgent(vscode,{agent:'codex',prompt,column:2});
 const [command,uri,view,options]=commands[1];assert.equal(command,'vscode.openWith');
 assert.equal(uri.scheme,'openai-codex');assert.equal(uri.authority,'route');assert.equal(uri.path,'/');assert.match(uri.query,/^manuscriptReview=[0-9a-f-]{36}$/);
 assert.equal(view,'chatgpt.conversationEditor');assert.deepEqual(options,{viewColumn:2,preserveFocus:false,preview:false});
 assert.deepEqual(clipboard,[prompt]);assert.match(information.at(-1),/Paste.*Codex tab/);
 assert.deepEqual(activations,['anthropic.claude-code','openai.chatgpt']);
});

test('automatic sending binds each provider to one native composer without clipboard notifications',async()=>{
 for(const agent of ['codex','claude']){
  const commands=[],requests=[],agentTab={label:agent,group:{viewColumn:2},input:{viewType:agent==='claude'?'mainThreadWebview-claudeVSCodePanel':'chatgpt.conversationEditor'}};
  let tabChanged,disposed=false;
  const vscode={Uri:{from:value=>value},extensions:{getExtension:()=>({activate:async()=>{}})},commands:{executeCommand:async(...args)=>commands.push(args)},window:{tabGroups:{onDidChangeTabs:listener=>{tabChanged=listener;return {dispose(){disposed=true;}};}}}};
  const opened=await openAgent(vscode,{agent,prompt:'Exact request\nwith math \\alpha.',discussion:'source-comment',column:2,helper:'/native-send',submit:async(helper,request,open)=>{requests.push({helper,request});assert.equal(commands.length,0);await open();tabChanged({opened:[{group:{viewColumn:2},input:{viewType:"unrelated"}}]});tabChanged({opened:[agentTab]});}});
  assert.equal(opened,agentTab);assert.equal(disposed,true);
  assert.equal(requests[0].helper,'/native-send');assert.equal(requests[0].request.extension,agent==='codex'?'openai.chatgpt':'anthropic.claude-code');
  assert.equal(requests[0].request.prompt,'Exact request\nwith math \\alpha.');
  assert.equal(requests[0].request.discussion,'source-comment');
  assert.ok(commands.some(([name])=>name===(agent==='codex'?'vscode.openWith':'claude-vscode.editor.open')));
 }
});

test('missing native permission keeps a manual Claude request usable without retrying Send',async()=>{
 const commands=[],warnings=[];
 const vscode={Uri:{from:value=>value},extensions:{getExtension:()=>({activate:async()=>{}})},commands:{executeCommand:async(...args)=>commands.push(args)},window:{showWarningMessage:async text=>warnings.push(text)}};
 const sent=await openAgent(vscode,{agent:'claude',prompt:'Saved comment',column:2,helper:'/helper',submit:async()=>{throw Object.assign(new Error('Enable Accessibility.'),{code:'permission'});}});
 assert.equal(sent,false);assert.equal(commands.length,1);assert.match(warnings[0],/Accessibility.*Press Send/);
});

test('unavailable agent extensions fail without opening a different interface',async()=>{
 const vscode={Uri:{from:value=>value},extensions:{getExtension:()=>undefined}};
 await assert.rejects(openAgent(vscode,{agent:'codex'}),/Install the Codex VS Code extension/);
 await assert.rejects(openAgent(vscode,{agent:'other'}),/Choose Codex/);
});
