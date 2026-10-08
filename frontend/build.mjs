import {build} from 'esbuild';
import {readFile, appendFile} from 'node:fs/promises';

const output='manuscript_review/editor.js';
const result=await build({entryPoints:['frontend/editor.js'],bundle:true,format:'esm',target:'safari16',minify:true,legalComments:'eof',outfile:output,metafile:true});
const packages=new Set(Object.keys(result.metafile.inputs).filter(path=>path.startsWith('node_modules/')).map(path=>{
  const parts=path.slice('node_modules/'.length).split('/');
  return parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];
}));
const licenses=new Map();
for(const name of [...packages].sort()){
  const license=(await readFile(`node_modules/${name}/LICENSE`,'utf8')).trim();
  licenses.set(license,[...(licenses.get(license)||[]),name]);
}
const notices=[...licenses].map(([license,names])=>`${names.join(', ')}\n\n${license}`).join('\n\n');
await appendFile(output,`\n/* Bundled third-party licenses\n\n${notices}\n*/\n`);
