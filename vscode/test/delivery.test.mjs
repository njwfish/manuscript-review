import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelivery} from '../src/delivery.mjs';

function fixture(options={}){
 let captured=false;const events=[],document={isDirty:false,isClosed:false,text:'Author words.',getText(){return this.text;},positionAt:offset=>offset,
  async save(){events.push('save');this.isDirty=false;return options.saved??true;}};
 const runtime={review:{id:'review'},async data(){return {authoring:true,revision:1,workspace:'/paper'};},
  async request(){if(captured)return {source:'agent-version',files:[]};return {source:'agent-version',files:[{file:'main.tex',before:'Author words.',after:'Author clear words.',edits:[{from:7,to:7,text:'clear '}]}]};}};
 const vscode={Uri:{file:fsPath=>({scheme:'file',fsPath})},Range:class{constructor(start,end){Object.assign(this,{start,end});}},TextEdit:class{constructor(range,text){Object.assign(this,{range,text});}},WorkspaceEdit:class{set(uri,edits){this.edits=edits;}},
  workspace:{async openTextDocument(uri){events.push('open');document.uri=uri;await options.open?.(document,runtime);return document;},
   async applyEdit(edit){events.push('edit');for(const item of edit.edits)document.text=document.text.slice(0,item.range.start)+item.text+document.text.slice(item.range.end);document.isDirty=true;return true;}}};
 const delivery=createDelivery(vscode,runtime,{openDocument:file=>vscode.workspace.openTextDocument(vscode.Uri.file('/paper/'+file)),sourceEdits:{async flush(){events.push('flush');},delivered(files,source){events.push({files,source});},async save(){captured=true;events.push('capture');},async completeDelivery(_files,_source,applied){if(!applied)events.push('cancel');}},reviewing:()=>options.reviewing||false,onDelivered:async()=>events.push('highlight')});
 return {delivery,document,runtime,events};
}

test('delivery uses exact native edits, records their source, saves, and enables the diff without focusing a tab',async()=>{
 const f=fixture();await f.delivery.refresh();
 assert.equal(f.document.text,'Author clear words.');
 assert.deepEqual(f.events,['flush','open',{files:[{file:'main.tex',before:'Author words.',after:'Author clear words.',edits:[{from:7,to:7,text:'clear '}]}],source:'agent-version'},'edit','save','flush','highlight']);
});
test('dirty or externally changed buffers wait for Save and focused review retains explicit application',async()=>{
 for(const options of [{open:doc=>doc.isDirty=true},{open:doc=>doc.text='New saved wording.'},{reviewing:true},{open:(_doc,runtime)=>runtime.review={id:'other'}}]){
  const f=fixture(options);await f.delivery.refresh();assert.equal(f.events.includes('edit'),false);
 }
});
test('save failure retains the delivered dirty buffer and exposes the next action',async()=>{
 const f=fixture({saved:false});await assert.rejects(f.delivery.refresh(),/Save the document/);
 assert.equal(f.document.text,'Author clear words.');assert.equal(f.events.includes('highlight'),false);
});
test('switching or disposing while a source opens cannot deliver into another review',async()=>{
 let f;f=fixture({open:()=>f.delivery.dispose()});await f.delivery.refresh();assert.equal(f.events.includes('edit'),false);
});
