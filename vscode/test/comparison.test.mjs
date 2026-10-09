import assert from 'node:assert/strict';
import test from 'node:test';
import {chooseComparison,comparisonRequest} from '../src/comparison.mjs';
import {comparisonContext} from '../../manuscript_review/review_model.js';

const first='1'.repeat(40),second='2'.repeat(40),third='3'.repeat(40);
const info={repo:'/manuscripts/paper',base:first,head:second,working_version:second,entries:['main.tex','supplement.tex'],
 references:[{name:'origin/main',revision:first,subject:'Original manuscript'}],
 commits:[{revision:second,subject:'A revised argument',short:second.slice(0,7),date:'2026-10-09',refs:'HEAD -> main'},
  {revision:first,subject:'Original manuscript',short:first.slice(0,7),date:'2026-10-08',refs:'origin/main'}]};

function fixture(steps){
 const calls=[];
 const select=(items,options)=>{calls.push({items,options});const step=steps.shift();assert.ok(step,'Unexpected picker');return step(items,options);};
 const vscode={QuickPickItemKind:{Separator:-1},QuickInputButtons:{Back:{iconPath:'back'}},window:{
  showQuickPick:async(items,options)=>select(items,options),
  createQuickPick(){
   const handlers={},picker={activeItems:[],buttons:[],onDidAccept:fn=>listen('accept',fn),onDidHide:fn=>listen('hide',fn),onDidTriggerButton:fn=>listen('back',fn),
    show(){const item=select(this.items,{title:this.title,activeItems:this.activeItems,buttons:this.buttons});if(item===undefined)handlers.hide();else if(item==='back')handlers.back();else{this.selectedItems=[item];handlers.accept();}},
    hide(){handlers.hide();},dispose(){this.disposed=true;}};
   function listen(name,fn){handlers[name]=fn;return {dispose(){delete handlers[name];}};}
   return picker;
  }
 }};
 return {vscode,calls};
}
const action=name=>items=>items.find(item=>item.action===name);

test('the default pair and document need one overview, with immutable commit endpoints',async()=>{
 const f=fixture([action('review')]),result=await chooseComparison(f.vscode,{info});
 assert.deepEqual(comparisonRequest(result),{repo:info.repo,base:first,base_label:'origin/main',proposed:'working',proposed_label:'Working files',entry:'main.tex'});
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].items.find(item=>item.action==='review').description,'origin/main → Working files');
 assert.match(f.calls[0].items.find(item=>item.action==='review').detail,/New comparison/);
});

test('changing either side keeps the other choice and shows both before creating a comparison',async()=>{
 const f=fixture([action('proposed'),items=>items.find(item=>item.revision===second),action('base'),items=>items.find(item=>item.revision===first&&item.label==='Original manuscript'),action('review')]);
 const result=await chooseComparison(f.vscode,{info,entry:'supplement.tex'});
 assert.equal(result.proposed.revision,second);assert.equal(result.base.label,'Original manuscript');assert.equal(result.entry,'supplement.tex');
 assert.equal(f.calls[1].items[0].label,'Working files');
 assert.deepEqual(f.calls[1].items.filter(item=>item.kind===-1).map(item=>item.label),['Branches and tags','Commits']);
 assert.equal(f.calls[2].items[0].description,'origin/main → A revised argument');
 assert.equal(f.calls[4].items[0].description,'Original manuscript → A revised argument');
 assert.deepEqual(f.calls[3].options.activeItems.map(item=>item.label),['origin/main']);
});

test('Back and Escape in an endpoint return to the intact overview',async()=>{
 const f=fixture([action('base'),()=> 'back',action('proposed'),()=>undefined,action('review')]);
 const result=await chooseComparison(f.vscode,{info});
 assert.equal(result.base.revision,first);assert.equal(result.proposed.revision,'working');
 assert.deepEqual(f.calls[1].options.buttons,[f.vscode.QuickInputButtons.Back]);
});

test('selected drafts create a revision-checked round retaining its baseline and discussion',async()=>{
 const review='a'.repeat(24),checkpoint={revision:third,review,review_revision:7,subject:'Round 3 selected draft',short:third.slice(0,7),date:'2026-10-09',entry:'supplement.tex'};
 const f=fixture([action('review')]),result=await chooseComparison(f.vscode,{info:{...info,base:third,checkpoints:[checkpoint]}});
 assert.deepEqual(comparisonRequest(result),{repo:info.repo,base:third,base_label:checkpoint.subject,proposed:'working',proposed_label:'Working files',entry:'supplement.tex',previous:review,expected_revision:7,require_changes:true});
 assert.match(f.calls[0].items[0].detail,/preserving the original baseline and discussion/);
});

test('fetching refreshes available history without moving the pinned choices',async()=>{
 const f=fixture([action('fetch'),action('proposed'),items=>items.find(item=>item.revision===third),action('review')]);
 let fetched;
 const result=await chooseComparison(f.vscode,{info:{...info,has_origin:true},fetch:async repo=>{fetched=repo;return {...info,references:[{name:'origin/main',revision:third,subject:'Latest remote'}]};}});
 assert.equal(fetched,info.repo);assert.equal(result.base.revision,first);assert.equal(result.proposed.revision,third);
 assert.equal(f.calls[1].items.find(item=>item.action==='base').detail,'Starting wording   1111111');
});

test('folder selection resets the pair and document together; cancellation keeps the setup intact',async()=>{
 const f=fixture([action('repository'),action('repository'),action('review')]);let attempts=0;
 const result=await chooseComparison(f.vscode,{info,chooseRepository:async()=>++attempts===1?undefined:{...info,repo:'/manuscripts/other',base:second,entries:['other.tex'],checkpoints:[]}});
 assert.equal(result.info.repo,'/manuscripts/other');assert.equal(result.base.revision,second);assert.equal(result.entry,'other.tex');
});

test('working files are captured at preparation rather than blocked by a cached empty comparison',async()=>{
 const f=fixture([action('review')]);
 const result=await chooseComparison(f.vscode,{info:{...info,trees:{[first]:'same-tree',[second]:'same-tree'}}});
 assert.equal(comparisonRequest(result).proposed,'working');
});

test('a cancelled history refresh retains all existing choices',async()=>{
 const f=fixture([action('fetch'),action('review')]);
 const result=await chooseComparison(f.vscode,{info:{...info,has_origin:true},fetch:async()=>undefined});
 assert.equal(result.base.revision,first);assert.equal(result.proposed.revision,'working');
});

test('the visible comparison labels stay compact while exact versions and scope remain inspectable',()=>{
 const data={repo:info.repo,base:first,proposed:third,base_label:'origin/main',proposal_label:`Working files (${third.slice(0,7)})`,scope:'round'};
 assert.equal(comparisonContext(data).from,'origin/main');assert.equal(comparisonContext(data).to,'Working files');
 assert.match(comparisonContext(data).title,new RegExp(first));assert.match(comparisonContext(data).title,/before accept\/reject/);
 const cumulative=comparisonContext({...data,scope:'baseline',proposal_label:`Selected manuscript (${third.slice(0,7)})`});
 assert.equal(cumulative.to,'Selected manuscript');assert.match(cumulative.title,/Original baseline/);
});
