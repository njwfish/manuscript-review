import test from 'node:test';
import assert from 'node:assert/strict';
import {createPDFPanel,followWorkshopPDF} from '../src/pdf-panel.mjs';

function fixture(options={}){
 const messages=[],calls=[],errors=[],handlers={},actions=[];
 const disposable=()=>({dispose(){}});
 const view={active:false,webview:{cspSource:'vscode-resource:',html:'',asWebviewUri:uri=>uri.fsPath,
  async postMessage(message){messages.push(message);},onDidReceiveMessage(fn){handlers.message=fn;return disposable();}},
  viewColumn:2,reveal(column){this.viewColumn=column;calls.push({reveal:column});},onDidChangeViewState(fn){handlers.active=fn;return disposable();},onDidDispose(fn){handlers.dispose=fn;return disposable();},dispose(){handlers.dispose();}};
 const vscode={Uri:{file:fsPath=>({scheme:'file',fsPath}),parse:value=>({toString:()=>value})},env:{asExternalUri:async uri=>uri},ViewColumn:{Beside:2},window:{createWebviewPanel(type,title,placement){calls.push({type,title,placement});view.viewColumn=placement.viewColumn;return view;}}};
 let data={id:'review',revision:1,result:'selected',proposed:'proposal',entry:'main.tex'};
 const preview=()=>({proposed:data.result,proposal:data.proposed,entry:data.entry,preview_status:'ready',documents:{after:{pdf:'after.pdf',pages:[{width:100,height:200}],edits:{edit:[{page:1,bounds:[10,20,30,40]}],next:[{page:1,bounds:null}]}}}});
 const runtime={review:{id:'review',repo:'/manuscript',revision:1},async request(route){calls.push(route);await handlers.request?.(route);return route==='/summary'?{...data}:preview();},async asset(route){calls.push(route);await handlers.asset?.();return {bytes:Buffer.from('%PDF-fixture')};}};
 const panel=createPDFPanel(vscode,{extensionPath:'/extension'},runtime,{viewer:{start:async()=> 'http://127.0.0.1:1234'},showReviewed:()=>Boolean(options.reviewed),onAction:async(...args)=>actions.push(args),onError:error=>errors.push(error.message)});
 const send=message=>handlers.message({...message,instance:view.webview.html.match(/data-instance="([^"]+)/)[1]});
 return {panel,runtime,data,view,messages,calls,errors,handlers,actions,send,async ready(){await panel.show();await send({type:'loaded'});await send({type:'ready'});},switch(){data={...data,id:'other',revision:2,result:'other-result'};runtime.review={id:'other',repo:'/other',revision:2};panel.reset();}};
}

test('decided PDF marks disappear by default and reviewed display reuses the same PDF',async()=>{
 const options={},f=fixture(options);await f.ready();
 await f.panel.select('main.tex','edit',1,false,true);
 assert.deepEqual(f.messages.at(-1).marks,[]);
 const reads=f.calls.length;options.reviewed=true;
 await f.panel.select('main.tex','edit',1,false,true);
 assert.equal(f.messages.at(-1).marks.length,1);assert.equal(f.calls.length,reads);
 options.reviewed=false;await f.panel.select('main.tex','edit',1,false,false);
 assert.equal(f.messages.at(-1).marks.length,1);f.panel.dispose();
});

test('PDF opens only explicitly and displays selected source with one normalized change',async()=>{
 const f=fixture();await f.panel.select('main.tex','edit',1,true);assert.deepEqual(f.calls,[]);
 await f.ready();const message=f.messages.find(message=>message.type==='document');
 assert.equal(f.calls[0].type,'manuscriptReview.pdf');assert.equal(message.document,'review/selected/main.tex');
 assert.equal(message.color,'removed');assert.deepEqual(message.marks,[{page:1,bounds:[.1,.1,.3,.2]}]);
 assert.ok(message.data instanceof ArrayBuffer);assert.equal(f.calls.includes('/previews?scope=selected'),true);
 const reads=f.calls.length;await f.panel.select('main.tex','next',1);assert.equal(f.calls.length,reads);assert.equal(f.calls.filter(call=>call==='/selected-assets/after.pdf').length,1);f.panel.dispose();
});

test('PDF keys delegate to source owner only for the displayed selection and revision',async()=>{
 const f=fixture();await f.panel.select('main.tex','edit',1);await f.ready();f.panel.setMode(true);await f.panel.refresh();
 const shown=f.messages.filter(message=>message.type==='document').at(-1),token=shown.selection;
 await f.send({type:'rendered',document:shown.document,selection:token});
 await f.send({type:'key',key:'a',selection:'old'});assert.deepEqual(f.actions,[]);
 await f.send({type:'key',key:'A',selection:token,ctrlKey:true});assert.deepEqual(f.actions,[['accept','file']]);
 f.runtime.review.revision++;await f.send({type:'key',key:'s',selection:token});assert.equal(f.actions.length,1);
 await f.send({type:'key',key:'Escape'});assert.deepEqual(f.actions.at(-1),['edit','edit']);f.panel.dispose();
});

test('review switch during loading drains the new generation and never publishes the old PDF',async()=>{
 const f=fixture();await f.ready();f.messages.length=0;
 let release,entered,first=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 f.handlers.request=async route=>{if(first&&route==='/summary'){first=false;entered();await gate;}};
 const old=f.panel.refresh();await started;f.switch();const fresh=f.panel.refresh();release();await Promise.all([old,fresh]);
 assert.equal(f.messages.filter(message=>message.type==='document').length,1);assert.equal(f.messages.at(-1).document,'other/other-result/main.tex');f.panel.dispose();
});

