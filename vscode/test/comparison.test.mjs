import assert from 'node:assert/strict';
import test from 'node:test';
import {comparisonState,reviewComparison,changeComparison,comparisonRequest,refreshComparison,comparisonMatches} from '../src/comparison.mjs';

const first='1'.repeat(40),second='2'.repeat(40),third='3'.repeat(40);
const info={repo:'/manuscripts/paper',base:first,head:second,working_version:second,entries:['main.tex','supplement.tex'],
 references:[{name:'origin/main',revision:first,subject:'Original manuscript'}],
 commits:[{revision:second,subject:'A revised argument',short:second.slice(0,7),date:'2026-10-09'},
  {revision:first,subject:'Original manuscript',short:first.slice(0,7),date:'2026-10-08'}]};
function fixture(choose){
 const calls=[],vscode={QuickPickItemKind:{Separator:-1},window:{
  showQuickPick:async(items,options)=>{calls.push({items,options});return choose(items,options);},
  createQuickPick(){
   const handlers={},picker={onDidAccept:fn=>listen('accept',fn),onDidHide:fn=>listen('hide',fn),
    show(){calls.push({items:this.items,options:{title:this.title,activeItems:this.activeItems}});const item=choose(this.items);if(item===undefined)this.hide();else{this.selectedItems=[item];handlers.accept();}},
    hide(){handlers.hide();},dispose(){}};
   function listen(name,fn){handlers[name]=fn;return {dispose(){delete handlers[name];}};}
   return picker;
  }
 }};
 return {calls,vscode};
}

test('sidebar defaults use a pinned starting commit and snapshot working files only when requested',()=>{
 const f=fixture(),state=comparisonState(f.vscode,info);
 assert.deepEqual(comparisonRequest(state),{repo:info.repo,base:first,base_label:'origin/main',proposed:'working',proposed_label:'Working files',entry:'main.tex'});
 assert.equal(f.calls.length,0);
});

test('changing an endpoint keeps the other endpoint and document without preparing anything',async()=>{
 const f=fixture(items=>items.find(item=>item.revision===second));
 const state=comparisonState(f.vscode,info,'supplement.tex'),next=await changeComparison(f.vscode,state,'proposed');
 assert.equal(next.base,state.base);assert.equal(next.entry,'supplement.tex');assert.equal(next.proposed.revision,second);assert.equal(next.pending,true);
 assert.equal(state.proposed.revision,'working');assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].items.filter(item=>item.kind===-1).map(item=>item.label),['Branches and tags','Commits']);
});

test('cancelling a version or PDF picker retains the exact comparison setup',async()=>{
 const f=fixture(()=>undefined),state=comparisonState(f.vscode,info);
 for(const field of ['base','proposed','entry'])assert.equal(await changeComparison(f.vscode,state,field),state);
});

test('review fields show the actual fixed endpoints and retain a checkpoint’s revision guard',()=>{
 const review='a'.repeat(24),checkpoint={revision:first,review,review_revision:7,subject:'Selected draft',short:'1111111',date:'2026-10-09'};
 const f=fixture(),state=comparisonState(f.vscode,{...info,checkpoints:[checkpoint]});
 const actual=reviewComparison(state,{repo:info.repo,scope:'round',base:first,proposed:third,base_label:'Initial draft (1111111)',proposal_label:'Proposal + local edits (3333333)',entry:'supplement.tex'});
 assert.equal(actual.base.label,'Initial draft');assert.equal(actual.proposed.label,'Proposal + local edits');assert.equal(actual.proposed.revision,third);
 assert.equal(actual.entry,'supplement.tex');assert.equal(comparisonRequest(actual).previous,review);assert.equal(comparisonRequest(actual).expected_revision,7);
});

test('a captured proposal not in ordinary Git history stays visible and selected in the picker',async()=>{
 const f=fixture(()=>undefined),state=reviewComparison(comparisonState(f.vscode,info),{repo:info.repo,scope:'round',base:first,proposed:third,base_label:'Initial draft',proposal_label:'Proposal + local edits',entry:''});
 await changeComparison(f.vscode,state,'proposed');
 assert.equal(f.calls[0].items[0].revision,third);assert.equal(f.calls[0].options.activeItems[0].label,'Proposal + local edits');
});

test('PDF selection and Source only are independent of the pinned pair',async()=>{
 const f=fixture(()=> 'Source only'),state=comparisonState(f.vscode,info,'supplement.tex');
 const next=await changeComparison(f.vscode,state,'entry');assert.equal(next.entry,'');assert.equal(next.base,state.base);assert.equal(next.proposed,state.proposed);
});

test('accepting the active endpoint does not stage a new comparison',async()=>{
 const f=fixture(items=>items.find(item=>item.revision===first&&item.label==='origin/main'));
 const current=comparisonState(f.vscode,info),next=await changeComparison(f.vscode,current,'base');
 assert.equal(next,current);assert.equal(next.pending,undefined);
});

test('fresh history keeps staged endpoints and refreshes their checkpoint guard',()=>{
 const f=fixture(),checkpoint={revision:first,review:'saved-round',review_revision:7,subject:'Selected draft',short:'1111111',date:'2026-10-09'};
 const state={...comparisonState(f.vscode,{...info,checkpoints:[checkpoint]},'supplement.tex'),pending:true};
 const next=refreshComparison(f.vscode,state,{...info,checkpoints:[{...checkpoint,review_revision:8}],commits:[{revision:third,subject:'Latest proposal',short:'3333333',date:'2026-10-10'},...info.commits]});
 assert.equal(next.pending,true);assert.equal(next.entry,state.entry);assert.equal(next.base.revision,first);assert.equal(next.proposed,state.proposed);
 assert.equal(comparisonRequest(next).expected_revision,8);assert.equal(next.choices.find(item=>item.revision===third).label,'Latest proposal');
});

test('reuse requires the actual pair, source checkout, and PDF document',()=>{
 const f=fixture(),data={repo:info.repo,base:first,proposed:third,base_label:'Initial draft',proposal_label:'Proposal',entry:'main.tex'};
 const state=reviewComparison(comparisonState(f.vscode,info),data);
 assert.equal(comparisonMatches(state,data),true);
 for(const change of [{pending:true},{entry:'supplement.tex'},{info:{...info,workspace:'/other/checkout'}},{base:{revision:second}},{proposed:{revision:second}}])
  assert.equal(comparisonMatches({...state,...change},data),false);
});
