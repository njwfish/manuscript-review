import assert from 'node:assert/strict';
import test from 'node:test';
import {createSidebar,sidebarState} from '../src/sidebar.mjs';

const setup={info:{repo:'/paper',workspace:'/proposal'},base:{label:'Initial draft',revision:'a'.repeat(40)},proposed:{label:'Proposal + local edits',revision:'b'.repeat(40)},entry:'main.tex'};
const data={files:[{path:'main.tex',hunks:[],edits:[{id:'one'},{id:'two'}]}],decisions:{one:'accept'},comments:{},history:[],resolved:[],drafts:{}};

test('the sidebar exposes exact endpoints and only offers Apply after all decisions',()=>{
 const state=sidebarState(setup,data,true,'Claude Code');
 assert.equal(state.folder,'/proposal');assert.equal(state.from,'Initial draft');assert.equal(state.to,'Proposal + local edits');
 assert.equal(state.fromVersion,setup.base.revision);assert.equal(state.toVersion,setup.proposed.revision);
 assert.equal(state.progress,'1 of 2 reviewed');assert.equal(state.canApply,false);
 assert.equal(sidebarState(setup,{...data,decisions:{one:'accept',two:'reject'}},true,'Codex').canApply,true);
 assert.equal(sidebarState(setup,{...data,decisions:{one:'accept',two:'reject'},applied:true},true,'Codex').canApply,false);
});

test('pending comparison choices stay distinguishable from the open review',()=>{
 const state=sidebarState({...setup,pending:true},data,false,'Codex');
 assert.equal(state.pending,true);assert.equal(state.active,true);assert.equal(state.commentsEnabled,false);
 assert.equal(sidebarState(undefined,undefined,true,'Codex').folder,undefined);
});

function fixture({load=async()=>sidebarState(setup,data,true,'Codex'),onAction=async()=>{}}={}){
 const handlers={},posts=[],actions=[],errors=[];let provider,disposed=false;
 const disposable=()=>({dispose(){}});
 const vscode={Uri:{file:fsPath=>({fsPath,toString:()=>`vscode-resource:${fsPath}`})},commands:{executeCommand:async command=>actions.push(command)},window:{
  registerWebviewViewProvider(_id,value){provider=value;return {dispose(){disposed=true;}};}
 }};
 const sidebar=createSidebar(vscode,{extensionPath:'/extension'},{load,onAction:async action=>{actions.push(action);await onAction(action);},onError:error=>errors.push(error.message)});
 const view={visible:true,onDidDispose:fn=>{handlers.dispose=fn;return disposable();},onDidChangeVisibility:fn=>{handlers.visibility=fn;return disposable();},webview:{
  asWebviewUri:value=>value.toString(),postMessage:async value=>posts.push(value),onDidReceiveMessage:fn=>{handlers.receive=fn;return disposable();}
 }};
 provider.resolveWebviewView(view);
 return {sidebar,view,posts,actions,errors,receive:message=>handlers.receive(message),close:()=>handlers.dispose(),get disposed(){return disposed;}};
}

test('the sidebar bounds host actions and sends manuscript data outside its HTML',async()=>{
 const f=fixture();
 assert.match(f.view.webview.html,/script-src 'nonce-/);assert.match(f.view.webview.html,/sidebar\.js/);
 assert.equal(f.view.webview.options.localResourceRoots[0].fsPath,'/extension/dist');
 await f.receive({action:'ready'});assert.equal(f.posts.at(-1).state.fromVersion,setup.base.revision);
 await f.receive({action:'executeCommand',name:'anything'});assert.deepEqual(f.actions,[]);
 await f.receive({action:'comments'});assert.deepEqual(f.actions,['comments']);
 f.sidebar.dispose();assert.equal(f.disposed,true);
 await f.receive({action:'base'});assert.deepEqual(f.actions,['comments']);
});

test('a failed comparison leaves author controls available for retry',async()=>{
 let failing=true;
 const f=fixture({onAction:async()=>{if(failing)throw new Error('Save your manuscript first.');}});
 await f.receive({action:'review'});
 assert.equal(f.posts.find(message=>message.type==='error').message,'Save your manuscript first.');
 assert.equal(f.posts.at(-1).busy,false);
 failing=false;await f.receive({action:'review'});assert.equal(f.posts.at(-1).busy,false);
 assert.equal(f.posts.filter(message=>message.type==='state').length,2);
 f.sidebar.dispose();
});

test('late refreshes cannot replace newer state or update a closed view',async()=>{
 let resolve;const initial=new Promise(done=>resolve=done);let count=0;
 const f=fixture({load:async()=>++count===1?initial:{from:'Newest'}});
 const first=f.sidebar.refresh();await f.sidebar.refresh();resolve({from:'Old'});await first;
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].state.from,'Newest');
 f.close();await f.sidebar.refresh();assert.equal(f.posts.length,1);
 f.sidebar.dispose();
});
