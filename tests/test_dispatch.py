import copy
import json
import shlex
import subprocess
import threading
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.dispatch import comment_task, dispatch_comment
from manuscript_review.server import create_server


class DispatchTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.identifier = self.file()['edits'][0]['id']
        self.session.update('save', self.request(comments={self.identifier: "Keep \\alpha and the author's exact words; $(false)."}))

    def test_one_saved_comment_and_existing_discussion_have_the_same_shared_task(self):
        before = self.session.store.path.read_bytes()
        task = self.session.agent_request(self.request(id=self.identifier))
        note = self.session.report()['comments'][0]
        self.assertEqual(task['discussion'], note['discussion_id'])
        self.assertTrue(task['prompt'].startswith('Address only discussion ' + note['discussion_id']))
        self.assertIn(note['comment'], task['prompt'])
        self.assertIn('begin --parallel', task['prompt'])
        self.assertIn('Append only your final, concise explanation', task['prompt'])
        self.assertIn('the author owns both', task['prompt'])
        self.assertEqual(self.session.store.path.read_bytes(), before)
        self.session.import_responses([{'id': note['discussion_id'], 'text': 'Previous response.'}], self.session.store.read()['revision'])
        task = self.session.agent_request(self.request(id=note['discussion_id']))
        self.assertEqual(task['discussion'], note['discussion_id'])
        self.assertIn('including its earlier replies', task['prompt'])

    def test_pending_decisions_and_drafts_allow_isolated_manuscript_changes(self):
        record = self.session.store.read()
        record['decisions'] = {edit['id']: 'accept' for file in record['snapshot']['files'] for edit in file['edits']}
        task = comment_task(record, self.directory, self.identifier)
        self.assertIn('surgical manuscript changes', task['prompt'])
        self.assertIn('Preserve thread resolution and review decisions', task['prompt'])
        self.assertIn('begin --review', task['prompt'])
        self.assertIn('finish --review', task['prompt'])
        for dirty in (True, False):
            draft_record = copy.deepcopy(record)
            if not dirty:
                draft_record['drafts']['main.tex'] = {'source': record['result'], 'file': 'main.tex', 'text': 'Unfinished'}
            task = comment_task(draft_record, self.directory, self.identifier)
            self.assertIn('Unsaved author text remains context', task['prompt'])
            self.assertIn('surgical manuscript changes', task['prompt'])

    def test_custom_skill_and_library_paths_are_shell_quoted_without_altering_text(self):
        directory = self.root / "author's library/reviews/id"
        launcher = self.root / "agent tools/review-agent"
        task = comment_task(self.session.store.read(), directory, self.identifier, launcher=launcher, skill=self.root / 'skills')
        self.assertIn(shlex.quote(str(launcher)) + ' --home ' + shlex.quote(str(directory.parent.parent)), task['prompt'])
        self.assertIn("$(false)", task['prompt'])

    def test_invalid_comments_and_stale_requests_do_not_launch(self):
        for identifier in ('missing', None, ''):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.session.agent_request(self.request(id=identifier))
        with self.assertRaises(ValueError):
            self.session.agent_request(self.request(id=self.identifier, revision=-1))
        with self.assertRaisesRegex(ValueError, 'Choose Codex'):
            dispatch_comment({}, 'invalid', self.root)
        with patch('manuscript_review.dispatch.shutil.which', return_value=None), self.assertRaisesRegex(ValueError, 'not installed'):
            dispatch_comment({}, 'codex', self.root)

    def test_codex_gets_exact_stdin_and_an_independent_process_group(self):
        task = self.session.agent_request(self.request(id=self.identifier))
        prompts = []
        def launch(command, **options):
            prompts.append(options['stdin'].read().decode())
            self.assertEqual(command, ['/codex', 'exec', '--sandbox', 'workspace-write', '--add-dir', str(self.root), '--add-dir', task['git_directory'], '-'])
            self.assertEqual(options['cwd'], str(self.repo.resolve()))
            self.assertTrue(options['start_new_session'])
            class Process:
                def wait(self): return 0
            return Process()
        with patch('manuscript_review.dispatch.shutil.which', return_value='/codex'), \
             patch('manuscript_review.dispatch.subprocess.run', return_value=subprocess.CompletedProcess([], 0)), \
             patch('manuscript_review.dispatch.subprocess.Popen', side_effect=launch):
            result = dispatch_comment(task, 'codex', self.root)
        self.assertEqual(prompts, [task['prompt']])
        self.assertEqual(result['revision'], task['revision'])
        self.assertIn('Codex', result['message'])

    def test_launch_errors_are_actionable_and_provider_logs_are_retained(self):
        task = self.session.agent_request(self.request(id=self.identifier))
        with patch('manuscript_review.dispatch.shutil.which', return_value='/codex'), \
             patch('manuscript_review.dispatch.subprocess.Popen', side_effect=OSError('Unavailable binary')), \
             self.assertRaisesRegex(ValueError, 'could not start.*Unavailable binary'):
            dispatch_comment(task, 'codex', self.root)

    def test_claude_background_handoff_preserves_defaults_and_the_complete_prompt(self):
        task = self.session.agent_request(self.request(id=self.identifier))
        class Process:
            def wait(self): return 0
        with patch('manuscript_review.dispatch.shutil.which', return_value='/claude'), \
             patch('manuscript_review.dispatch.subprocess.Popen', return_value=Process()) as launch:
            result = dispatch_comment(task, 'claude', self.root)
        self.assertEqual(launch.call_args.args[0], ['/claude', '--bg', '--add-dir', str(self.root), '--add-dir', task['git_directory'], '--', task['prompt']])
        self.assertEqual(launch.call_args.kwargs['cwd'], str(self.repo.resolve()))
        self.assertTrue(launch.call_args.kwargs['start_new_session'])
        self.assertTrue(Path(result['log']).is_file())

    def test_http_dispatch_checks_token_and_revision_before_handoff(self):
        server = create_server(self.directory)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        token = self.session.snapshot['token']
        url = f'http://127.0.0.1:{server.server_address[1]}/agent'
        def request(token, revision):
            return Request(url, json.dumps({'revision': revision, 'id': self.identifier, 'agent': 'claude'}).encode(),
                           headers={'Content-Type': 'application/json', 'X-Review-Token': token})
        before = self.session.store.path.read_bytes()
        try:
            with patch('manuscript_review.dispatch.dispatch_comment', return_value={'revision': 1, 'message': 'Sent'}) as launch:
                for wrong_token, revision in (('wrong', 1), (token, -1)):
                    with self.assertRaises(HTTPError):
                        urlopen(request(wrong_token, revision))
                launch.assert_not_called()
                result = json.load(urlopen(request(token, self.session.store.read()['revision'])))
                self.assertEqual(result['message'], 'Sent')
                self.assertEqual(launch.call_args.args[0]['discussion'], self.session.report()['comments'][0]['discussion_id'])
                self.assertEqual(launch.call_args.args[1], 'claude')
            self.assertEqual(self.session.store.path.read_bytes(), before)
        finally:
            server.shutdown();server.server_close()
