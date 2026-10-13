import assert from 'node:assert/strict';
import test from 'node:test';
import {createSourceEdits} from '../src/source-edits.mjs';

function fixture(options={}){
 const events=[],review={id:'review',repo:'/original',workspace:'/editing',workspace_version:'B'};
 const runtime={review,async data(){events.push('data');return {...this.review};},async request(route,body){if(route==='/summary'){events.push('data');await options.flush?.();return {...this.review};}events.push({route,body});await options.capture?.(body);this.review.source_cursors={...this.review.source_cursors,[body.file]:body.saves.at(-1).id};return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:this.review.workspace_version};}};
 const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,version:1,text:'B edited',getText(){return this.text;}};
 const edits=createSourceEdits(runtime,{async onChange(){events.push('changed');}});
 return {events,runtime,document,edits};
}

test('native Save captures B plus edits and refreshes without taking focus',async()=>{
 const f=fixture();await f.edits.save(f.document);
 const save=f.events.find(event=>event.route).body.saves[0];assert.match(save.id,/^[a-f0-9]{32}$/);
 assert.deepEqual(f.events,['data',{route:'/capture',body:{file:'main.tex',text:'B edited',source:'B',cursor:null,saves:[{id:save.id,text:'B edited',intent:'proposal'}]}},
  'changed']);
 assert.equal(f.edits.pending,false);
});

test('only supported saved source inside the editing checkout is captured',async()=>{
 const f=fixture();
 for(const uri of [{scheme:'file',fsPath:'/original/main.tex'},{scheme:'file',fsPath:'/editing-elsewhere/main.tex'},
  {scheme:'untitled',fsPath:'/editing/main.tex'},{scheme:'file',fsPath:'/editing/image.png'}])await f.edits.save({...f.document,uri});
 assert.deepEqual(f.events,[]);
 f.document.isDirty=true;await f.edits.save(f.document);assert.deepEqual(f.events,[]);
});

test('saved review documents cannot be captured or written back as working source',async()=>{
 const f=fixture();
 const uri={scheme:'manuscript-review-source',authority:f.runtime.review.id,path:'/main.tex',fsPath:'/main.tex'};
 await f.edits.save({...f.document,uri});
 assert.deepEqual(f.events,[]);assert.equal(f.edits.pending,false);
});

test('a newer Save during the canonical read coalesces into the latest saved text',async()=>{
 let release,entered;const enteredFlush=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 let count=0;const f=fixture({async flush(){if(++count===1){entered();await blocked;}}});
 const first=f.edits.save(f.document);await enteredFlush;
 f.document.version++;f.document.text='Latest saved wording';const second=f.edits.save(f.document);release();
 await Promise.all([first,second]);
 assert.deepEqual(f.events.filter(event=>event.route).map(event=>event.body.text),['Latest saved wording']);
 assert.equal(f.events.filter(event=>event==='changed').length,1);assert.equal(f.edits.pending,false);
});

test('typing after Save keeps the saved comparison and leaves the newer dirty buffer to VS Code',async()=>{
 const f=fixture({flush(){f.document.isDirty=true;f.document.version++;f.document.text='Unsaved wording';}});
 await f.edits.save(f.document);
 assert.equal(f.events.find(event=>event.route).body.text,'B edited');assert.equal(f.edits.pending,false);
 assert.equal(f.document.text,'Unsaved wording');assert.equal(f.events.at(-1),'changed');
});

test('capture failures retain the saved work for retry and do not refresh failed captures',async()=>{
 let fail=true;const f=fixture({capture(){if(fail)throw new Error('Stale review');}});
 await assert.rejects(f.edits.save(f.document),/Stale review/);
 assert.equal(f.edits.pending,true);assert.equal(f.events.includes('changed'),false);
 fail=false;await f.edits.flush();assert.equal(f.edits.pending,false);
 assert.equal(f.events.filter(event=>event.route).length,2);
});

test('switching or disposing a review while flush waits cannot capture into the new review',async()=>{
 for(const action of [f=>f.runtime.review={...f.runtime.review,id:'other'},f=>f.edits.dispose()]){
  const f=fixture({flush(){action(f);}});
  await assert.rejects(f.edits.save(f.document),/review changed/);
  assert.equal(f.events.some(event=>event.route),false);assert.equal(f.events.includes('changed'),false);
 }
});

test('multiple saved files retain their own origin while other file captures advance the checkpoint',async()=>{
 let entered,release;const blocked=new Promise(resolve=>release=resolve),capturing=new Promise(resolve=>entered=resolve);
 const f=fixture({async capture(body){if(body.file==='main.tex'){entered();await blocked;f.runtime.review.workspace_version='B plus main';}}});
 const first=f.edits.save(f.document);await capturing;
 const second=f.edits.save({...f.document,uri:{scheme:'file',fsPath:'/editing/second.tex'},text:'Second file'});release();await Promise.all([first,second]);
 assert.deepEqual(f.events.filter(event=>event.route).map(event=>[event.body.file,event.body.source]),[['main.tex','B'],['second.tex','B']]);
});

