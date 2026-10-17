import assert from 'node:assert/strict';
import test from 'node:test';
import {originalSource} from '../src/source-review.mjs';

test('the original display reverses only pending edits while retaining author text and decisions',()=>{
 const projection={file:'main.tex',text:'My words. New first, kept second.\n',ranges:[{id:'one',from:10,to:13},{id:'two',from:21,to:25}]};
 const data={decisions:{two:'accept'},files:[{path:'main.tex',edits:[{id:'one',old:'Old',new:'New'},{id:'two',old:'old',new:'kept'}]}]};
 const original=originalSource(projection,data);
 assert.equal(original,'My words. Old first, kept second.\n');
 
 data.decisions.one='accept';assert.equal(originalSource(projection,data),projection.text);
});

test('deleted and inserted text keep exact positions without modifying source',()=>{
 const projection={file:'main.tex',text:'A new word.\n',ranges:[{id:'insert',from:2,to:6},{id:'delete',from:6,to:6}]};
 const data={decisions:{},files:[{path:'main.tex',edits:[{id:'insert',old:'',new:'new '},{id:'delete',old:'old ',new:''}]}]};
 const result=originalSource(projection,data);
 assert.equal(result,'A old word.\n');
 assert.equal(projection.text,'A new word.\n');

});

import {createSourceReview,originalScheme} from '../src/source-review.mjs';
function host(overrides={}){
 const uri=(scheme,path)=>({scheme,path,fsPath:path,toString:()=>scheme+':'+path});
 class TabInputText{constructor(uri){this.uri=uri;}}
 class TabInputTextDiff{constructor(original,modified){Object.assign(this,{original,modified});}}
 class EventEmitter{event=()=>({dispose(){}});fire(){}dispose(){}}
 const document={uri:uri('file','/main.tex'),version:1,languageId:'latex',getText:()=> 'New word.\n'};
 const editor={document,viewColumn:1,selection:{},revealRange(range){this.revealed=range;}};
 const plain={input:new TabInputText(document.uri)},group={viewColumn:1,tabs:[plain],activeTab:plain};
 const editors=[editor];
 const values={},writes=[],commands=[];let provider,gate;
 const window={activeTextEditor:editor,visibleTextEditors:[editor],tabGroups:{all:[group],activeTabGroup:group,
  async close(tabs){for(const tab of [].concat(tabs))for(const group of this.all)group.tabs=group.tabs.filter(item=>item!==tab);}},
  async showTextDocument(document,{viewColumn=1}={}){
   const group=this.tabGroups.all.find(group=>group.viewColumn===viewColumn),editor=editors.find(editor=>editor.document===document&&editor.viewColumn===viewColumn);
   let plain=group.tabs.find(tab=>tab.input instanceof TabInputText&&tab.input.uri===document.uri);
   if(!plain){plain={input:new TabInputText(document.uri)};group.tabs.push(plain);}
   group.activeTab=plain;if(this.tabGroups.activeTabGroup===group)this.activeTextEditor=editor;
   this.visibleTextEditors=this.visibleTextEditors.filter(item=>item.viewColumn!==viewColumn).concat(editor);return editor;
  }};
 let failure;
 const fields=['workspaceFolderLanguageValue','workspaceLanguageValue','globalLanguageValue','workspaceFolderValue','workspaceValue'];
 const config={get:key=>fields.map(field=>overrides[key]?.[field]).find(value=>value!==undefined)??values[key],
  inspect:key=>({...overrides[key],globalValue:values[key]}),async update(key,value,target,language){
   if(failure?.(key))throw new Error('Settings update failed.');
   writes.push([key,value,target,language]);
   if(target===1&&!language)values[key]=value;
   else{const field=({1:'global',2:'workspace',3:'workspaceFolder'})[target]+(language?'LanguageValue':'Value');
    (overrides[key]??={})[field]=value;}
  }};
 const vscode={window,EventEmitter,TabInputText,TabInputTextDiff,TextEditorRevealType:{InCenterIfOutsideViewport:2},ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},Uri:{from:({scheme,path})=>uri(scheme,path)},
  workspace:{getConfiguration:()=>config,getWorkspaceFolder:()=>({uri:uri('file','/paper')}),registerTextDocumentContentProvider(scheme,value){assert.equal(scheme,originalScheme);provider=value;return {dispose(){}};},async openTextDocument(uri){return editors.find(editor=>editor.document.uri.toString()===uri.toString()).document;}},
  commands:{async executeCommand(name,original,modified){commands.push(name);if(name==='vscode.diff'){
   await gate?.();const tab={input:new TabInputTextDiff(original,modified)};group.tabs.push(tab);group.activeTab=tab;
  }}}};
 const owner=createSourceReview(vscode),data={id:'review',revision:1,decisions:{},files:[{path:'main.tex',edits:[{id:'edit',old:'Old',new:'New'}]}]};
 const projection={document,documentVersion:1,file:'main.tex',revision:1,text:document.getText(),ranges:[{id:'edit',from:0,to:3}]};
 owner.update(projection,data);
 return {owner,editor,document,data,projection,group,values,writes,commands,window,editors,uri,TabInputTextDiff,get provider(){return provider;},defer(fn){gate=fn;},fail(fn){failure=fn;}};
}