test('changing selected source during asset loading discards the stale document',async()=>{
 const f=fixture();let release,entered,first=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 f.handlers.asset=async()=>{if(first){first=false;entered();await gate;}};
 const loading=f.ready();await started;f.data.result='new-selected';f.data.revision=2;f.runtime.review.revision=2;release();await loading;
 assert.equal(f.messages.filter(message=>message.type==='document').length,1);assert.equal(f.messages.at(-1).document,'review/new-selected/main.tex');f.panel.dispose();
});

test('closing the PDF during a request cancels publication without affecting the source owner',async()=>{
 const f=fixture();await f.ready();f.messages.length=0;
 f.handlers.request=async()=>f.panel.dispose();await f.panel.refresh();assert.deepEqual(f.messages,[]);assert.deepEqual(f.actions,[]);
});

test('Workshop follows only an already open PDF for the selected manuscript root',async()=>{
 const calls=[],selected={data:{repo:'/paper',entry:'main.tex'},span:{from:10},editor:{document:{uri:{scheme:'file',fsPath:'/paper/body.tex'},isDirty:false,positionAt:()=>({line:4})}}};
 const vscode={Uri:{file:fsPath=>({fsPath})},workspace:{getConfiguration:()=>({get:()=> '%DIR%/build'})},window:{tabGroups:{all:[{tabs:[{input:{viewType:'latex-workshop-pdf-hook',uri:{fsPath:'/paper/build/supp.pdf'}}}]}]}},
  extensions:{getExtension:()=>({activate:async()=>calls.push('activate')})},commands:{executeCommand:async(...args)=>calls.push(args)}};
 await followWorkshopPDF(vscode,selected);assert.deepEqual(calls,[]);
 vscode.window.tabGroups.all[0].tabs[0].input.uri.fsPath='/paper/build/main.pdf';await followWorkshopPDF(vscode,selected);
 assert.deepEqual(calls,['activate',['latex-workshop.synctexto',4,'/paper/body.tex']]);
 selected.editor.document.isDirty=true;await followWorkshopPDF(vscode,selected);assert.equal(calls.length,2);
});


test('review switching drains invalidated runtime request failures',async()=>{
 const f=fixture();await f.ready();f.messages.length=0;
 let release,entered,first=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 f.handlers.request=async()=>{if(first){first=false;entered();await gate;throw new Error('The manuscript review changed.');}};
 const old=f.panel.refresh();await started;f.switch();const fresh=f.panel.refresh();release();await Promise.all([old,fresh]);
 assert.equal(f.messages.at(-1).document,'other/other-result/main.tex');assert.deepEqual(f.errors,[]);f.panel.dispose();
});

test('concurrent PDF opening creates one panel and disposal cancels pending startup',async()=>{
 for(const dispose of [false,true]){
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),views=[];
  const vscode={Uri:{file:fsPath=>({fsPath}),parse:value=>({toString:()=>value})},env:{asExternalUri:async uri=>uri},ViewColumn:{Beside:2},window:{createWebviewPanel(){const handlers={};const panel={webview:{asWebviewUri:()=>'',onDidReceiveMessage:()=>({dispose(){}})},onDidChangeViewState:()=>({dispose(){}}),onDidDispose(fn){handlers.dispose=fn;return {dispose(){}};},dispose(){handlers.dispose();}};views.push(panel);return panel;}}};
  const owner=createPDFPanel(vscode,{extensionPath:'/extension'},{review:{id:'review',repo:'/paper'}},{viewer:{start:async()=>{entered();await gate;return 'http://127.0.0.1:1234';}},onAction:async()=>{},onError:()=>{}});
  const first=owner.show();await started;const second=owner.show();if(dispose)owner.dispose();release();await Promise.all([first,second]);assert.equal(views.length,dispose?0:1);owner.dispose();
 }
});


test('PDF placement stays beside the requested source and reopening reuses its group',async()=>{
 const f=fixture();await f.panel.show(2);
 assert.equal(f.calls[0].placement.viewColumn,3);
 await f.panel.show(3);assert.equal(f.calls.at(-1).reveal,4);
 await f.panel.show(1);assert.equal(f.calls.at(-1).reveal,2);
 assert.equal(f.calls.filter(call=>call.type==='manuscriptReview.pdf').length,1);f.panel.dispose();
});

test('service failures are visible in the PDF panel',async()=>{
 const f=fixture();await f.ready();f.handlers.request=async()=>{throw new Error('Cannot reach the manuscript service.');};
 await assert.rejects(f.panel.refresh(),/Cannot reach/);
 assert.equal(f.messages.at(-1).type,'status');assert.match(f.messages.at(-1).text,/Cannot reach/);f.panel.dispose();
});


test('a comparison changed during viewer startup cannot open the obsolete PDF',async()=>{
 let release,entered,changed=false,created=0;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const vscode={Uri:{file:fsPath=>({fsPath}),parse:value=>({toString:()=>value})},env:{asExternalUri:async uri=>uri},ViewColumn:{Beside:2},window:{createWebviewPanel(){created++;}}};
 const panel=createPDFPanel(vscode,{extensionPath:'/extension'},{review:{id:'review',repo:'/paper'}},{viewer:{start:async()=>{entered();await gate;return 'http://127.0.0.1:1234';}},onAction:async()=>{},onError:()=>{}});
 const opening=panel.show(1,()=>{if(changed)throw new Error('The comparison changed.');});
 await started;changed=true;release();await assert.rejects(opening,/comparison changed/);
 assert.equal(created,0);panel.dispose();
});