test('native Save before delivery acknowledgement retains agent provenance for every file',async()=>{
 const f=fixture();
 const files=[{file:'main.tex',before:f.document.text},{file:'second.tex',before:'Second author text'}];
 await f.edits.delivered(files,'Agent source');
 f.document.text='Agent source words';
 const first=f.edits.save(f.document);
 const second=f.edits.save({...f.document,uri:{scheme:'file',fsPath:'/editing/second.tex'},text:'Second agent text'});
 await f.edits.completeDelivery(files,'Agent source',true);await Promise.all([first,second]);
 assert.deepEqual(f.events.filter(event=>event.route).map(event=>event.body.saves.at(-1).editing),['Agent source','Agent source']);
});

test('Save while delivery is staging remains an author save if applying is cancelled',async()=>{
 const f=fixture(),files=[{file:'main.tex',before:f.document.text}];
 await f.edits.delivered(files,'Cancelled agent source');
 f.document.text='Fresh author text';const saved=f.edits.save(f.document);
 await f.edits.completeDelivery(files,'Cancelled agent source',false);await saved;
 assert.equal(f.events.find(event=>event.route).body.saves.at(-1).editing,undefined);
});

test('saving the original wording while staging does not attribute undelivered words to the author',async()=>{
 const f=fixture(),files=[{file:'main.tex',before:f.document.text}];
 await f.edits.delivered(files,'Future agent source');const saved=f.edits.save(f.document);
 await f.edits.completeDelivery(files,'Future agent source',true);await saved;
 assert.equal(f.events.find(event=>event.route).body.saves.at(-1).editing,undefined);
 f.document.text='Delivered source';await f.edits.save(f.document);
 assert.equal(f.events.filter(event=>event.route).at(-1).body.saves.at(-1).editing,'Future agent source');
});

test('Undo after delivery before its first successful Save captures the undo against the agent source',async()=>{
 const f=fixture(),files=[{file:'main.tex',before:f.document.text}];
 await f.edits.delivered(files,'Applied agent source');
 await f.edits.completeDelivery(files,'Applied agent source',true);
 // The delivery Save failed; Undo restored the author's exact original text.
 await f.edits.save(f.document);
 assert.equal(f.events.find(event=>event.route).body.saves.at(-1).editing,'Applied agent source');
 assert.equal(f.events.find(event=>event.route).body.text,files[0].before);
});

test('the explicit edit intent is pinned when typing starts, even if Review changes is toggled before Save',async()=>{
 let reviewing=true;
 const review={id:'review',workspace:'/editing',revision:1,workspace_version:'B'},captures=[];
 const runtime={review,async request(route,body){if(route==='/summary')return review;captures.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:review.workspace_version};}};
 const edits=createSourceEdits(runtime,{intent:()=>reviewing?'proposal':'author',onChange:async()=>{}});
 const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,getText:()=> 'Refined proposal'};
 edits.change(document);reviewing=false;document.isDirty=false;await edits.save(document);
 assert.equal(captures[0].saves.at(-1).intent,'proposal');
 document.isDirty=true;edits.change(document);reviewing=true;document.isDirty=false;await edits.save(document);
 assert.equal(captures[1].saves.at(-1).intent,'author');
});

test('an unacknowledged Save survives a review switch and can be captured when its owner returns',async()=>{
 let switchReview=true;
 const f=fixture({flush(){if(switchReview)f.runtime.review={...f.runtime.review,id:'other'};}});
 await assert.rejects(f.edits.save(f.document),/review changed/);
 await f.edits.flush();assert.equal(f.events.some(event=>event.route),false);
 switchReview=false;f.runtime.review.id='review';
 await f.edits.flush();assert.equal(f.events.find(event=>event.route).body.text,'B edited');
 assert.equal(f.edits.pending,false);
});

test('Undo to clean source ends the typing episode before a fresh drafting edit',async()=>{
 let reviewing=true;const captures=[],review={id:'review',workspace:'/editing',workspace_version:'B'};
 const runtime={review,async request(route,body){if(route==='/summary')return review;captures.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:review.workspace_version};}};
 const edits=createSourceEdits(runtime,{intent:()=>reviewing?'proposal':'author',onChange:async()=>{}});
 const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,getText:()=> 'Fresh author wording'};
 edits.change(document);document.isDirty=false;edits.change(document);
 reviewing=false;document.isDirty=true;edits.change(document);document.isDirty=false;edits.change(document);
 await edits.save(document);assert.equal(captures[0].saves.at(-1).intent,'author');
});

