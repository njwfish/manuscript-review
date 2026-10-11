import assert from 'node:assert/strict';
import test from 'node:test';
import {createSourceEdits} from '../src/source-edits.mjs';

function fixture(options={}){
 const events=[],review={id:'review',repo:'/original',workspace:'/editing',workspace_version:'B'};
 const runtime={review,async data(){events.push('data');return {...this.review};},async request(route,body){events.push({route,body});await options.capture?.(body);}};
 const document={uri:{scheme:'file',fsPath:'/editing/main.tex'},isDirty:false,version:1,text:'B edited',getText(){return this.text;}};
 const edits=createSourceEdits(runtime,{async flushPanel(value){events.push({flush:value});await options.flush?.();return 'lock';},
  unlockPanel(lock){events.push({unlock:lock});},async refreshPanel(value){events.push({refresh:value});},async refreshComments(){events.push('comments');}});
 return {events,runtime,document,edits};
}

test('native Save flushes pending author choices, captures B plus edits, and refreshes without taking focus',async()=>{
 const f=fixture();await f.edits.save(f.document);
 assert.deepEqual(f.events,[{flush:{lock:true}},'data',{route:'/capture',body:{file:'main.tex',text:'B edited',source:'B'}},
  {refresh:{flushed:true}},'comments',{unlock:'lock'}]);
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

test('a newer Save during the author-state flush coalesces into the latest saved text',async()=>{
 let release,entered;const enteredFlush=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 let count=0;const f=fixture({async flush(){if(++count===1){entered();await blocked;}}});
 const first=f.edits.save(f.document);await enteredFlush;
 f.document.version++;f.document.text='Latest saved wording';const second=f.edits.save(f.document);release();
 await Promise.all([first,second]);
 assert.deepEqual(f.events.filter(event=>event.route).map(event=>event.body.text),['Latest saved wording']);
 assert.equal(f.events.filter(event=>event.unlock).length,2);assert.equal(f.edits.pending,false);
});

test('typing after Save keeps the saved comparison and leaves the newer dirty buffer to VS Code',async()=>{
 const f=fixture({flush(){f.document.isDirty=true;f.document.version++;f.document.text='Unsaved wording';}});
 await f.edits.save(f.document);
 assert.equal(f.events.find(event=>event.route).body.text,'B edited');assert.equal(f.edits.pending,false);
 assert.equal(f.document.text,'Unsaved wording');assert.deepEqual(f.events.at(-1),{unlock:'lock'});
});

test('capture failures retain the saved work for retry and release the focused review lock',async()=>{
 let fail=true;const f=fixture({capture(){if(fail)throw new Error('Stale review');}});
 await assert.rejects(f.edits.save(f.document),/Stale review/);
 assert.equal(f.edits.pending,true);assert.deepEqual(f.events.at(-1),{unlock:'lock'});
 fail=false;await f.edits.flush();assert.equal(f.edits.pending,false);
 assert.equal(f.events.filter(event=>event.route).length,2);
});

test('switching or disposing a review while flush waits cannot capture into the new review',async()=>{
 for(const action of [f=>f.runtime.review={...f.runtime.review,id:'other'},f=>f.edits.dispose()]){
  const f=fixture({flush(){action(f);}});
  await assert.rejects(f.edits.save(f.document),/review changed/);
  assert.equal(f.events.some(event=>event.route),false);assert.deepEqual(f.events.at(-1),{unlock:'lock'});
 }
});

test('multiple saved files capture serially using the latest physical source version',async()=>{
 let entered,release;const blocked=new Promise(resolve=>release=resolve),capturing=new Promise(resolve=>entered=resolve);
 const f=fixture({async capture(body){if(body.file==='main.tex'){entered();await blocked;f.runtime.review.workspace_version='B plus main';}}});
 const first=f.edits.save(f.document);await capturing;
 const second=f.edits.save({...f.document,uri:{scheme:'file',fsPath:'/editing/second.tex'},text:'Second file'});release();await Promise.all([first,second]);
 assert.deepEqual(f.events.filter(event=>event.route).map(event=>[event.body.file,event.body.source]),[['main.tex','B'],['second.tex','B plus main']]);
});
