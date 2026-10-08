import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm','.woff2':'font/woff2'};

/** Serve bundled viewer files only. Manuscript PDFs stay on the private host bridge. */
export function createViewer(directory){
 let server,starting,origin,closed=false;
 async function start(){
  if(closed)throw new Error('The PDF viewer has closed.');
  if(starting)return starting;
  starting=(async()=>{
   const root=await realpath(directory);
   if(closed)throw new Error('The PDF viewer has closed.');
   server=createServer(async(request,response)=>{
    const reply=(status,body)=>{response.writeHead(status,{'Content-Type':'text/plain'});response.end(body);};
    if(!/^(?:127\.0\.0\.1|localhost):[1-9]\d*$/.test(request.headers.host||''))return reply(403,'Forbidden');
    if(!['GET','HEAD'].includes(request.method))return reply(405,'Method not allowed');
    try{
     const filename=await realpath(path.join(root,decodeURIComponent(new URL(request.url,origin).pathname)));
     const relative=path.relative(root,filename);
     if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return reply(404,'Not found');
     const bytes=await readFile(filename);
     response.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream','Content-Length':bytes.length,
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' blob: data:; frame-ancestors vscode-webview: vscode-file:; base-uri 'none'; form-action 'none'"});
     response.end(request.method==='HEAD'?undefined:bytes);
    }catch{reply(404,'Not found');}
   });
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   origin='http://127.0.0.1:'+server.address().port;
   return origin;
  })();
  return starting;
 }
 async function dispose(){closed=true;await starting?.catch(()=>{});server?.close();server?.closeAllConnections();}
 return {start,dispose};
}
