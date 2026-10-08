import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const probe='import json, sys; print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable}))';

/** Probe without importing the engine, so unsupported environments fail cleanly. */
export async function resolvePython(configured='',{platform=process.platform,run=execute}={}){
 const candidates=configured.trim()?[configured.trim()]:[
  'python3','python3.14','python3.13','python3.12','python',
  ...(platform==='darwin'?['/opt/homebrew/bin/python3','/usr/local/bin/python3']:[])
 ];
 for(const candidate of candidates){
  let info;
  try{info=JSON.parse((await run(candidate,['-c',probe],{timeout:5000,maxBuffer:4096})).stdout);}
  catch{continue;}
  if(typeof info.executable!=='string'||!info.executable||!Array.isArray(info.version))continue;
  const [major,minor]=info.version;
  if(major===3&&minor>=12)return info.executable;
  if(configured.trim())throw new Error(`Manuscript Review needs Python 3.12 or newer. The configured interpreter is Python ${major}.${minor}. Clear “Manuscript Review: Python Path” to find a supported interpreter automatically.`);
 }
 throw new Error(configured.trim()
  ?'Cannot run the configured Python interpreter. Check “Manuscript Review: Python Path”, or clear it to find Python automatically.'
  :'Manuscript Review needs Python 3.12 or newer. Install a current Python, or select its executable in “Manuscript Review: Python Path”.');
}