test('consecutive saves preserve different intents even when the first capture is delayed',async()=>{
 let reviewing=true,release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),captures=[];
 const review={id:'review',workspace:'/editing',workspace_version:'B'};
 let count=0;
 const runtime={review,async request(route,body){if(route==='/summary'){if(++count===1){entered();await gate;}return review;}captures.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'Updated B'};}};
 const edits=createSourceEdits(runtime,{intent:()=>reviewing?'proposal':'author',onChange:async()=>{}});
 const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,text:'Proposal refinement',getText(){return this.text;}};
 edits.change(document);document.isDirty=false;const first=edits.save(document);await started;
 reviewing=false;document.isDirty=true;document.text='Proposal refinement and author drafting';edits.change(document);document.isDirty=false;
 const second=edits.save(document);release();await Promise.all([first,second]);
 assert.deepEqual(captures[0].saves.map(save=>[save.text,save.intent]),[['Proposal refinement','proposal'],['Proposal refinement and author drafting','author']]);
 assert.equal(edits.pending,false);
});

test('saved points survive an extension restart and reuse their identities on acknowledgement retry',async()=>{
 const state=new Map(),storage={get:(key,fallback)=>state.get(key)??fallback,async update(key,value){state.set(key,structuredClone(value));}};
 const review={id:'review',workspace:'/editing',workspace_version:'B'},captures=[];
 let fail=true;
 const runtime={review,async request(route,body){if(route==='/summary')return review;captures.push(body);if(fail)throw new Error('Lost response');return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
 const callbacks={state:storage,onChange:async()=>{}};
 const first=createSourceEdits(runtime,callbacks),document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,getText:()=> 'Saved words'};
 await assert.rejects(first.save(document),/Lost response/);first.dispose();
 const snapshot=structuredClone(state.get('savedSources'));fail=false;
 const second=createSourceEdits(runtime,callbacks);await second.flush();
 assert.equal(captures[0].saves[0].id,captures[1].saves[0].id);assert.deepEqual(state.get('savedSources'),{});
 assert.equal(Object.values(snapshot)[0].saves[0].text,'Saved words');
});

test('a save appended during capture is acknowledged separately against the preceding checkpoint',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),calls=[];
 const f=fixture({async capture(body){calls.push(body);if(calls.length===1){entered();await gate;}}});
 const first=f.edits.save(f.document);await started;f.document.text='Next saved words';const second=f.edits.save(f.document);release();
 await Promise.all([first,second]);assert.equal(calls.length,2);
 assert.equal(calls[1].cursor,calls[0].saves[0].id);assert.equal(calls[1].saves.length,1);assert.equal(calls[1].saves[0].text,'Next saved words');
});

test('typing during delivery keeps its original intent and is distinct from the synthetic edit',async()=>{
 let reviewing=false;const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
 const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
 const edits=createSourceEdits(runtime,{intent:()=>reviewing?'proposal':'author',onChange:async()=>{}});
 const files=[{file:'main.tex',before:'Author words',after:'Agent words'}],document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,text:'Agent words',getText(){return this.text;}};
 await edits.delivered(files,'Agent');edits.change(document);
 document.text='Agent words and new author words';edits.change(document);await edits.completeDelivery(files,'Agent',true);
 reviewing=true;document.isDirty=false;await edits.save(document);
 assert.equal(calls[0].saves[0].intent,'author');assert.equal(calls[0].saves[0].editing,'Agent');
});

test('manual text equal to a staged delivery keeps its typing intent after cancellation',async()=>{
 let intent='author';const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
 const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
 const edits=createSourceEdits(runtime,{intent:()=>intent,onChange:async()=>{}});
 const files=[{file:'main.tex',before:'Author words',after:'Agent words'}],document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,getText:()=> 'Agent words'};
 await edits.delivered(files,'Agent');edits.change(document);await edits.completeDelivery(files,'Agent',false);
 intent='proposal';document.isDirty=false;await edits.save(document);
 assert.equal(calls[0].saves[0].intent,'author');assert.equal(calls[0].saves[0].editing,undefined);
});

