import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelivery} from '../src/delivery.mjs';

function fixture(options={}){
 let captured=false;const events=[],document={isDirty:false,isClosed:false,version:1,text:'Author words.',getText(){return this.text;},positionAt:offset=>offset,
  async save(){events.push('save');this.isDirty=false;return options.saved??true;}};
 const runtime={review:{id:'review',revision:1},async data(){return {authoring:true,revision:this.review.revision,workspace:'/paper'};},
  async request(path){if(path==='/summary')return this.data();if(captured)return {source:'agent-version',files:[]};return {source:'agent-version',revision:this.review.revision,files:[{file:'main.tex',before:'Author words.',after:'Author clear words.',edits:[{from:7,to:7,text:'clear '}]}]};}};
 const vscode={Uri:{file:fsPath=>({scheme:'file',fsPath})},Range:class{constructor(start,end){Object.assign(this,{start,end});}},TextEdit:class{constructor(range,text){Object.assign(this,{range,text});}},WorkspaceEdit:class{set(uri,edits){this.edits=edits;}},
  workspace:{async openTextDocument(uri){events.push('open');document.uri=uri;await options.open?.(document,runtime);return document;},
   async applyEdit(edit){events.push('edit');for(const item of edit.edits)document.text=document.text.slice(0,item.range.start)+item.text+document.text.slice(item.range.end);document.isDirty=true;return true;}}};
 const delivery=createDelivery(vscode,runtime,{openDocument:file=>vscode.workspace.openTextDocument(vscode.Uri.file('/paper/'+file)),sourceEdits:{async flush(){events.push('flush');},async delivered(files,source){events.push({files,source});await options.staging?.(document,runtime);},async save(){captured=true;events.push('capture');},async completeDelivery(_files,_source,applied){if(!applied)events.push('cancel');}},paused:()=>options.reviewing||false,onDelivered:async()=>events.push('highlight')});
 return {delivery,document,runtime,events};
}

test('delivery uses exact native edits, records their source, saves, and enables the diff without focusing a tab',async()=>{
 const f=fixture();await f.delivery.refresh();
 assert.equal(f.document.text,'Author clear words.');
 assert.deepEqual(f.events,['flush','open',{files:[{file:'main.tex',before:'Author words.',after:'Author clear words.',edits:[{from:7,to:7,text:'clear '}],version:1}],source:'agent-version'},'edit','save','flush','highlight']);
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

test('a changed canonical revision during staging replans before writing source',async()=>{
 let stages=0;const f=fixture({staging(_document,runtime){if(++stages===1)runtime.review.revision++;}});
 await f.delivery.refresh();
 assert.equal(f.document.text,'Author clear words.');assert.equal(stages,2);
 assert.equal(f.events.filter(event=>event==='cancel').length,1);assert.equal(f.events.filter(event=>event==='edit').length,1);
});

test('a refused stage does not clean up another interrupted delivery',async()=>{
 const f=fixture({staging(){throw new Error('Confirm interrupted delivery');}});
 await assert.rejects(f.delivery.refresh(),/interrupted delivery/);
 assert.equal(f.events.includes('cancel'),false);assert.equal(f.events.includes('edit'),false);
});

test('typing and undoing back to the same text during staging still invalidates the planned buffer version',async()=>{
 let stages=0;const f=fixture({staging(document){if(++stages===1)document.version++;}});
 await f.delivery.refresh();assert.equal(stages,2);assert.equal(f.events.filter(event=>event==='cancel').length,1);
 assert.equal(f.events.filter(event=>event==='edit').length,1);
});

test('a dirty source file does not block independent clean source delivery',async()=>{
 const clean={uri:{scheme:'file',fsPath:'/paper/clean.tex'},isDirty:false,isClosed:false,text:'Before.',getText(){return this.text;},positionAt:x=>x,async save(){this.isDirty=false;return true;}};
 const dirty={...clean,uri:{scheme:'file',fsPath:'/paper/dirty.tex'},isDirty:true,text:'My unsaved words.'},written=[],staged=[];
 const documents=new Map([['clean.tex',clean],['dirty.tex',dirty]]);
 const files=[{file:'clean.tex',before:'Before.',after:'After.',edits:[{from:0,to:7,text:'After.'}]},{file:'dirty.tex',before:'Before.',after:'After.',edits:[{from:0,to:7,text:'After.'}]}];
 const runtime={review:{id:'review',revision:1},async request(route){return route==='/summary'?{authoring:true,revision:1}:{revision:1,source:'S',files};}};
 const vscode={Range:class{constructor(start,end){Object.assign(this,{start,end});}},TextEdit:class{constructor(range,text){Object.assign(this,{range,text});}},WorkspaceEdit:class{entries=[];set(uri,edits){this.entries.push({uri,edits});}},
  workspace:{async applyEdit(edit){for(const {uri,edits} of edit.entries){const document=documents.get(uri.fsPath.split('/').at(-1));for(const item of edits)document.text=item.text;written.push(uri.fsPath);}return true;}}};
 const delivery=createDelivery(vscode,runtime,{sourceEdits:{flush:async()=>{},async delivered(files){staged.push(...files.map(file=>file.file));},completeDelivery:async()=>{}},
  openDocument:async file=>documents.get(file),paused:()=>false,onDelivered:async()=>{}});
 await delivery.refresh();assert.deepEqual(staged,['clean.tex']);assert.deepEqual(written,['/paper/clean.tex']);
 assert.equal(clean.text,'After.');assert.equal(dirty.text,'My unsaved words.');assert.equal(dirty.isDirty,true);
});
