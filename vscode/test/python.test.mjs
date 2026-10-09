import assert from 'node:assert/strict';
import test from 'node:test';
import {resolvePython} from '../src/python.mjs';

const result=(executable,version)=>({stdout:JSON.stringify({executable,version})});
test('automatic discovery skips an old Conda Python and finds Homebrew',async()=>{
 const calls=[];
 const python=await resolvePython('',{platform:'darwin',run:async(command,args)=>{
  calls.push(command);assert.equal(args[0],'-c');assert.doesNotMatch(args[1],/manuscript_review/);
  if(command==='python3')return result('/conda/python3.9',[3,9,21]);
  if(command==='/opt/homebrew/bin/python3')return result('/homebrew/python3.13',[3,13,2]);
  throw new Error('not found');
 }});
 assert.equal(python,'/homebrew/python3.13');assert.equal(calls[0],'python3');
});
test('an explicit older interpreter produces a concise error without substituting another',async()=>{
 const calls=[];
 await assert.rejects(resolvePython('/chosen/python',{run:async command=>{calls.push(command);return result(command,[3,9,21]);}}),/configured interpreter is Python 3\.9/);
 assert.deepEqual(calls,['/chosen/python']);
});
test('a supported interpreter resolves to its actual executable',async()=>{
 assert.equal(await resolvePython('python3',{run:async()=>result('/env/bin/python3.12',[3,12,0])}),'/env/bin/python3.12');
});
test('missing or malformed interpreters produce actionable errors',async()=>{
 await assert.rejects(resolvePython('',{platform:'linux',run:async()=>({stdout:'not Python'})}),/Install a current Python/);
 await assert.rejects(resolvePython('/missing/python',{run:async()=>{throw new Error('ENOENT');}}),/Check “Manuscript Review: Python Path”/);
});
