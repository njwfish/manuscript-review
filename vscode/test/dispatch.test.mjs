import assert from 'node:assert/strict';
import test from 'node:test';
import {openAgent} from '../src/dispatch.mjs';

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
