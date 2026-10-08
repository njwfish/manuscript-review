import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

/** Keep one native window pinned while the provider creates its new tab. */
export function nativeSend(helper,request,open,{spawnProcess=spawn,timeout=25000,signal}={}){
 if(signal?.aborted)return Promise.reject(new Error('The native agent request was cancelled.'));
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(helper,[],{stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout});
  let done=false,opened=false,cancellation;
  const timer=setTimeout(()=>cancel(new Error('The agent handoff timed out. Check its tab before sending again.')),timeout);
  const abort=()=>cancel(new Error('The native agent request was cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});
  function cancel(error){
   if(done||cancellation)return;cancellation=error;
   // EOF lets the helper restore a temporary clipboard before it exits.
   child.stdin.end();
  }
  function finish(error){
   if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();child.kill();
   error=cancellation||error;error?reject(error):resolve();
  }
  child.on('error',finish);
  child.on('close',()=>finish(new Error('The native agent handoff closed unexpectedly.')));
  child.stdin.on('error',()=>{}); // A permission refusal may close before reading stdin.
  lines.on('line',line=>{
   let value;try{value=JSON.parse(line);}catch{finish(new Error('The native agent handoff returned an invalid response.'));return;}
   if(value.status==='ready'&&!opened){
    opened=true;Promise.resolve().then(()=>{if(!done&&!cancellation)return open();}).then(()=>{if(!done&&!cancellation)child.stdin.write('submit\n');}).catch(finish);
   }else if(value.status==='sent'&&opened)finish();
   else{const error=new Error(value.message||'The agent request was not sent.');error.code=value.status;finish(error);}
  });
  child.stdin.write(JSON.stringify(request)+'\n');
 });
}
