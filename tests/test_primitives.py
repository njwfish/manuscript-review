import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from manuscript_review.anchors import SourceMap, SourceSpan
from manuscript_review.comparison import compare, enrich_snapshot
from manuscript_review.editing import project_source, projection_blocks, mapped_range
from manuscript_review.session import ReviewSession
from manuscript_review.storage import FileLock
from manuscript_review.history import add_responses


class PrimitiveTests(unittest.TestCase):
    def test_repeated_passages_map_to_their_own_working_source_after_partial_application(self):
        before = 'We score all nodes in the fitted model.'
        after = 'We score measured leaves in the fitted model.'
        proposal = '\n\n'.join([after] * 5)
        file = enrich_snapshot({'files': [compare('main.tex', '\n\n'.join([before] * 5), proposal)]})['files'][0]
        self.assertEqual(len(file['hunks']), 5)
        for choices in range(32):
            paragraphs = [before if choices & (1 << index) else after for index in range(5)]
            working = '\n\n'.join(paragraphs)
            for index, passage in enumerate(file['hunks']):
                start, end = mapped_range(projection_blocks(file, working), passage['proposal_span'], {g['id'] for g in passage['edits']})
                self.assertEqual(working[start:end], paragraphs[index])

    def test_distributed_changes_in_a_long_manuscript_remain_separate_words(self):
        source = ''.join(f'We count observation {i} and compare its measured lineage with the remaining cells.\n' for i in range(1000))
        proposed = source.replace('observation 0 ', 'patient 0 ').replace('observation 999 ', 'patient 999 ')
        file = enrich_snapshot({'files': [compare('long.tex', source, proposed)]})['files'][0]
        self.assertEqual([(g['old'], g['new']) for g in file['edits']], [('observation', 'patient')] * 2)
        self.assertEqual(project_source(file, {}).content, proposed)
        self.assertEqual(project_source(file, {g['id']: 'reject' for g in file['edits']}).content, source)

    def test_large_manuscript_change_keeps_exact_word_and_source_alignment(self):
        source = 'We compare measured cells with their relatives.\n' * 2000
        position = source.index('measured', len(source)//2)
        proposed = source[:position] + source[position:].replace('measured', 'observed', 1)
        file = enrich_snapshot({'files': [compare('large.tex', source, proposed)]})['files'][0]
        self.assertEqual([(g['old'], g['new']) for g in file['edits']], [('measured', 'observed')])
        self.assertEqual(project_source(file, {}).content, proposed)
        self.assertEqual(project_source(file, {file['edits'][0]['id']: 'reject'}).content, source)
        mapping = SourceMap(source, proposed)
        span = mapping.project(SourceSpan(position, position + len('measured')))
        self.assertEqual(proposed[span.start:span.end], 'observed')

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_feedback_source_selection_and_agent_handoff_match_review_state(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        file = enrich_snapshot({'files': [compare('main.tex', 'Old cells need a positive penalty.', 'Measured cells need a nonnegative penalty.')]})['files'][0]
        fixture = {'files': [file], 'base': 'a'*40, 'proposed': 'b'*40, 'id': 'review', 'repo': '/manuscript', 'feedback_path': '/library/reviews/review/review.json', 'baseline': 'a'*40}
        script = """import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const {currentFeedback,sourceRange,selectedSource,agentRequest}=await import(process.argv[1]);
const data=JSON.parse(readFileSync(0,'utf8')),file=data.files[0],passage=file.hunks[0],first=file.edits[0],second=file.edits[1];
const comments={[first.id]:'Which cells?',[passage.id]:'Explain the penalty.'};
const notes=currentFeedback(data,comments);
assert.equal(notes.length,2);assert.ok(notes.every(note=>note.current&&note.author==='user'));
assert.deepEqual(new Set(notes.map(note=>note.kind)),new Set(['edit','passage']));
for(const decisions of [{},{[first.id]:'reject'},{[first.id]:'reject',[second.id]:'reject'}]){
 const text=selectedSource(file,decisions),range=sourceRange(file,second,'selected',decisions);
 assert.equal(text.slice(...range),decisions[second.id]==='reject'?second.old:second.new);
}
assert.equal(file.before.slice(...sourceRange(file,second,'before',{})),second.old);
assert.equal(file.after.slice(...sourceRange(file,second,'after',{})),second.new);
assert.ok(agentRequest(data,true).includes(data.feedback_path));
assert.ok(agentRequest(data).includes('For replies only'));
assert.ok(agentRequest(data).includes('begin --parallel'));
assert.ok(agentRequest(data).includes('finish --workspace'));"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], input=json.dumps(fixture), text=True, check=True)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_discussion_follows_passage_selection_across_rounds(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        script = """import assert from 'node:assert/strict';
const {feedbackForPassage}=await import(process.argv[1]);
const hunk={id:'passage',edits:[{id:'first'},{id:'second'}]},history=[
 {id:'one',author:'agent',round_id:'current',target:{id:'passage'}},
 {id:'two',author:'agent',round_id:'current',target:{id:'first'}},
 {id:'three',author:'agent',round_id:'previous',target:{id:'passage'}},
 {id:'four',author:'user',round_id:'current',target:{id:'first'}},
 {id:'five',author:'agent',round_id:'current',target:null}];
assert.deepEqual(feedbackForPassage(history,hunk).map(e=>e.id),['one','two','three','four']);"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], check=True)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_comment_navigation_groups_followups_orders_files_and_keeps_answered_feedback(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        script = """import assert from 'node:assert/strict';
const {commentThreads,commentShortcut}=await import(process.argv[1]);
const data={files:[{path:'a.tex',hunks:[{id:'passage',line:10,before:'original',after:'proposed',edits:[]}]}],history:[
 {id:'first',origin_id:'first',file:'b.tex',line:3,comment:'Initial feedback',replies:[{text:'Response'}]},
 {id:'second',origin_id:'second',file:'a.tex',line:5,comment:'Another question',replies:[]},
 {id:'followup',origin_id:'first',file:'b.tex',line:20,comment:'Follow-up',replies:[]},
 {id:'blank',origin_id:'blank',file:'a.tex',line:1,comment:' ',replies:[]}]};
assert.deepEqual(commentThreads(data,{passage:'Current passage note'}).map(e=>[e.id,e.line]),[['second',5],['passage',10],['followup',3]]);
assert.equal(data.history[2].line,20);assert.equal(data.history[0].replies.length,1);
for(const code of ['BracketLeft','BracketRight']){
 const event={code,metaKey:true,ctrlKey:false,shiftKey:true,altKey:false,repeat:false};
 assert.equal(commentShortcut(event),code==='BracketLeft'?-1:1);
 assert.equal(commentShortcut({...event,metaKey:false,ctrlKey:true}),code==='BracketLeft'?-1:1);
 for(const changed of [{metaKey:false},{shiftKey:false},{altKey:true},{repeat:true}])assert.equal(commentShortcut({...event,...changed}),0);
}
assert.equal(commentShortcut({code:'KeyA',metaKey:true,shiftKey:true}),0);"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], check=True)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_library_groups_rounds_by_manuscript_and_completion_includes_supporting_files(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        script = """import assert from 'node:assert/strict';
const {manuscriptReviews,reviewProgress}=await import(process.argv[1]);
const reviews=[{id:'old',repo:'/one',created:'2026-01-01'},
 {id:'other',repo:'/two',created:'2026-02-01'},
 {id:'latest',repo:'/one',created:'2026-03-01'}];
assert.deepEqual(manuscriptReviews(reviews).map(rounds=>rounds.map(r=>r.id)),[['latest','old'],['other']]);
assert.equal(reviews[0].id,'old');
const files=[{edits:[{id:'a'}]},{supporting:true,edits:[{id:'b'}]}];
assert.deepEqual(reviewProgress(files,{a:'accept'}),{total:2,done:1,complete:false});
assert.deepEqual(reviewProgress(files,{a:'accept',b:'reject'}),{total:2,done:2,complete:true});
assert.deepEqual(reviewProgress([],{a:'accept'}),{total:0,done:0,complete:true});"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], check=True)

    def test_replies_cannot_silently_attach_to_a_different_round(self):
        entries = [{'id': 'message-1', 'origin_id': 'edit-1', 'round_id': 'round-1', 'comment': 'First request'},
                   {'id': 'message-2', 'origin_id': 'edit-1', 'round_id': 'round-2', 'comment': 'Second request'}]
        with self.assertRaises(ValueError):
            add_responses(entries, [{'id': 'edit-1', 'text': 'Ambiguous reply'}])
        self.assertNotIn('replies', entries[0])
        exact = add_responses(entries, [{'id': 'message-2', 'text': 'Second reply'}])
        self.assertEqual(exact[1]['replies'][-1]['text'], 'Second reply')

    def test_replies_append_without_overwriting_or_duplicate_imports(self):
        entries = [{'id': 'discussion-1', 'comment': 'Original request', 'replies': []}]
        first = {'id': 'discussion-1', 'text': 'First response'}
        second = {'id': 'discussion-1', 'text': 'Revised response'}
        entries = add_responses(entries, [first])
        entries = add_responses(entries, [second])
        repeated = add_responses(entries, [first])
        self.assertEqual(repeated, entries)
        self.assertEqual([r['text'] for r in entries[0]['replies']], ['First response', 'Revised response'])

    def test_source_anchor_boundaries_and_rewrites(self):
        mapping = SourceMap('a b', 'a NEW b')
        self.assertEqual(mapping.project(SourceSpan(0, 2)), SourceSpan(0, 2))
        self.assertEqual(mapping.project(SourceSpan(2, 2)), SourceSpan(2, 6))
        self.assertEqual(mapping.project(SourceSpan(2, 3)), SourceSpan(6, 7))
        mapping = SourceMap('A red phrase Z', 'A blue replacement Z')
        span = mapping.project(SourceSpan(3, 8))
        self.assertIn('blue', mapping.after[span.start:span.end])
        with self.assertRaises(ValueError):
            mapping.project(SourceSpan(0, 200))
        with self.assertRaises(ValueError):
            SourceSpan(-1, 0)

    def test_nested_lock_retains_process_lock_until_outer_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'lock'
            lock = FileLock(path)
            attempt = '''import fcntl,sys
with open(sys.argv[1],'a') as file:
 try: fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: sys.exit(3)
'''
            import sys
            with lock:
                with lock:
                    pass
                result = subprocess.run([sys.executable, '-c', attempt, str(path)])
                self.assertEqual(result.returncode, 3)
            result = subprocess.run([sys.executable, '-c', attempt, str(path)])
            self.assertEqual(result.returncode, 0)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_client_projection_matches_file_export(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        fixtures = []
        cases = [('The old words stay.\n', 'The revised phrase stays.\n'),
                 ('α — β.\n\n\\[x=1\\]', 'α—γ!\n\n\\[x=2\\]'),
                 (None, ''), ('Old file\n', None)]
        for before, after in cases:
            file = enrich_snapshot({'files': [compare('test.tex', before, after)]})['files'][0]
            members = [g['id'] for g in file['edits']]
            choices = [{}, {m: 'accept' for m in members}, {m: 'reject' for m in members},
                       {m: 'reject' for i, m in enumerate(members) if i % 2}]
            for decisions in choices:
                fixtures.append({'file': file, 'decisions': decisions,
                                 'expected': project_source(file, decisions).content})
        script = '''import {readFileSync} from 'node:fs';
const {selectedSource}=await import(process.argv[1]);
const cases=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(c=>selectedSource(c.file,c.decisions))));'''
        result = subprocess.run(['node', '--input-type=module', '-e', script, module],
                                input=json.dumps(fixtures), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), [c['expected'] for c in fixtures])

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_explicit_decision_modifiers_and_rapid_independent_presses(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        script = """import assert from 'node:assert/strict';
const {decisionShortcut}=await import(process.argv[1]);
for(const [key,value] of Object.entries({a:'accept',s:'reject',u:'pending'})){
 assert.deepEqual(decisionShortcut({key}),{value,scope:'edit'});
 assert.deepEqual(decisionShortcut({key:key.toUpperCase(),shiftKey:true}),{value,scope:'passage'});
 assert.deepEqual(decisionShortcut({key,ctrlKey:true}),{value,scope:'file'});
 assert.equal(decisionShortcut({key,metaKey:true}),null);
 assert.equal(decisionShortcut({key,altKey:true}),null);
 assert.equal(decisionShortcut({key,repeat:true}),null);
}
assert.equal(decisionShortcut({key:'f'}),null);
for(let press=0;press<5;press++)assert.equal(decisionShortcut({key:'a'}).scope,'edit');"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], check=True)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only for client-model tests.')
    def test_text_excerpt_keeps_the_selected_edit_visible_and_omits_unchanged_equations(self):
        module = (Path(__file__).parents[1] / 'manuscript_review/review_model.js').as_uri()
        script = """import assert from 'node:assert/strict';
const {editContext}=await import(process.argv[1]);
const passage={edits:[{id:'typo'},{id:'reference'}],grouped_segments:[
 {text:'An unchanged equation \\\\[x=1\\\\] '+ 'Earlier explanation. '.repeat(40)+'We include external '},
 {id:'typo',members:['a'],old:'atalses',new:'atlases'},{text:' as well'},
 {id:'reference',members:['b'],old:'',new:' (Section~ref)'},{text:'.'}]};
const first=editContext(passage,0);
assert.ok(first.before.endsWith('We include external '));
assert.ok(!first.before.includes('x=1'));
assert.equal(first.after,' as well');
assert.equal(first.trimmed,true);
const second=editContext(passage,1);
assert.equal(second.before,' as well');
assert.equal(second.after,'.');
assert.equal(second.leading,true);"""
        subprocess.run(['node', '--input-type=module', '-e', script, module], check=True)
