import {runTests} from '@vscode/test-electron';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const root=await realpath(await mkdtemp(path.join(tmpdir(),'mr-native-')));
const python=process.env.MR_TEST_PYTHON||path.join(app,'.venv/bin/python');
const repo=path.join(root,'paper'),home=path.join(root,'library'),fixture=path.join(root,'extension');
await mkdir(repo);await mkdir(fixture);await mkdir(path.join(root,'bin'));
await mkdir(path.join(root,'profile/User'),{recursive:true});
// Startup chat can take focus after the synthetic comment input is created.
await writeFile(path.join(root,'profile/User/settings.json'),JSON.stringify({
 'workbench.startupEditor':'none','chat.disableAIFeatures':true
}));
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
git('init','-q');git('config','user.name','Review Test');git('config','user.email','test@localhost');
const text='We score measured leaves. '+
 'This synthetic paragraph provides enough surrounding prose to inspect wrapping and focused review in a narrow editor. '.repeat(5)+
 '\n\nWe retain the explanation.\n\n\\begin{equation}\nx = a + b\n\\end{equation}\n';
await writeFile(path.join(repo,'pdf.tex'),'\\documentclass{article}\n\\begin{document}Synthetic PDF root.\\end{document}\n');
await writeFile(path.join(repo,'main.tex'),text);await writeFile(path.join(repo,'second.tex'),'We retain additional context.\n');git('add','.');git('commit','-qm','Starting draft');
const head=git('rev-parse','HEAD');
const review=execFileSync(python,['-c',`import sys;from manuscript_review.library import Library
library=Library(sys.argv[1]);library.prepare({'repo':sys.argv[2],'manuscript':True,'base':'working','proposed':'working'},'test');print(library.jobs['test']['review'])`,home,repo],{cwd:app,encoding:'utf8'}).trim();
await writeFile(path.join(root,'bin/codex'),'#!/bin/sh\ncat >/dev/null\n',{mode:0o755});
await writeFile(path.join(fixture,'fixture.json'),JSON.stringify({root,repo,home,review,python,package:path.join(app,'vscode'),head,text}));
const manifest=JSON.parse(await readFile(path.join(app,'vscode/package.json'),'utf8'));
await writeFile(path.join(fixture,'package.json'),JSON.stringify({...manifest,name:'native-workflow',publisher:'review-test',version:'0.0.1',main:'extension.cjs',activationEvents:['*']}));
await mkdir(path.join(fixture,'dist'),{recursive:true});
await cp(path.join(app,'vscode/dist/review.svg'),path.join(fixture,'dist/review.svg'));
await cp(path.join(app,'vscode/test/native/extension.cjs'),path.join(fixture,'extension.cjs'));
await cp(path.join(app,'vscode/test/native/suite.cjs'),path.join(fixture,'suite.cjs'));
const source=path.join(app,'vscode/src');
// Observe existing owners without adding test hooks to the product API.
await build({entryPoints:[path.join(source,'extension.mjs')],bundle:true,platform:'node',target:'node22',format:'cjs',external:['vscode'],outfile:path.join(fixture,'actual.cjs'),plugins:[{
 name:'native-test-observation',setup(builder){
  builder.onResolve({filter:/^\.\/(runtime|comments|decorations|pdf-panel)\.mjs$/},args=>args.importer===path.join(source,'extension.mjs')?{path:args.path.slice(2),namespace:'observe'}:undefined);
  builder.onLoad({filter:/.*/,namespace:'observe'},args=>{
   const name={ 'runtime.mjs':'createRuntime','comments.mjs':'createComments','decorations.mjs':'createDecorations','pdf-panel.mjs':'createPDFPanel'}[args.path];
   const extra=args.path==='pdf-panel.mjs'?'export {followWorkshopPDF} from '+JSON.stringify(path.join(source,args.path))+';':args.path==='comments.mjs'?'export {sourceFile,sourceDocument} from '+JSON.stringify(path.join(source,args.path))+';':'';
   return {contents:`import {${name} as original} from ${JSON.stringify(path.join(source,args.path))};${extra}
    export function ${name}(...args){
    ${args.path==='comments.mjs'?`const platform=args[0],proxy=Object.create(platform),window=Object.create(platform.window);
      globalThis.nativeReviewTest.commentErrors=[];
      Object.defineProperty(proxy,'window',{value:window});
      Object.defineProperty(window,'showErrorMessage',{value(message,...rest){
        globalThis.nativeReviewTest.commentErrors.push(message);return platform.window.showErrorMessage(message,...rest);
      }});
      args[0]=proxy;`:''}
    ${args.path==='pdf-panel.mjs'?`const platform=args[0];globalThis.nativeReviewTest.pdfMessages=[];
      const proxy=Object.create(platform),window=Object.create(platform.window);
      Object.defineProperty(proxy,'window',{value:window});
      Object.defineProperty(window,'createWebviewPanel',{value(...values){
        const panel=platform.window.createWebviewPanel(...values);
        panel.webview.onDidReceiveMessage(message=>globalThis.nativeReviewTest.pdfMessages.push(message));
        const post=panel.webview.postMessage.bind(panel.webview);
        Object.defineProperty(panel.webview,'postMessage',{value:async message=>{
          const delivered=await post(message);
          globalThis.nativeReviewTest.pdfMessages.push({direction:'out',type:message.type,url:message.url,document:message.document,selection:message.selection,marks:message.marks,delivered});
          return delivered;
        }});
        return panel;
      }});args[0]=proxy;`:''}
    const owner=original(...args);globalThis.nativeReviewTest[${JSON.stringify(args.path)}]=owner;return owner;}`,resolveDir:source,loader:'js'};
  });
 }}]});
console.log('Native fixture: '+root);
try{
 // Keep the real webview rendering while the user works in another macOS window.
 await runTests({extensionDevelopmentPath:fixture,extensionTestsPath:path.join(fixture,'suite.cjs'),
  ...(process.env.MR_TEST_CODE?{vscodeExecutablePath:process.env.MR_TEST_CODE}:{}),version:'stable',
  launchArgs:[repo,'--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-workspace-trust','--disable-extensions','--skip-welcome','--skip-release-notes','--user-data-dir',path.join(root,'profile'),'--extensions-dir',path.join(root,'extensions')],
  extensionTestsEnv:{MR_NATIVE_FIXTURE:root,MR_NATIVE_VISUAL:process.env.MR_NATIVE_VISUAL||''}});
 const result=JSON.parse(await readFile(path.join(root,'passed.json'),'utf8'));console.log(JSON.stringify(result,null,2));
 await rm(root,{recursive:true,force:true});
}catch(error){console.error('Native fixture retained at '+root);throw error;}
