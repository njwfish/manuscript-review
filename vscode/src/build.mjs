import {build} from 'esbuild';
import {cp,mkdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildViewer} from './build-viewer.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destination=join(root,'dist');
await rm(destination,{recursive:true,force:true});
await mkdir(destination,{recursive:true});
await build({entryPoints:[join(root,'src/extension.mjs')],bundle:true,platform:'node',target:'node22',format:'cjs',external:['vscode'],outfile:join(destination,'extension.cjs')});
await cp(join(root,'../manuscript_review'),join(destination,'runtime/manuscript_review'),{
 recursive:true,filter:file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')
});
await cp(join(root,'../LICENSE'),join(destination,'runtime/LICENSE'));
await buildViewer(join(destination,'viewer'));
