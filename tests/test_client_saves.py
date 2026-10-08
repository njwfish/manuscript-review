import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which('node'), 'Node is needed only for client save checks.')
class ClientSaveTests(unittest.TestCase):
    def test_source_editor_preserves_newlines_and_tracks_changes(self):
        script = r"""import assert from 'node:assert/strict';
import {createSourceState} from './frontend/editor.js';
import {EditorView} from '@codemirror/view';
for (const newline of ['\n', '\r\n']) {
  const source = `First α😀 line.${newline}Second old line.${newline}`;
  const start = source.indexOf('old');
  const state = createSourceState(source, [{id:'edit',from:start,to:start+3}], start);
  assert.equal(state.sliceDoc(),source);
  assert.equal(state.sliceDoc(state.selection.main.head,state.selection.main.head+3),'old');
  const changed=state.update({changes:{from:state.selection.main.head,to:state.selection.main.head+3,insert:'new words'}}).state;
  assert.equal(changed.sliceDoc(),source.replace('old','new words'));
  const marks=changed.facet(EditorView.decorations)[0];
  marks.between(0,changed.doc.length,(from,to)=>assert.equal(changed.sliceDoc(from,to),'new words'));
  const pasted=state.facet(EditorView.clipboardInputFilter).reduce((input,filter)=>filter(input,state),'new\nwords');
  const multiline=state.update({changes:{from:state.selection.main.head,to:state.selection.main.head+3,insert:pasted}}).state;
  assert.equal(multiline.doc.lines,state.doc.lines+1);
  assert.equal(multiline.sliceDoc(),source.replace('old',`new${newline}words`));
}
const mixed='First\r\nSecond\nThird\r\n';
assert.equal(createSourceState(mixed,[],0).sliceDoc(),mixed);
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)

    def test_failed_draft_blocks_leaving_even_after_choices_save_succeeds(self):
        script = r"""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync('manuscript_review/app.js','utf8');
const beginning=app.slice(0,app.indexOf('function setChoices')).replace(/^import .*;\n/gm,'');
const flush=app.slice(app.indexOf('window.flushReview='),app.indexOf("$('library').addEventListener"));
const requests=[],elements=new Map();let fail=true;
const context={window:{},document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{className:'',textContent:'',hidden:true});return elements.get(id);},body:{classList:{contains:()=>false}}},setTimeout,clearTimeout,
fetch:async(path,options)=>{requests.push([path,JSON.parse(options.body)]);if(path==='/draft'&&fail)return {ok:false,json:async()=>({error:'Transient disk error'})};return {ok:true,json:async()=>({revision:0})};}};
vm.createContext(context);vm.runInContext(beginning+'\n'+flush+`
data={token:'test',revision:0,scope:'round'};drafts={passage:{file:'passage',source:'a'.repeat(40),text:'Unsaved manuscript words'}};
draftChanges.set('passage',drafts.passage);`,context);
await assert.rejects(context.window.flushReview(),/could not be saved/);
assert.equal(vm.runInContext('draftChanges.size',context),1);
assert.equal(vm.runInContext('drafts.passage.text',context),'Unsaved manuscript words');
assert.deepEqual(requests.map(([path])=>path),['/draft','/save']);
fail=false;await context.window.flushReview();
assert.equal(vm.runInContext('draftChanges.size',context),0);
assert.equal(requests.at(-1)[0],'/ui');
assert.equal(requests.filter(([path])=>path==='/draft').at(-1)[1].draft.text,'Unsaved manuscript words');
"""
        subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[1], check=True)
