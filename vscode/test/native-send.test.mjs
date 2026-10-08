import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {nativeSend} from '../src/native-send.mjs';

function fixture(){
 const child=new EventEmitter(),writes=[];child.stdout=new PassThrough();child.stdin=new PassThrough();
 child.stdin.on('data',data=>writes.push(data.toString()));child.kill=()=>{child.killed=true;};
 return {child,writes,spawnProcess:()=>child,emit:status=>child.stdout.write(JSON.stringify(status)+'\n')};
}

test('native submission opens only after permission and waits for the new tab before sending once',async()=>{
 const f=fixture();let opened=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const task=nativeSend('/helper',{extension:'anthropic.claude-code',prompt:'Exact request\n\\alpha'},async()=>{opened++;await gate;},{spawnProcess:f.spawnProcess});
 assert.equal(opened,0);assert.equal(JSON.parse(f.writes[0]).prompt,'Exact request\n\\alpha');
 f.emit({status:'ready'});await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,1);assert.equal(f.writes.length,1);
 release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.writes[1],'submit\n');
 f.emit({status:'sent'});await task;assert.equal(f.writes.length,2);assert.equal(f.child.killed,true);
});

test('permission refusal preserves the request without opening or clicking another surface',async()=>{
 const f=fixture();let opened=false;
 const task=nativeSend('/helper',{prompt:'Comment'},()=>{opened=true;},{spawnProcess:f.spawnProcess});
 const result=assert.rejects(task,error=>error.code==='permission'&&/Accessibility/.test(error.message));
 f.emit({status:'permission',message:'Enable Accessibility.'});await result;
 assert.equal(opened,false);assert.equal(f.writes.length,1);
});

test('an uncertain Send is reported without retrying or opening another agent',async()=>{
 const f=fixture();let opened=0;
 const task=nativeSend('/helper',{prompt:'Comment'},()=>{opened++;},{spawnProcess:f.spawnProcess});
 f.emit({status:'ready'});await new Promise(resolve=>setImmediate(resolve));
 const result=assert.rejects(task,error=>error.code==='uncertain');f.emit({status:'uncertain',message:'Check before sending again.'});await result;
 assert.equal(opened,1);assert.deepEqual(f.writes.slice(1),['submit\n']);
});

test('closed helpers and failed provider commands release the handoff without submitting',async()=>{
 for(const failure of ['close','command']){
  const f=fixture();const task=nativeSend('/helper',{prompt:'Comment'},()=>{throw new Error('Provider failed.');},{spawnProcess:f.spawnProcess});
  const result=assert.rejects(task,failure==='close'?/closed unexpectedly/:/Provider failed/);
  if(failure==='close')f.child.emit('close');else f.emit({status:'ready'});
  await result;assert.equal(f.writes.length,1);assert.equal(f.child.killed,true);
 }
});

test('timeout and deactivation close stdin and allow clipboard cleanup before terminating the helper',async()=>{
 for(const reason of ['timeout','abort']){
  const f=fixture(),controller=new AbortController();let opened=0;
  const task=nativeSend('/helper',{prompt:'Comment'},()=>{opened++;},{spawnProcess:f.spawnProcess,signal:controller.signal,timeout:reason==='timeout'?1:1000});
  const rejected=assert.rejects(task,reason==='timeout'?/timed out/:/cancelled/);
  if(reason==='abort')controller.abort();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.child.stdin.writableEnded,true);assert.equal(f.child.killed,undefined);assert.equal(opened,0);
  f.emit({status:'error',message:'Cleanup finished.'});await rejected;assert.equal(f.child.killed,true);
 }
});

test('an already cancelled extension cannot spawn a handoff',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(nativeSend('/helper',{},()=>{},{signal:controller.signal,spawnProcess:()=>{throw new Error('Must not spawn.');}}),/cancelled/);
});
