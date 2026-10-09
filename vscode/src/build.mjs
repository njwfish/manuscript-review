import {build} from 'esbuild';
import {cp,mkdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildViewer} from './build-viewer.mjs';
import {execFileSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destination=join(root,'dist');
await rm(destination,{recursive:true,force:true});
await mkdir(destination,{recursive:true});
if(process.platform==='darwin'){
 const source=join(root,'src/native-send.swift');
 for(const arch of ['arm64','x86_64'])execFileSync('xcrun',['swiftc','-O','-target',arch+'-apple-macos12',source,'-o',join(destination,'native-send-'+arch)]);
 execFileSync('lipo',['-create',...['arm64','x86_64'].map(arch=>join(destination,'native-send-'+arch)),'-output',join(destination,'native-send')]);
 for(const arch of ['arm64','x86_64'])await rm(join(destination,'native-send-'+arch));
 execFileSync('codesign',['--force','--sign','-',join(destination,'native-send')]);
}
await cp(join(root,'media/review.svg'),join(destination,'review.svg'));
await cp(join(root,'src/sidebar.js'),join(destination,'sidebar.js'));
await build({entryPoints:[join(root,'src/extension.mjs')],bundle:true,platform:'node',target:'node22',format:'cjs',external:['vscode'],outfile:join(destination,'extension.cjs')});
await cp(join(root,'../manuscript_review'),join(destination,'runtime/manuscript_review'),{
 recursive:true,filter:file=>!file.includes('__pycache__')&&!file.endsWith('.pyc')
});
await cp(join(root,'../LICENSE'),join(destination,'runtime/LICENSE'));
await cp(join(root,'README.md'),join(destination,'README.md'));
for(const file of ['README.md','ARCHITECTURE.md','docs','skills/manuscript-review'])
 await cp(join(root,'..',file),join(destination,'runtime',file),{recursive:true});
await mkdir(join(destination,'runtime/vscode'),{recursive:true});
await cp(join(root,'README.md'),join(destination,'runtime/vscode/README.md'));
await buildViewer(join(destination,'viewer'));
