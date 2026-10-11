import path from 'node:path';
import {realpath} from 'node:fs/promises';

export const sourceScheme='manuscript-review-source';
const missingFile=error=>['ENOENT','ENOTDIR','FileNotFound'].includes(error.code);

export function snapshotFile(review,document){
 const uri=document?.uri;
 return review&&uri?.scheme===sourceScheme&&uri.authority===review.id?uri.path.slice(1):null;
}

export function snapshotVersion(document){
 return document?.uri.scheme===sourceScheme?new URLSearchParams(document.uri.query).get('version'):null;
}

/** Working files stay editable; missing files open as immutable Git documents. */
export function createSourceDocuments(vscode,getRuntime){
 const cache=new Map();
 const provider=vscode.workspace.registerTextDocumentContentProvider(sourceScheme,{
  async provideTextDocumentContent(uri){
   const key=uri.toString();
   if(cache.has(key))return cache.get(key);
   const version=new URLSearchParams(uri.query).get('version');
   if(!version)throw new Error('Choose a saved manuscript source version.');
   const runtime=await getRuntime();
   const source=await runtime.library('/source',{id:uri.authority,file:uri.path.slice(1),version});
   remember(key,source.text);
   return source.text;
  }
 });
 function remember(key,text){
  cache.delete(key);cache.set(key,text);
  if(cache.size>32)cache.delete(cache.keys().next().value);
 }
 async function open(file){
  const runtime=await getRuntime(),review=runtime.review;
  if(!review)throw new Error('Open the manuscript review before opening its source.');
  const repo=review.workspace||review.repo,requested=path.resolve(repo,file||''),relative=path.relative(repo,requested);
  if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith(`..${path.sep}`))
   throw new Error('Choose a source file in this manuscript.');
  const uri=vscode.Uri.file(requested);
  const buffer=vscode.workspace.textDocuments.find(document=>!document.isClosed&&document.uri.toString()===uri.toString());
  const relativeFile=relative.split(path.sep).join('/');
  const existing=vscode.workspace.textDocuments.find(document=>!document.isClosed&&snapshotFile(review,document)===relativeFile);
  if(existing&&!buffer)return existing;
  try{
   const canonical=await realpath(requested),resolvedRepo=await realpath(repo),resolved=path.relative(resolvedRepo,canonical);
   if(resolved==='..'||resolved.startsWith(`..${path.sep}`)||path.isAbsolute(resolved))
    throw new Error('The source file points outside this manuscript.');
   if(buffer)return buffer;
   const document=await vscode.workspace.openTextDocument(uri);
   if(runtime.review?.id!==review.id)throw new Error('The manuscript review changed. Open this location again.');
   return document;
  }catch(error){
   if(!missingFile(error)){
    // VS Code sometimes wraps a disappearance without a filesystem error code.
    let missing=false;
    try{await realpath(requested);}catch(current){missing=missingFile(current);}
    if(!missing)throw error;
   }
  }
  if(buffer)return buffer;
  const source=await runtime.library('/source',{id:review.id,file:relativeFile});
  if(runtime.review?.id!==review.id)throw new Error('The manuscript review changed. Open this location again.');
  const snapshot=vscode.Uri.from({scheme:sourceScheme,authority:review.id,path:'/'+source.file,query:'version='+source.source});
  remember(snapshot.toString(),source.text);
  return vscode.workspace.openTextDocument(snapshot);
 }
 return {open,dispose(){provider.dispose();cache.clear();}};
}
