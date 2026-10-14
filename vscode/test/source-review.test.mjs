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
 const editor={document,viewColumn:1,selection:{}};
 const plain={input:new TabInputText(document.uri)},group={viewColumn:1,tabs:[plain],activeTab:plain};
 const values={},writes=[],commands=[];let provider,gate;
 const window={activeTextEditor:editor,visibleTextEditors:[editor],tabGroups:{all:[group],activeTabGroup:group,
  async close(tabs){for(const tab of [].concat(tabs))group.tabs=group.tabs.filter(item=>item!==tab);}},
  async showTextDocument(){if(!group.tabs.includes(plain))group.tabs.push(plain);group.activeTab=plain;return editor;}};
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
 const vscode={window,EventEmitter,TabInputText,TabInputTextDiff,ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},Uri:{from:({scheme,path})=>uri(scheme,path)},
  workspace:{getConfiguration:()=>config,getWorkspaceFolder:()=>({uri:uri('file','/paper')}),registerTextDocumentContentProvider(scheme,value){assert.equal(scheme,originalScheme);provider=value;return {dispose(){}};},async openTextDocument(){return document;}},
  commands:{async executeCommand(name,original,modified){commands.push(name);if(name==='vscode.diff'){
   await gate?.();const tab={input:new TabInputTextDiff(original,modified)};group.tabs.push(tab);group.activeTab=tab;
  }}}};
 const owner=createSourceReview(vscode),data={id:'review',revision:1,decisions:{},files:[{path:'main.tex',edits:[{id:'edit',old:'Old',new:'New'}]}]};
 const projection={document,documentVersion:1,file:'main.tex',revision:1,text:document.getText(),ranges:[{id:'edit',from:0,to:3}]};
 owner.update(projection,data);
 return {owner,editor,document,data,projection,group,values,writes,commands,get provider(){return provider;},defer(fn){gate=fn;},fail(fn){failure=fn;}};
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