test('an interrupted staged delivery requires explicit origin recovery and retains its ledger on cancellation',async()=>{
 for(const applied of [false,true]){
  const values=new Map(),state={get:(key,fallback)=>values.get(key)??fallback,async update(key,value){values.set(key,structuredClone(value));}};
  const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
  const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
  const callbacks={state,intent:()=> 'author',onChange:async()=>{}};
  const first=createSourceEdits(runtime,callbacks),files=[{file:'main.tex',before:'Author words',after:'Agent words'}];
  await first.delivered(files,'Agent');first.dispose();
  const second=createSourceEdits(runtime,callbacks),document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,getText:()=> 'Author words with punctuation.'};
  await assert.rejects(second.delivered(files,'New agent'),/interrupted delivery/);
  await assert.rejects(second.save(document),/interrupted delivery/);assert.equal(second.pending,true);assert.equal(calls.length,0);second.dispose();
  const stored=structuredClone(values.get('savedSources'));
  const recovered=createSourceEdits(runtime,{...callbacks,async recoverDelivery(value){assert.equal(value.file,'main.tex');return applied;}});
  await recovered.flush();assert.equal(recovered.pending,false);
  assert.equal(calls[0].saves[0].id,Object.values(stored)[0].saves[0].id);
  assert.equal(calls[0].saves[0].editing,applied?'Agent':undefined);assert.equal(calls[0].saves[0].intent,'author');
 }
});

test('successful delivery ends purely synthetic typing even when its first Save fails',async()=>{
 let intent='author';const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
 const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
 const edits=createSourceEdits(runtime,{intent:()=>intent,onChange:async()=>{}});
 const files=[{file:'main.tex',before:'Author words',after:'Agent words',version:1}],document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,version:2,text:'Agent words',getText(){return this.text;}};
 await edits.delivered(files,'Agent');edits.change(document);await edits.completeDelivery(files,'Agent',true);
 // The automatic Save fails, then a new manual refinement begins in this dirty buffer.
 intent='proposal';document.version++;document.text='Refined agent words';edits.change(document);document.isDirty=false;await edits.save(document);
 assert.equal(calls[0].saves[0].intent,'proposal');assert.equal(calls[0].saves[0].editing,'Agent');
});

test('restart recovery preserves point origins on either side of native application',async()=>{
 const values=new Map(),state={get:(key,fallback)=>values.get(key)??fallback,async update(key,value){values.set(key,structuredClone(value));}};
 const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
 const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
 const callbacks={state,onChange:async()=>{}};
 const first=createSourceEdits(runtime,callbacks),files=[{file:'main.tex',before:'Author words',after:'Agent words'}],document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,text:'Author words',getText(){return this.text;}};
 await first.delivered(files,'Agent');void first.save(document);await new Promise(setImmediate);
 document.text='Agent words';void first.save(document);await new Promise(setImmediate);first.dispose();
 const recovered=createSourceEdits(runtime,{...callbacks,recoverDelivery:async()=>true});await recovered.flush();
 assert.deepEqual(calls[0].saves.map(save=>save.editing),[undefined,'Agent']);assert.equal(recovered.pending,false);
});

test('typing after a provisional native event uses its own intent when applied and the original intent when cancelled',async()=>{
 for(const applied of [false,true])for(const saveBeforeCompletion of [false,true]){
  let intent='author';const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
  const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
  const edits=createSourceEdits(runtime,{intent:()=>intent,onChange:async()=>{}});
  const files=[{file:'main.tex',before:'Author words',after:'Agent words',version:1}],document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:true,version:2,text:'Agent words',getText(){return this.text;}};
  await edits.delivered(files,'Agent');edits.change(document);
  intent='proposal';document.version++;document.text='Refined agent words';edits.change(document);document.isDirty=false;
  const saving=saveBeforeCompletion?edits.save(document):undefined;
  await edits.completeDelivery(files,'Agent',applied);await (saving??edits.save(document));
  assert.equal(calls[0].saves[0].intent,applied?'proposal':'author');
  assert.equal(calls[0].saves[0].staging,undefined);assert.equal(calls[0].saves[0].staged_intent,undefined);
 }
});

test('an unrepresentable author rebase can be explicitly retried as refinement without dropping saved points',async()=>{
 for(const resolve of [false,true]){
  const review={id:'review',workspace:'/editing',workspace_version:'B'},calls=[];
  const runtime={review,async request(route,body){if(route==='/summary')return review;calls.push(body);if(body.saves[0].intent==='author')throw Object.assign(new Error('Unrepresentable selection'),{capture:{file:'main.tex',save:body.saves[0].id,intent:'proposal'}});return {captured:body.saves.at(-1).id,cursor:body.saves.at(-1).id,workspace_version:'C'};}};
  const edits=createSourceEdits(runtime,{intent:()=> 'author',resolveCapture:async()=>resolve,onChange:async()=>{}});
  const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,getText:()=> 'Saved author draft'};
  if(resolve){await edits.save(document);assert.equal(calls[0].saves[0].id,calls[1].saves[0].id);assert.equal(calls[1].saves[0].intent,'proposal');assert.equal(edits.pending,false);}
  else{await assert.rejects(edits.save(document),/Unrepresentable/);assert.equal(edits.pending,true);assert.equal(calls.length,1);}
 }
});
