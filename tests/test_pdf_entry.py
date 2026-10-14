import copy
from test_review import ReviewFixture
from manuscript_review.comparison import build_snapshot
from manuscript_review.storage import new_record, StaleReview


class PDFEntryTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        (self.repo / 'root.tex').write_text('\\documentclass{article}\n\\begin{document}Root.\\end{document}\n')
        self.commit()
        snapshot = build_snapshot(self.repo, self.base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='removed.tex')
        self.session.store.commit(new_record(snapshot, {'id': '0123456789abcdef01234567', 'entry': 'removed.tex'}))

    def test_unsupported_text_does_not_block_valid_roots(self):
        from manuscript_review.documents import latex_entries
        from manuscript_review.comparison import git
        (self.repo / 'unsupported.tex').write_bytes(b'\xff\xfe')
        self.commit()
        record = self.session.store.read()
        record['result'] = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        self.assertEqual(latex_entries(record), ['root.tex'])

    def test_pdf_root_uses_selected_version_even_when_working_root_is_deleted(self):
        (self.repo / 'root.tex').unlink()
        data = self.session.pdf_entries()
        self.assertEqual(data['entries'], ['root.tex'])
        self.assertEqual(data['entry'], 'removed.tex')
        before = self.session.store.path.read_bytes()
        self.session.pdf_entries()
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_root_change_preserves_source_versions_choices_comments_and_drafts(self):
        edit = self.file()['edits'][0]['id']
        self.session.update('save', self.request(decisions={edit: 'accept'}, comments={edit: 'Keep my voice.'}))
        before = self.session.store.read()
        self.session.set_pdf_entry({'revision': before['revision'], 'entry': 'root.tex'})
        after = self.session.store.read()
        self.assertEqual(after['revision'], before['revision'] + 1)
        expected = copy.deepcopy(before)
        expected['revision'] += 1
        expected['snapshot']['entry'] = expected['metadata']['entry'] = 'root.tex'
        for status in ('preview_status', 'baseline_preview_status', 'selected_preview_status'):
            expected['metadata'][status] = 'queued'
        self.assertEqual(after, expected)
        version = after['revision']
        self.session.set_pdf_entry({'revision': version, 'entry': 'root.tex'})
        self.assertEqual(self.session.store.read(), after)
        self.session.set_pdf_entry({'revision': version, 'entry': ''})
        self.assertEqual(self.session.store.read()['metadata']['selected_preview_status'], 'none')

    def test_stale_and_invalid_roots_do_not_change_the_record(self):
        before = self.session.store.path.read_bytes()
        for entry in ('../root.tex', '/root.tex', 'linked.tex', 'removed.tex', 'main.tex', None):
            with self.assertRaises(ValueError):
                self.session.set_pdf_entry({'revision': 0, 'entry': entry})
            self.assertEqual(self.session.store.path.read_bytes(), before)
        with self.assertRaises(StaleReview):
            self.session.set_pdf_entry({'revision': -1, 'entry': 'root.tex'})
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_rejected_new_root_is_not_offered(self):
        root = next(file for file in self.session.snapshot['files'] if file['path'] == 'root.tex')
        self.session.update('save', self.request(decisions={edit['id']: 'reject' for edit in root['edits']}))
        self.assertEqual(self.session.pdf_entries()['entries'], [])

    def test_root_change_invalidates_each_preview_scope(self):
        from manuscript_review.storage import atomic_json
        from manuscript_review.render_latex import RENDER_VERSION
        from manuscript_review.previews import PREVIEW_SCOPES, preview_versions
        record = self.session.store.read()
        state = {**record['snapshot'], 'baseline': record['baseline'], 'result': record['result']}
        for scope, (folder, _, _) in PREVIEW_SCOPES.items():
            atomic_json(self.directory / folder / 'manifest.json', {**preview_versions(state, scope),
                        'renderer': RENDER_VERSION, 'documents': {'after': {'pdf': 'old.pdf'}}})
            self.assertTrue(self.session.preview(scope)['documents'])
        self.session.set_pdf_entry({'revision': record['revision'], 'entry': 'root.tex'})
        for scope in PREVIEW_SCOPES:
            self.assertEqual(self.session.preview(scope)['documents'], {})
            self.assertEqual(self.session.preview(scope)['preview_status'], 'queued')

    def test_active_root_wins_over_a_valid_deprecated_root(self):
        from manuscript_review.comparison import git
        (self.repo / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}Current.\\end{document}\n')
        self.commit()
        record = self.session.store.read()
        record['result'] = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        record['snapshot']['entry'] = 'root.tex'
        self.session.store.commit(record)
        result = self.session.pdf_entries('main.tex')
        self.assertEqual(result['matching'], ['main.tex'])
        self.assertIn('root.tex', result['entries'])
        self.assertEqual(result['entry'], 'root.tex', 'discovery never mutates the chosen root')

    def test_nested_inputs_use_root_directory_and_ignore_commented_or_cyclic_inputs(self):
        from manuscript_review.comparison import git
        (self.repo / 'paper/sections').mkdir(parents=True)
        (self.repo / 'paper/main.tex').write_text('\\documentclass{article}\n\\input{sections/first}\n% \\input{unrelated}\n')
        (self.repo / 'paper/sections/first.tex').write_text('\\input{body}\n\\input{sections/first}\n')
        (self.repo / 'paper/body.tex').write_text('Body')
        (self.repo / 'body.tex').write_text('Unrelated top-level file')
        (self.repo / 'paper/unrelated.tex').write_text('Not actually included')
        self.commit()
        record = self.session.store.read()
        record['result'] = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        self.session.store.commit(record)
        self.assertEqual(self.session.pdf_entries('paper/body.tex')['matching'], ['paper/main.tex'])
        self.assertEqual(self.session.pdf_entries('body.tex')['matching'], [])
        self.assertEqual(self.session.pdf_entries('paper/unrelated.tex')['matching'], [])
        (self.repo / 'paper/main.tex').unlink()
        self.assertEqual(self.session.pdf_entries('paper/body.tex')['matching'], ['paper/main.tex'])

    def test_tex_root_hint_selects_the_author_declared_root(self):
        from manuscript_review.comparison import git
        (self.repo / 'body.tex').write_text('% !TEX root = root.tex\nBody')
        self.commit()
        record = self.session.store.read()
        record['result'] = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        self.session.store.commit(record)
        self.assertEqual(self.session.pdf_entries('body.tex')['matching'], ['root.tex'])
