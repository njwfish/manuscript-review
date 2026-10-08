'use strict';
import {manuscriptReviews} from './review_model.js';
let token,inspected=null,polling=false;
let repositoryInfo=null;
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const element=document.createElement(tag);if(cls)element.className=cls;if(text!==undefined)element.textContent=text;return element;};
const native=window.webkit?.messageHandlers?.chooseFolder;
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
async function post(path,value){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':token},body:JSON.stringify(value)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}
function action(text,fn,cls='quiet'){const b=node('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}
async function showSetup(){
 $('setup-message').textContent='';$('setup-message').className='form-error';$('setup-dialog').showModal();
 try{await loadSetup();}catch(error){$('setup-message').textContent=error.message;}
}
async function loadSetup(){
 const response=await fetch('/setup');if(!response.ok)throw new Error('Could not check setup.');const info=await response.json();
 const row=(name,state)=>{const item=node('div','setup-row'),label=node('div','setup-label');label.append(node('div','setup-name',name),node('div','setup-state',state));item.append(label);return item;};
 const missing=Object.entries(info.preview_tools).filter(([name,path])=>!path).map(([name])=>name);
 const git=row('Git',info.git?'Ready':'Install Git to compare manuscript versions');
 const previews=row('Equation and algorithm previews',missing.length?'Optional · missing '+missing.join(', '):'Ready');
 $('setup-tools').replaceChildren(git,previews);
 $('setup-agents').replaceChildren(...info.agents.map(agent=>{
  const item=row(agent.name,agent.installed?'Skill installed':agent.occupied?'Existing path needs attention':'Skill not installed');
  const location=node('details');location.append(node('summary','','Skill location'),node('code','',agent.path));item.firstChild.append(location);
  if(!agent.occupied){const install=action('Install skill',async()=>{
   install.disabled=true;$('setup-message').textContent='';
   try{const result=await post('/install-skill',{agent:agent.id});await loadSetup();$('setup-message').className='form-error';$('setup-message').textContent=result.message;}
   catch(error){$('setup-message').className='form-error error';$('setup-message').textContent=error.message;install.disabled=false;}
  });install.disabled=!info.skill_available;item.append(install);}
  return item;
 }));
 if(!info.skill_available){$('setup-message').className='form-error error';$('setup-message').textContent='The bundled skill is unavailable. Install from the app release or a source checkout.';}
}
$('setup').addEventListener('click',showSetup);
window.showSetup=showSetup;
function sourceMode(github){
 $('local-source').hidden=github;$('github-source').hidden=!github;$('repo').required=!github;
 $('local-mode').setAttribute('aria-pressed',!github);$('github-mode').setAttribute('aria-pressed',github);
 inspected=null;repositoryInfo=null;$('base').disabled=$('proposed').disabled=true;$('versions').hidden=$('create-submit').hidden=$('repo-choice-field').hidden=true;$('create-error').textContent='';
 $(github?'github-url':'repo').focus();
}
function create(repo){sourceMode(false);if(repo)$('repo').value=repo;$('create').showModal();$('repo').focus();if(repo)inspect();}
async function openReview(id){try{const result=await post('/open',{id});window.location.assign(result.url);}catch(error){message(error.message,true);}}
async function waitForJob(id){
 for(;;){
  const response=await fetch('/jobs/'+id);if(!response.ok)throw new Error('Could not read the operation status.');const job=await response.json();
  if(job.status==='ready')return job;
  if(job.status==='error')throw new Error(job.error);
  await new Promise(resolve=>setTimeout(resolve,500));
 }
}
async function openPrepared(id){
 message('Preparing comparison…');const job=await waitForJob(id);
 message(job.reused?'No new source changes. Reopened the current round.':`${job.edits} new edits. Earlier rounds preserved.`);await refresh();await openReview(job.review);
}
async function updateReview(id,b){
 b.disabled=true;
 try{const result=await post('/update',{id});await openPrepared(result.job);}catch(error){message(error.message,true);}finally{b.disabled=false;}
}
function roundStatus(review){
 if(!review.total)return 'No changes';
 if(review.done!==review.total)return `${review.done} / ${review.total} reviewed`;
 return review.applied?'Applied to manuscript':'Ready to apply';
}
function reviewCard(rounds){
 const review=rounds[0],card=node('article','review'),content=node('div','review-content');
 const name=review.repo.split('/').pop();content.append(node('h3','',name));
 if(review.title!==name)content.append(node('div','round-title',review.title));
 content.append(node('div','versions',`${review.base_label} → ${review.proposal_label}`));
 const date=new Date(review.created).toLocaleDateString(undefined,{month:'short',day:'numeric'});
 const rendering=['queued','rendering'].includes(review.preview_status);
 const meta=node('div','meta',`${roundStatus(review)} · ${review.files} ${review.files===1?'file':'files'} · ${date}${rendering?' · Typesetting…':''}`);meta.title=review.repo;content.append(meta);
 if(review.preview_status==='error'){const detail=node('details'),summary=node('summary','','Typeset preview unavailable');detail.append(summary,node('pre','',review.preview_error||'Word changes are available.'));content.append(detail);}
 if(review.skipped?.length){const detail=node('details');detail.append(node('summary','',`${review.skipped.length} non-text or unsupported files omitted`),node('pre','',review.skipped.join('\n')));content.append(detail);}
 const controls=node('div','review-actions'),update=action('New round',()=>updateReview(review.id,update));update.title='Review working files against the latest selected draft';controls.append(action('Compare…',()=>create(review.repo)),update,action('Open latest',()=>openReview(review.id),'primary'));
 const top=node('div','review-current');top.append(content,controls);card.append(top);
 if(rounds.length>1){
  const history=node('details','review-history');history.dataset.repo=review.repo;
  history.append(node('summary','',`History · ${rounds.length} rounds`));
  rounds.forEach((round,index)=>{
   const row=node('div','history-round'),label=node('div','history-content');
   const when=new Date(round.created).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
   label.append(node('div','history-title',`Round ${rounds.length-index}${index===0?' · Latest':''} · ${round.title}`),node('div','versions',`${round.base_label} → ${round.proposal_label}`),node('div','meta',`${roundStatus(round)} · ${when}${round.comments?` · ${round.comments} comments`:''}`));
   row.append(label,action('Open',()=>openReview(round.id)));history.append(row);
  });card.append(history);
 }
 return card;
}
async function refresh(){
 const response=await fetch('/library-data');if(!response.ok)throw new Error('Could not load your review library.');const data=await response.json();token=data.token;
 const expanded=new Set([...document.querySelectorAll('.review-history[open]')].map(history=>history.dataset.repo));
 $('reviews').replaceChildren(...manuscriptReviews(data.reviews).map(reviewCard));
 document.querySelectorAll('.review-history').forEach(history=>{history.open=expanded.has(history.dataset.repo);});
 if(!data.reviews.length){const empty=node('div','empty');empty.append(node('h3','','Start with a manuscript'),node('p','','Choose a folder or a GitHub repository, then pick two versions.'),action('Compare versions',()=>create(),'primary'));$('reviews').append(empty);}
 if(data.reviews.some(r=>['queued','rendering'].includes(r.preview_status))&&!polling){polling=true;setTimeout(async()=>{polling=false;try{await refresh();}catch(error){message(error.message,true);}},2500);}
}
function versionChoices(){
 const info=repositoryInfo,query=$('commit-filter').value.toLowerCase();if(!info)return;
 for(const id of ['base','proposed']){
  const select=$(id),selected=select.value||(id==='base'?info.base:'working'),groups=[];
  const addGroup=(name,rows)=>{const group=node('optgroup');group.label=name;
   for(const row of rows){if(query&&!row.label.toLowerCase().includes(query)&&row.value!==selected)continue;
    const option=node('option','',row.label);option.value=row.value;group.append(option);
   }if(group.children.length)groups.push(group);
  };
  if(id==='proposed')addGroup('Your folder',[{value:'working',label:info.dirty?'Working files · includes uncommitted edits':'Working files · matches latest commit'}]);
  addGroup('Saved review checkpoints',info.checkpoints.map(c=>({value:c.revision,label:`${c.date} · ${c.subject} · ${c.short}`})));
  addGroup('Branches and tags',info.references.map(r=>({value:r.revision,label:`${r.name} · ${r.subject} · ${r.revision.slice(0,7)}`})));
  addGroup('Recent commits',info.commits.map(c=>({value:c.revision,label:`${c.date} · ${c.subject} · ${c.short}`})));
  select.replaceChildren(...groups);select.value=selected;
 }
 comparisonSummary();
}
function comparisonSummary(){
 if(!repositoryInfo)return;
 const from=$('base').value,to=$('proposed').value,same=from&&to&&repositoryInfo.trees[from]===repositoryInfo.trees[to==='working'?repositoryInfo.working_version:to];
 $('create-submit').disabled=!from||!to||same;
 $('comparison-summary').textContent=same?'These versions match. Choose an earlier version to see changes.':`Selected versions: ${from.slice(0,7)} → ${to==='working'?'working files':to.slice(0,7)}`;
}
async function inspect(){
 $('inspect').disabled=true;$('inspect').textContent='Loading…';inspected=null;repositoryInfo=null;$('base').disabled=$('proposed').disabled=true;$('versions').hidden=$('create-submit').hidden=true;$('create-error').textContent='';
 try{const info=await post('/inspect',{repo:$('repo').value});
  if(info.repositories){const placeholder=node('option','','Choose a repository…');placeholder.value='';placeholder.disabled=placeholder.selected=true;$('repo-choice').replaceChildren(placeholder,...info.repositories.map(path=>{const option=node('option','',path);option.value=path;return option;}));$('repo-choice-field').hidden=false;$('repo-choice').focus();return;}
  inspected=info.repo;repositoryInfo=info;$('fetch').hidden=!info.has_origin;$('repo').value=info.repo;$('commit-filter').value='';$('base').replaceChildren();$('proposed').replaceChildren();versionChoices();$('repo-choice-field').hidden=true;
  $('entry').replaceChildren(...[...info.entries,''].map(entry=>{const o=node('option','',entry||'Word changes only');o.value=entry;return o;}));
  $('versions').hidden=false;$('create-submit').hidden=false;$('base').disabled=$('proposed').disabled=false;$('base').focus();
 }catch(error){$('create-error').textContent=error.message;}finally{$('inspect').disabled=false;$('inspect').textContent='Show versions';}
}
$('new').addEventListener('click',()=>create());$('inspect').addEventListener('click',inspect);
$('local-mode').addEventListener('click',()=>sourceMode(false));$('github-mode').addEventListener('click',()=>sourceMode(true));
$('repo-choice').addEventListener('change',()=>{if($('repo-choice').value){$('repo').value=$('repo-choice').value;inspect();}});
$('commit-filter').addEventListener('input',versionChoices);for(const id of ['base','proposed'])$(id).addEventListener('change',comparisonSummary);
async function clone(){
 $('clone').disabled=true;$('clone-status').textContent='Cloning repository…';$('create-error').textContent='';
 try{const result=await post('/clone',{url:$('github-url').value,directory:$('directory').value}),job=await waitForJob(result.job);
  $('repo').value=job.repo;sourceMode(false);await inspect();
 }catch(error){$('create-error').textContent=error.message;}finally{$('clone-status').textContent='';$('clone').disabled=false;}
}
$('clone').addEventListener('click',clone);
$('fetch').addEventListener('click',async()=>{
 $('fetch').disabled=true;$('fetch').textContent='Fetching…';$('create-error').textContent='';
 try{const result=await post('/fetch',{repo:inspected});await waitForJob(result.job);await inspect();}
 catch(error){$('create-error').textContent=error.message;}finally{$('fetch').disabled=false;$('fetch').textContent='Fetch latest commits';}
});
$('repo').addEventListener('input',()=>{inspected=null;repositoryInfo=null;$('base').disabled=$('proposed').disabled=true;$('versions').hidden=true;$('create-submit').hidden=true;});
$('repo').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();inspect();}});
$('create-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!$('github-source').hidden)return clone();if(!inspected)return inspect();$('create-submit').disabled=true;$('create-error').textContent='';
 try{const result=await post('/prepare',{repo:inspected,base:$('base').value,base_label:$('base').selectedOptions[0].textContent,proposed:$('proposed').value,entry:$('entry').value});$('create').close();await openPrepared(result.job);}catch(error){if($('create').open)$('create-error').textContent=error.message;else message(error.message,true);}finally{$('create-submit').disabled=false;}
});
$('import').addEventListener('click',()=>{$('import-error').textContent='';$('import-dialog').showModal();$('source').focus();});
$('import-form').addEventListener('submit',async event=>{event.preventDefault();$('import-submit').disabled=true;try{await post('/import',{source:$('source').value});$('import-dialog').close();await refresh();message('Imported a separate copy of the review.');}catch(error){$('import-error').textContent=error.message;}finally{$('import-submit').disabled=false;}});
document.querySelectorAll('.close').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
if(native){for(const id of ['repo','source','directory']){$('browse-'+id).hidden=false;$('browse-'+id).addEventListener('click',()=>native.postMessage({field:id}));}}
window.folderChosen=(field,path)=>{$(field).value=path;if(field==='repo')inspect();};
document.addEventListener('keydown',event=>{if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.target.matches('input,textarea,select')||document.querySelector('dialog[open]'))return;if(event.key.toLowerCase()==='n'){event.preventDefault();create();}});
window.addEventListener('focus',()=>refresh().catch(error=>message(error.message,true)));
refresh().catch(error=>message(error.message,true));