test('native source review keeps one editable file, clears decided markup, and restores native settings',async()=>{
 const f=host();await f.owner.show(f.editor);
 assert.equal(f.group.tabs.length,1);assert.equal(f.group.activeTab.input.modified,f.document.uri);
 assert.equal(f.provider.provideTextDocumentContent(f.group.activeTab.input.original),'Old word.\n');
 f.data.decisions.edit='accept';f.owner.update(f.projection,f.data);
 assert.equal(f.provider.provideTextDocumentContent(f.group.activeTab.input.original),f.document.getText());
 f.values.codeLens=false;await f.owner.hide();
 assert.equal(f.group.tabs.length,1);assert.equal(f.group.activeTab.input.uri,f.document.uri);
 assert.equal(f.values.renderSideBySide,undefined);assert.equal(f.values['experimental.useTrueInlineView'],undefined);
 assert.equal(f.values.codeLens,false,'Author preference changes survive ending review');await f.owner.dispose();
});

test('ending review during native diff opening cannot leave a late diff or take source focus',async()=>{
 const f=host();let entered,release;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.defer(async()=>{entered();await gate;});
 const opening=f.owner.show(f.editor);await started;const closing=f.owner.hide();release();
 await Promise.all([opening,closing]);assert.equal(f.group.tabs.length,1);
 assert.equal(f.group.activeTab.input.uri,f.document.uri);
 assert.equal(f.commands.includes('workbench.action.compareEditor.focusSecondarySide'),false);await f.owner.dispose();
});

test('returning to Write retains the active file and selection across multiple review tabs and groups',async()=>{
 for(const column of [1,2]){
  const f=host();await f.owner.show(f.editor);
  const selection={start:{line:0,character:4},end:{line:0,character:4}};f.editor.selection=selection;
  const document={...f.document,uri:f.uri('file','/supplement.tex')},editor={...f.editor,document,viewColumn:column,selection:{}};
  const tab={input:new f.TabInputTextDiff(f.uri(originalScheme,'/supplement.tex'),document.uri)};
  const group=column===1?f.group:{viewColumn:column,tabs:[],activeTab:tab};group.tabs.push(tab);
  if(column!==1)f.window.tabGroups.all.push(group);
  f.editors.push(editor);if(column!==1)f.window.visibleTextEditors.push(editor);
  await f.owner.hide();
  assert.equal(f.window.activeTextEditor.document,f.document);assert.equal(f.window.activeTextEditor.selection,selection);
  assert.equal(f.group.activeTab.input.uri,f.document.uri);
  assert.equal(f.window.tabGroups.all.flatMap(group=>group.tabs).some(tab=>tab.input instanceof f.TabInputTextDiff),false);
  await f.owner.dispose();
 }
});

test('opening source from PDF preserves its focus',async()=>{
 const f=host();await f.owner.show(f.editor,{preserveFocus:true});
 assert.equal(f.commands.includes('workbench.action.compareEditor.focusSecondarySide'),false);
 await f.owner.hide();await f.owner.dispose();
});


test('unmapped show cannot cancel ending review',async()=>{
 const f=host();await f.owner.show(f.editor);const closing=f.owner.hide();
 await f.owner.show(f.editor);await closing;
 assert.equal(f.group.tabs.length,1);assert.equal(f.group.activeTab.input.uri,f.document.uri);
 assert.equal(f.values.renderSideBySide,undefined);await f.owner.dispose();
});

test('native review restores a partial preference setup after failure',async()=>{
 const f=host();f.fail(key=>key==='experimental.useTrueInlineView');
 await assert.rejects(f.owner.show(f.editor),/Settings update failed/);
 assert.equal(f.values.renderSideBySide,undefined);assert.equal(f.group.tabs.length,1);await f.owner.dispose();
});

test('native preferences use and restore the effective workspace and language scopes',async()=>{
 const overrides={codeLens:{workspaceValue:false},'experimental.useTrueInlineView':{workspaceFolderLanguageValue:false}};
 const f=host(overrides);await f.owner.show(f.editor);
 assert.equal(overrides.codeLens.workspaceValue,true);
 assert.equal(overrides['experimental.useTrueInlineView'].workspaceFolderLanguageValue,true);
 assert.equal(f.values.codeLens,undefined);await f.owner.hide();
 assert.equal(overrides.codeLens.workspaceValue,false);
 assert.equal(overrides['experimental.useTrueInlineView'].workspaceFolderLanguageValue,false);await f.owner.dispose();
});
