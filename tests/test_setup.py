import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from manuscript_review.setup import install_skill, setup_status, git_available
from manuscript_review.repositories import inspect_repo
from manuscript_review.comparison import git


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.skill = self.root / 'App resources/skills/manuscript-review'
        self.skill.mkdir(parents=True)
        (self.skill / 'SKILL.md').write_text('Bundled skill')
        self.source = patch('manuscript_review.setup.skill_directory', return_value=self.skill)
        self.source.start()

    def tearDown(self):
        self.source.stop()
        self.temp.cleanup()

    def test_install_is_portable_idempotent_and_reports_the_link(self):
        for agent, folder in [('codex', '.agents'), ('claude', '.claude')]:
            self.assertIn('installed', install_skill(agent, self.home)['message'])
            target = self.home / folder / 'skills/manuscript-review'
            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), self.skill.resolve())
            self.assertIn('already', install_skill(agent, self.home)['message'])
        agents = setup_status(self.home)['agents']
        self.assertTrue(all(agent['installed'] and agent['linked'] for agent in agents))

    def test_existing_files_directories_and_broken_links_are_never_replaced(self):
        target = self.home / '.agents/skills/manuscript-review'
        target.parent.mkdir(parents=True)
        for kind in ('file', 'directory', 'broken-link'):
            if kind == 'file':
                target.write_text('Existing author file')
            elif kind == 'directory':
                target.mkdir()
                (target / 'SKILL.md').write_text('Existing author skill')
            else:
                target.symlink_to(self.root / 'missing')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                install_skill('codex', self.home)
            self.assertTrue(target.exists() or target.is_symlink())
            if kind == 'directory':
                self.assertEqual((target / 'SKILL.md').read_text(), 'Existing author skill')
                (target / 'SKILL.md').unlink()
                target.rmdir()
            else:
                if kind == 'file':
                    self.assertEqual(target.read_text(), 'Existing author file')
                target.unlink()

    def test_existing_codex_skill_is_recognized_without_creating_a_duplicate(self):
        target = self.home / '.codex/skills/manuscript-review'
        target.parent.mkdir(parents=True)
        target.symlink_to(self.skill, target_is_directory=True)
        status = setup_status(self.home)['agents'][0]
        self.assertTrue(status['installed'])
        self.assertEqual(status['path'], str(target))
        self.assertIn('already', install_skill('codex', self.home)['message'])
        self.assertFalse((self.home / '.agents').exists())

    def test_unknown_agent_or_missing_bundle_cannot_create_a_link(self):
        with self.assertRaisesRegex(ValueError, 'Choose Codex'):
            install_skill('../../elsewhere', self.home)
        (self.skill / 'SKILL.md').unlink()
        with self.assertRaisesRegex(ValueError, 'missing'):
            install_skill('claude', self.home)
        self.assertFalse(self.home.exists())
        self.assertFalse(setup_status(self.home)['skill_available'])

    def test_apple_git_stub_is_checked_without_triggering_the_installer(self):
        with patch('manuscript_review.setup.sys.platform', 'darwin'), patch('manuscript_review.setup.shutil.which', return_value='/usr/bin/git'), patch('manuscript_review.setup.subprocess.run') as run:
            run.return_value.returncode = 1
            self.assertFalse(git_available())
            run.assert_called_once_with(['xcode-select', '-p'], capture_output=True)

    def test_missing_git_and_initial_commit_have_actionable_errors(self):
        with patch('manuscript_review.repositories.git_available', return_value=False):
            with self.assertRaisesRegex(ValueError, 'Open Setup'):
                inspect_repo(self.root)
        git(self.root, 'init', '-q')
        with self.assertRaisesRegex(ValueError, 'initial commit'):
            inspect_repo(self.root)
