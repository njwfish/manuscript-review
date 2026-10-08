import copy
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
from test_review import ReviewFixture
from manuscript_review.comparison import build_snapshot, git
from manuscript_review.editing import selected_content
from manuscript_review.library import Library
from manuscript_review.repositories import find_repositories, inspect_repo, clone_repository, fetch_repository
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json, new_record, ReviewStore

spec = importlib.util.spec_from_file_location('upgrade_rounds', Path(__file__).parents[1] / 'migrations/upgrade_rounds.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class VersionTests(ReviewFixture):
    def test_repository_discovery_and_readable_branch_tag_commit_choices(self):
        git(self.repo, 'branch', 'revision-draft')
        git(self.repo, 'tag', '-a', 'submitted', '-m', 'Submitted manuscript', self.base)
        info = inspect_repo(self.repo)
        self.assertEqual(len(info['commits']), 2)
        self.assertTrue(all(len(c['revision']) == 40 and c['subject'] == 'version' for c in info['commits']))
        self.assertEqual(next(r['revision'] for r in info['references'] if r['name'] == 'submitted'), self.base)
        self.assertIn('revision-draft', info['refs'])
        self.assertEqual(find_repositories(self.root), [str(self.repo.resolve())])
        self.assertEqual(find_repositories(self.repo), [str(self.repo.resolve())])

    def test_clone_validates_url_destination_and_uses_existing_git_credentials(self):
        for url in ('https://example.com/owner/repo', 'https://github.com/../repo', 'file:///repo'):
            with self.assertRaises(ValueError):
                clone_repository(url, self.root)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            clone_repository('https://github.com/owner/repo', self.root)
        import subprocess
        original = subprocess.run
        def local_clone(arguments, **options):
            self.assertEqual(arguments[:4], ['git', 'clone', '--', 'https://github.com/owner/paper.git'])
            self.assertEqual(options['env']['GIT_TERMINAL_PROMPT'], '0')
            return original([*arguments[:3], str(self.repo), arguments[4]], **options)
        with patch('manuscript_review.repositories.subprocess.run', side_effect=local_clone):
            destination = clone_repository(' https://github.com/owner/paper.git ', self.root)
        self.assertEqual((Path(destination) / 'main.tex').read_text(), (self.repo / 'main.tex').read_text())
        original_head = git(destination, 'rev-parse', 'HEAD')
        original_index = git(destination, 'ls-files', '--stage')
        fetch_repository(destination)
        self.assertEqual(git(destination, 'rev-parse', 'HEAD'), original_head)
        self.assertEqual(git(destination, 'ls-files', '--stage'), original_index)

    def test_selected_checkpoint_is_stable_for_note_only_saves(self):
        edit = self.file()['edits'][0]['id']
        self.session.update('save', self.request(decisions={edit: 'reject'}))
        checkpoint = self.session.store.read()['result']
        self.session.update('save', self.request(comments={edit: 'A new comment'}))
        self.assertEqual(self.session.store.read()['result'], checkpoint)
        self.assertEqual(self.session.view('baseline')['proposed'], checkpoint)

    def test_v2_port_preserves_choices_sources_notes_replies_drafts_and_original_bytes(self):
        home = self.root / 'library'
        library = Library(home)
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working'}, 'first')
        identifier = library.jobs['first']['review']
        store = ReviewStore(library.directory(identifier))
        first = store.read()
        first['decisions'] = {g['id']: 'accept' for f in first['snapshot']['files'] for g in f['edits']}
        note_id = first['snapshot']['files'][0]['hunks'][0]['id']
        first['comments'] = {note_id: ' Exact earlier comment. \n'}
        first['ui'] = {'active': 0, 'passage': 0, 'edit': 0, 'view': 'diff', 'drafts': {note_id: 'A saved draft'}}
        first['schema'] = 2
        first.pop('baseline'); first.pop('result')
        atomic_json(store.path, first)
        source_bytes = store.path.read_bytes()
        original_proposal = first['snapshot']['proposed']
        file = self.repo / 'main.tex'
        file.write_text(file.read_text().replace('measured leaves', 'measured cells'))
        self.commit()
        proposal = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        snapshot = build_snapshot(self.repo, self.base, proposal)
        snapshot.update(source_head=proposal, entry='')
        child_id = 'f' * 24
        child = new_record(snapshot, {**first['metadata'], 'id': child_id, 'previous': identifier})
        child['schema'] = 2
        child.pop('baseline'); child.pop('result')
        child['decisions'] = {g['id']: 'accept' for f in snapshot['files'] for g in f['edits']}
        child['comments'] = {}
        child_dir = library.reviews / child_id
        atomic_json(child_dir / 'review.json', child)
        child_bytes = (child_dir / 'review.json').read_bytes()
        original_head, original_index = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage')
        migrated = upgrade.upgrade(home)
        self.assertIn('A saved draft', next(iter(ReviewStore(store.directory).read()['drafts'].values()))['text'])
        self.assertEqual((store.directory / 'migration-v2/review.json').read_bytes(), source_bytes)
        self.assertEqual((child_dir / 'migration-v2/review.json').read_bytes(), child_bytes)
        current = migrated[child_id]
        self.assertEqual(current['baseline'], self.base)
        self.assertEqual(current['snapshot']['base'], original_proposal)
        main = next(f for f in current['snapshot']['files'] if f['path'] == 'main.tex')
        self.assertEqual([(g['old'], g['new']) for g in main['edits']], [('leaves', 'cells')])
        self.assertEqual(current['decisions'], {main['edits'][0]['id']: 'accept'})
        for f in snapshot['files']:
            self.assertEqual(git(self.repo, 'show', current['result'] + ':' + f['path']).decode() if f['after'] is not None else None, selected_content(f, child['decisions']))
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), original_head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), original_index)
        before = {r['metadata']['id']: json.dumps(r, sort_keys=True) for r in migrated.values()}
        self.assertEqual({r['metadata']['id']: json.dumps(r, sort_keys=True) for r in upgrade.upgrade(home).values()}, before)

    def test_migration_does_not_discard_a_draft_that_cannot_be_reattached(self):
        record = self.session.store.read()
        record['schema'] = 2
        record.pop('baseline'); record.pop('result')
        record['ui'] = {'drafts': {'unlocatable': 'Unfinished words'}}
        before = copy.deepcopy(record)
        with self.assertRaisesRegex(ValueError, 'passage drafts'):
            upgrade.port_record(record, None, self.directory)
        self.assertEqual(record, before)

    def test_navigation_flush_does_not_advance_the_content_revision(self):
        r = self.session.store.read()
        before = self.session.store.path.read_bytes()
        result = self.session.update('save', {'revision': r['revision'], 'decisions': r['decisions'], 'comments': r['comments']})
        self.assertEqual(result['revision'], r['revision'])
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_round_and_cumulative_previews_use_both_endpoints_and_separate_assets(self):
        r = self.session.store.read()
        r['snapshot']['entry'] = 'main.tex'
        self.session.store.commit(r)
        calls = []
        def render(directory, data_override):
            calls.append((data_override['base'], data_override['proposed']))
            atomic_json(directory / 'renders/manifest.json', {})
        with patch('manuscript_review.render_latex.render', side_effect=render):
            self.session.previews.render('round')
            self.session.previews.render('baseline')
            self.session.previews.render('baseline')
            self.assertEqual(len(calls), 2)
            edit = self.file()['edits'][0]['id']
            self.session.update('save', self.request(decisions={edit: 'reject'}))
            self.session.previews.render('baseline')
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[-1], (self.base, self.session.store.read()['result']))
            round_manifest = json.loads((self.directory / 'renders/manifest.json').read_text())
            cumulative_manifest = json.loads((self.directory / 'baseline-renders/manifest.json').read_text())
            self.assertNotEqual(round_manifest['proposed'], cumulative_manifest['proposed'])
            self.assertEqual(self.session.view('baseline')['preview_status'], 'ready')

    def test_committed_matching_selection_can_be_marked_applied_without_writing_source(self):
        before = {f['path']: (self.repo / f['path']).read_bytes() if (self.repo / f['path']).exists() else None
                  for f in self.session.snapshot['files']}
        (self.repo / 'unrelated.txt').write_text('Unrelated new commit')
        self.commit()
        head = git(self.repo, 'rev-parse', 'HEAD')
        result = self.session.update('apply', self.request())
        self.assertTrue(result['applied'])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        for path, content in before.items():
            self.assertEqual((self.repo / path).read_bytes() if (self.repo / path).exists() else None, content)

    def test_a_manuscript_repository_does_not_hide_nested_manuscripts(self):
        nested = self.repo / 'nested'
        nested.mkdir()
        git(nested, 'init', '-q')
        git(nested, 'config', 'user.name', 'Test')
        git(nested, 'config', 'user.email', 'test@localhost')
        (nested / 'main.tex').write_text('Another manuscript')
        git(nested, 'add', 'main.tex')
        git(nested, 'commit', '-qm', 'Nested manuscript')
        self.assertCountEqual(find_repositories(self.repo), [str(self.repo.resolve()), str(nested.resolve())])
        self.assertEqual(find_repositories(nested), [str(nested.resolve())])

    def test_cumulative_comparisons_survive_restart_and_refresh_discussion_when_notes_change(self):
        library = Library(self.root / 'cache-library')
        library.prepare({'repo': str(self.repo), 'base': self.base, 'proposed': 'working'}, 'first')
        first = library.jobs['first']['review']
        path = self.repo / 'main.tex'
        path.write_text(path.read_text().replace('leaves', 'cells'))
        library.prepare({'repo': str(self.repo), 'previous': first, 'proposed': 'working'}, 'next')
        directory = library.directory(library.jobs['next']['review'])
        session = ReviewSession(directory)
        from manuscript_review.comparison import build_snapshot
        from manuscript_review.history import build_history
        with patch('manuscript_review.session.build_snapshot', wraps=build_snapshot) as build, patch('manuscript_review.session.build_history', wraps=build_history) as history:
            first_view = session.view('baseline')
            session.view('baseline')
            self.assertEqual(build.call_count, 1)
            self.assertEqual(history.call_count, 1)
            restarted = ReviewSession(directory).view('baseline')
            self.assertEqual(build.call_count, 1)
            self.assertEqual([(f['path'], f['before'], f['after']) for f in restarted['files']],
                             [(f['path'], f['before'], f['after']) for f in first_view['files']])
            r = session.store.read()
            edit = r['snapshot']['files'][0]['edits'][0]['id']
            session.update('save', {'revision': r['revision'], 'decisions': r['decisions'], 'comments': {edit: 'New discussion'}})
            updated = session.view('baseline')
            self.assertIn('New discussion', [entry['comment'] for entry in updated['history']])
