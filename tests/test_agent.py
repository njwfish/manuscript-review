import json
import subprocess
import sys
from pathlib import Path
from test_review import ReviewFixture
from manuscript_review.library import Library
from manuscript_review.storage import ReviewStore
from manuscript_review.session import ReviewSession
from manuscript_review.versions import selected_version
from manuscript_review.comparison import git


class AgentTests(ReviewFixture):
    def test_first_comparison_pins_the_input_and_preserves_head_and_index(self):
        head = git(self.repo, 'rev-parse', 'HEAD')
        index = git(self.repo, 'ls-files', '--stage')
        started = self.command('checkpoint', '--repo', str(self.repo))
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        self.assertEqual(git(self.repo, 'rev-parse', 'refs/manuscript-review/inputs/' + started['starting_version']).decode().strip(), started['starting_version'])
        file = self.repo / 'main.tex'
        file.write_text(file.read_text().replace('measured leaves', 'measured cells'))
        compared = self.command('compare', '--repo', str(self.repo), '--base', started['starting_version'])
        session = ReviewSession(Path(compared['path']).parent)
        record = session.store.read()
        self.assertEqual(record['baseline'], started['starting_version'])
        self.assertEqual(record['snapshot']['base'], started['starting_version'])
        edits = session.report()['edits']
        self.assertEqual([(edit['before'], edit['proposed']) for edit in edits], [('leaves', 'cells')])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)

    def setUp(self):
        super().setUp()
        self.home = self.root / 'agent-library'
        self.library = Library(self.home)
        self.library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working', 'entry': ''}, 'first')
        self.identifier = self.library.jobs['first']['review']
        self.store = ReviewStore(self.library.directory(self.identifier))
        record = self.store.read()
        self.main = next(f for f in record['snapshot']['files'] if f['path'] == 'main.tex')
        self.first, self.second = self.main['hunks'][:2]
        self.notes = {self.first['edits'][0]['id']: '  Use measured cells. \n', self.second['id']: 'Keep the explanation.'}
        record.update(comments=self.notes, decisions={self.second['edits'][0]['id']: 'reject'}, revision=9)
        record['result'] = selected_version(record)
        self.store.commit(record)

    def command(self, *arguments, check=True):
        result = subprocess.run([sys.executable, '-m', 'manuscript_review.agent', '--home', str(self.home), *arguments],
                                cwd=Path(__file__).parents[1], capture_output=True, text=True)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        return result

    def test_feedback_and_list_are_read_only_and_use_the_selected_repository(self):
        before = self.store.path.read_bytes()
        rows = self.command('list', '--repo', str(self.repo))
        self.assertEqual([r['id'] for r in rows], [self.identifier])
        self.assertEqual(self.command('list', '--repo', str(self.root)), [])
        feedback = self.command('feedback', '--review', self.identifier)
        self.assertEqual(feedback['revision'], 9)
        note = next(n for n in feedback['comments'] if n['id'] == self.first['edits'][0]['id'])
        self.assertEqual(note['comment'], self.notes[note['id']])
        self.assertTrue(note['discussion_id'].startswith('discussion-'))
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_reply_seals_only_its_current_note_and_preserves_every_other_choice(self):
        feedback = self.command('feedback', '--review', self.identifier)
        note = next(n for n in feedback['comments'] if n['id'] == self.first['edits'][0]['id'])
        replies = self.root / 'replies.json'
        replies.write_text(json.dumps([{'id': note['discussion_id'], 'text': 'Changed leaves to cells.'}]))
        before = self.store.read()
        result = self.command('respond', '--review', self.identifier, '--revision', '9', '--responses', str(replies))
        self.assertEqual(result['revision'], 10)
        self.assertEqual(result['history'][0]['id'], note['discussion_id'])
        self.assertEqual(result['history'][0]['comment'], note['comment'])
        self.assertEqual(result['history'][0]['replies'][0]['text'], 'Changed leaves to cells.')
        saved = self.store.read()
        self.assertEqual(saved['comments'], {self.second['id']: self.notes[self.second['id']]})
        self.assertEqual(saved['decisions'], before['decisions'])
        stale = self.command('respond', '--review', self.identifier, '--revision', '9', '--responses', str(replies), check=False)
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn('another window', stale.stderr)
        self.assertEqual(self.store.read(), saved)
        self.assertTrue(list((self.store.directory / 'conflicting-drafts').glob('*.json')))

    def test_explain_groups_a_passage_and_keeps_user_notes_and_choices(self):
        before = self.store.read()
        file_bytes = (self.repo / 'main.tex').read_bytes()
        feedback = self.command('feedback', '--review', self.identifier)
        first = next(edit for edit in feedback['edits'] if edit['id'] == self.first['edits'][0]['id'])
        self.assertEqual(first['passage_id'], self.first['id'])
        explanations = self.root / 'explanations.json'
        explanations.write_text(json.dumps([{'id': first['passage_id'], 'text': 'R1: Clarify which observations enter the loss.'}]))
        result = self.command('explain', '--review', self.identifier, '--revision', '9', '--explanations', str(explanations))
        entry = result['history'][0]
        self.assertEqual((entry['author'], entry['kind']), ('agent', 'passage'))
        self.assertEqual(entry['target'], {'kind': 'passage', 'id': self.first['id']})
        self.assertEqual(entry['context_before'], self.first['before'])
        saved = self.store.read()
        for key in ('decisions', 'comments', 'result', 'baseline', 'snapshot', 'applied', 'ui'):
            self.assertEqual(saved[key], before[key])
        self.assertEqual((self.repo / 'main.tex').read_bytes(), file_bytes)
        repeated = self.command('explain', '--review', self.identifier, '--revision', '10', '--explanations', str(explanations))
        self.assertEqual(repeated['revision'], result['revision'])
        self.assertEqual(self.store.read(), saved)
        stale = self.command('explain', '--review', self.identifier, '--revision', '9', '--explanations', str(explanations), check=False)
        self.assertIn('another window', stale.stderr)
        self.assertEqual(self.store.read(), saved)

    def test_agent_and_user_notes_with_identical_text_remain_distinct(self):
        feedback = self.command('feedback', '--review', self.identifier)
        note = next(n for n in feedback['comments'] if n['id'] == self.first['edits'][0]['id'])
        explanations = self.root / 'explanations.json'
        explanations.write_text(json.dumps([{'id': note['id'], 'text': note['comment']}]))
        explained = self.command('explain', '--review', self.identifier, '--revision', '9', '--explanations', str(explanations))
        self.assertNotEqual(explained['history'][0]['id'], note['discussion_id'])
        replies = self.root / 'replies.json'
        replies.write_text(json.dumps([{'id': note['discussion_id'], 'text': 'Changed the wording.'}]))
        responded = self.command('respond', '--review', self.identifier, '--revision', '10', '--responses', str(replies))
        self.assertEqual([entry['author'] for entry in responded['history']], ['agent', 'user'])
        self.assertEqual(responded['history'][0]['replies'], [])
        self.assertEqual(responded['history'][1]['replies'][0]['text'], 'Changed the wording.')

    def apply_and_begin(self, identifier=None):
        identifier = identifier or self.identifier
        session = ReviewSession(self.library.directory(identifier))
        r = session.store.read()
        session.update('apply', {'revision': r['revision'], 'decisions': r['decisions'], 'comments': r['comments']})
        return self.command('begin', '--review', identifier)

    def test_apply_uses_saved_choices_and_refuses_retained_drafts(self):
        before = self.store.read()
        applied = self.command('apply', '--review', self.identifier, '--revision', '9')
        record = self.store.read()
        self.assertEqual(record['decisions'], before['decisions'])
        self.assertEqual(record['comments'], before['comments'])
        self.assertIn('retain the explanation', (self.repo / 'main.tex').read_text())
        self.command('begin', '--review', self.identifier)
        session = ReviewSession(self.store.directory)
        session.save_draft({'revision': applied['revision'], 'passage_id': self.first['id'], 'text': 'Still editing.'})
        source = (self.repo / 'main.tex').read_bytes()
        refused = self.command('apply', '--review', self.identifier, '--revision', str(applied['revision'] + 1), check=False)
        self.assertIn('passage drafts', refused.stderr)
        self.assertEqual((self.repo / 'main.tex').read_bytes(), source)

    def finish(self, started, check=True):
        return self.command('finish', '--review', started['review'], '--revision', str(started['revision']),
                            '--from', started['starting_version'], check=check)

    def test_finish_preserves_the_previous_round_and_only_shows_this_pass(self):
        record = self.store.read()
        record['snapshot']['entry'] = record['metadata']['entry'] = 'main.tex'
        self.store.commit(record)
        started = self.apply_and_begin()
        before = self.store.path.read_bytes()
        file = self.repo / 'main.tex'
        file.write_text(file.read_text().replace('measured leaves', 'measured cells'))
        result = self.finish(started)
        current = ReviewStore(self.library.directory(result['review'])).read()
        self.assertEqual(current['metadata']['preview_status'], 'queued')
        self.assertFalse((self.library.directory(result['review']) / 'preview-cache').exists())
        self.assertEqual(current['snapshot']['base'], started['starting_version'])
        self.assertEqual(current['baseline'], self.base)
        self.assertEqual(current['decisions'], {})
        main = next(f for f in current['snapshot']['files'] if f['path'] == 'main.tex')
        self.assertEqual([(g['old'], g['new']) for g in main['edits']], [('leaves', 'cells')])
        self.assertCountEqual([e['comment'] for e in current['history']], self.notes.values())
        self.assertEqual(self.store.path.read_bytes(), before)
        # Rejecting this pass preserves the earlier accepted measured wording
        # and the earlier rejection of expand → retain.
        session = ReviewSession(self.library.directory(result['review']))
        session.update('save', {'revision': 0, 'decisions': {main['edits'][0]['id']: 'reject'}, 'comments': {}})
        cumulative = session.view('baseline')
        selected = git(self.repo, 'show', cumulative['proposed'] + ':main.tex').decode()
        self.assertIn('measured leaves', selected)
        self.assertIn('retain the explanation', selected)
        self.assertNotIn('cells', selected)

    def test_uncommented_reject_has_exact_source_context_in_feedback(self):
        record = self.store.read()
        record['comments'] = {}
        self.store.commit(record)
        result = self.command('feedback', '--review', self.identifier)
        row = next(edit for edit in result['edits'] if edit['decision'] == 'reject')
        self.assertEqual(row['file'], 'main.tex')
        self.assertEqual((row['before'], row['proposed']), ('retain', 'expand'))
        self.assertIn('explanation', row['context_before'])

    def test_commits_during_a_pass_do_not_move_its_start_or_baseline(self):
        started = self.apply_and_begin()
        file = self.repo / 'main.tex'
        file.write_text(file.read_text().replace('measured leaves', 'measured cells'))
        self.commit()
        result = self.finish(started)
        record = ReviewStore(self.library.directory(result['review'])).read()
        self.assertEqual(record['snapshot']['base'], started['starting_version'])
        self.assertEqual(record['baseline'], self.base)
        self.assertNotEqual(record['snapshot']['base'], record['snapshot']['proposed'])
        self.assertEqual(record['snapshot']['source_head'], git(self.repo, 'rev-parse', 'HEAD').decode().strip())

    def test_return_to_original_baseline_still_has_a_latest_round_diff(self):
        started = self.apply_and_begin()
        for file in self.store.read()['snapshot']['files']:
            path = self.repo / file['path']
            if file['before'] is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(file['before'])
        git(self.repo, 'add', '-A')
        result = self.finish(started)
        session = ReviewSession(self.library.directory(result['review']))
        self.assertTrue(session.view()['files'])
        self.assertEqual(session.view('baseline')['files'], [])
        self.assertCountEqual([e['comment'] for e in session.view()['history']], self.notes.values())

    def test_unchanged_pass_cannot_publish_an_empty_diff(self):
        started = self.apply_and_begin()
        result = self.finish(started, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No source changes', result.stderr)
        self.assertEqual(len(self.library.listing()), 1)

    def test_stale_parent_and_unsaved_passage_drafts_are_refused(self):
        started = self.apply_and_begin()
        session = ReviewSession(self.store.directory)
        r = self.store.read()
        session.update('save', {'revision': r['revision'], 'decisions': r['decisions'], 'comments': {**r['comments'], self.first['id']: 'New feedback'}})
        result = self.finish(started, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed during this pass', result.stderr)
        session.save_draft({'revision': session.store.read()['revision'], 'passage_id': self.first['id'], 'text': 'Unfinished source'})
        result = self.command('begin', '--review', self.identifier, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('passage drafts', result.stderr)

    def test_begin_captures_unrelated_upstream_changes_without_changing_git_index(self):
        self.apply_and_begin()
        (self.repo / 'other.txt').write_text('New upstream material')
        self.commit()
        head = git(self.repo, 'rev-parse', 'HEAD')
        index = git(self.repo, 'ls-files', '--stage')
        started = self.command('begin', '--review', self.identifier)
        self.assertEqual(git(self.repo, 'show', started['starting_version'] + ':other.txt'), b'New upstream material')
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
