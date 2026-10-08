import {cp,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const execute=promisify(execFile);
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";

export function createAgentTools({extensionPath,storagePath,version,python='python3'}){
 let preparing,interpreter;
 const root=path.join(storagePath,'tools',version),skill=path.join(storagePath,'skills','manuscript-review');
 const launcher=path.join(skill,'scripts','review-agent');
 async function prepare(python){
  if(preparing&&python===interpreter)return preparing;
  interpreter=python;
  preparing=(async()=>{
   await mkdir(path.dirname(root),{recursive:true});
   try{await readFile(path.join(root,'.complete'));}
   catch(error){if(error.code!=='ENOENT')throw error;await cp(path.join(extensionPath,'dist','runtime'),root,{recursive:true});await writeFile(path.join(root,'.complete'),version);}
   await mkdir(path.dirname(skill),{recursive:true});
   await cp(path.join(root,'skills/manuscript-review'),skill,{recursive:true,filter:file=>file!==path.join(root,'skills/manuscript-review/scripts/review-agent')});
   for(const file of ['README.md','ARCHITECTURE.md','LICENSE','docs','vscode'])await cp(path.join(root,file),path.join(storagePath,file),{recursive:true});
   const temporary=launcher+'.'+randomUUID()+'.tmp';
   await writeFile(temporary,`#!/bin/sh\nset -eu\nexport PYTHONPATH=${quote(root)}\nexec ${quote(python)} -m manuscript_review.agent "$@"\n`,{mode:0o755});
   await rename(temporary,launcher);
   return launcher;
  })().catch(error=>{preparing=undefined;throw error;});
  return preparing;
 }
 async function run(command,args,source){
  try{
   const result=await execute(command,['-m','manuscript_review.agent',...args],{env:{...process.env,PYTHONPATH:source},maxBuffer:1_000_000});
   return JSON.parse(result.stdout);
  }catch(error){throw new Error(error.stderr?.trim()||error.message);}
 }
 async function setup(){
  const result=await run(python,['setup'],path.join(extensionPath,'dist','runtime'));
  await prepare(result.python);return result;
 }
 async function install(agent){
  if(!['codex','claude'].includes(agent))throw new Error('Choose Codex or Claude Code.');
  if(!preparing)throw new Error('Open Setup before installing the agent skill.');
  await preparing;
  return run(interpreter,['install-skill','--agent',agent,'--source',skill],root);
 }
 return {prepare,setup,install,get launcher(){return launcher;},get command(){return quote(launcher);}};
}
