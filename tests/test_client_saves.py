import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which('node'), 'Node is needed only for client save checks.')
class ClientSaveTests(unittest.TestCase):
    def test_failed_draft_blocks_leaving_even_after_choices_save_succeeds(self):
        script = r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/m,'');
const flush=app.slice(app.indexOf('window.flushReview='),app.indexOf("$('library').addEventListener"));
const requests=[],elements=new Map();let fail=true;
const context={window:{},document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{className:'',textContent:'',hidden:true});return elements.get(id);},body:{classList:{contains:()=>false}}},setTimeout,clearTimeout,
fetch:async(path,options)=>{requests.push([path,JSON.parse(options.body)]);if(path==='/draft'&&fail)return {ok:false,json:async()=>({error:'Transient disk error'})};return {ok:true,json:async()=>({revision:0})};}};
vm.createContext(context);vm.runInContext(beginning+'\n'+flush+`
data={token:'test',revision:0,scope:'round'};drafts={passage:'Unsaved manuscript words'};
draftChanges.set('passage',drafts.passage);`,context);
await assert.rejects(context.window.flushReview(),/could not be saved/);
assert.equal(vm.runInContext('draftChanges.size',context),1);
assert.equal(vm.runInContext('drafts.passage',context),'Unsaved manuscript words');
assert.deepEqual(requests.map(([path])=>path),['/draft','/save']);
fail=false;await context.window.flushReview();
assert.equal(vm.runInContext('draftChanges.size',context),0);
assert.equal(requests.at(-1)[0],'/ui');
assert.equal(requests.filter(([path])=>path==='/draft').at(-1)[1].text,'Unsaved manuscript words');
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)
