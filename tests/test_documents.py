import copy
from pathlib import Path
from test_review import ReviewFixture
from manuscript_review.comparison import git, read_blob
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession


class ManuscriptTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        (self.repo/'unicode.tex').write_bytes('Intro α😀.\r\n\r\nRepeated sentence.\r\n\r\nRepeated sentence.\r\n'.encode())
        self.commit()
        self.home = self.root / 'manuscript-library'
        self.library = Library(self.home)
        self.library.prepare(self.library.manuscript_request(self.repo), 'open')
        result = self.library.jobs['open']
        self.assertEqual(result['status'], 'ready', result)
        self.identifier = result['review']
        self.session = ReviewSession(self.library.directory(self.identifier))

    def source(self, path='main.tex'):
        return self.session.editor(path)

    def note(self, quote, comment, path='main.tex', occurrence=0, parent=None):
        source = self.source(path)
        start = source['text'].index(quote, occurrence)
        end = start + len(quote)
        offset = lambda point: len(source['text'][:point].encode('utf-16-le')) // 2
        return self.session.save_note({'revision': source['revision'], 'file': path,
                                      'source': source['source'], 'text': source['text'],
                                      'start': offset(start), 'end': offset(end),
                                      'comment': comment, 'parent': parent})['entry']

    def save_file(self, text, path='main.tex'):
        source = self.source(path)
        record = self.session.store.read()
        return self.session.update('file', {'revision': record['revision'], 'file': path,
                                           'source': source['source'], 'text': text,
                                           'decisions': record['decisions'], 'comments': record['comments']})

    def test_open_has_no_artificial_edits_and_resumes_saved_work(self):
        record = self.session.store.read()
        self.assertEqual(record['snapshot']['base'], record['result'])
        self.assertEqual(record['snapshot']['files'], [])
        self.assertEqual(record['ui']['scope'], 'manuscript')
        paths = [file['path'] for file in self.session.view('manuscript')['files']]
        self.assertIn('main.tex', paths)
        self.assertIn('empty.txt', paths)
        before = self.session.store.path.read_bytes()
        self.library.prepare(self.library.manuscript_request(self.repo), 'again')
        self.assertEqual(self.library.jobs['again']['review'], self.identifier)
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_comments_on_unchanged_text_do_not_write_the_manuscript(self):
        files = {str(path): path.read_bytes() for path in self.repo.glob('*.tex')}
        head, index = git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'ls-files', '--stage')
        source = self.source()
        entry = self.note('We score', 'Explain this without rewriting the surrounding prose.')
        self.assertEqual(entry['kind'], 'source')
        self.assertEqual(entry['before'], 'We score')
        self.assertEqual(self.source()['text'], source['text'])
        self.assertEqual(self.session.snapshot['files'], [])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'ls-files', '--stage'), index)
        self.assertEqual({path: Path(path).read_bytes() for path in files}, files)
        self.assertEqual(self.session.report()['history'][0]['id'], entry['id'])

    def test_open_subdirectory_resumes_authored_changes_and_comments(self):
        self.save_file(self.source()['text'].replace('We score', 'We carefully score', 1))
        self.note('We carefully score', 'Keep the author wording.')
        subdirectory = self.repo/'sections'
        subdirectory.mkdir()
        before = self.session.store.path.read_bytes()
        self.library.prepare(self.library.manuscript_request(subdirectory), 'subdirectory')
        self.assertEqual(self.library.jobs['subdirectory']['review'], self.identifier)
        self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_manuscript_uses_round_previews_and_exports_selected_patch(self):
        record = self.session.store.read()
        record['metadata']['preview_status'] = 'ready'
        self.session.store.commit(record)
        self.assertEqual(self.session.view('manuscript')['preview_status'], 'ready')
        self.save_file(self.source()['text'].replace('We score', 'We carefully score', 1))
        self.assertEqual(self.session.selected_patch('manuscript'), self.session.selected_patch())

    def test_manual_edit_creates_a_review_and_keeps_the_comment_anchor(self):
        entry = self.note('We score', 'Keep this phrasing.')
        original = self.source()['text']
        self.save_file(original.replace('We score', 'We carefully score', 1))
        record = self.session.store.read()
        self.assertEqual(record['history'][0]['anchor'], entry['anchor'])
        self.assertEqual(read_blob(self.repo, entry['anchor']['revision'], entry['file'])[entry['anchor']['start']:entry['anchor']['end']], 'We score')
        self.assertTrue(record['snapshot']['files'])
        self.assertTrue(all(value == 'accept' for value in record['decisions'].values()))
        self.assertEqual(self.source()['text'], original.replace('We score', 'We carefully score', 1))
        self.assertEqual(len(self.source()['notes']), 1)

    def test_draft_comments_pin_unsaved_text_without_writing_it(self):
        source = self.source()
        text = 'New author paragraph.\n\n' + source['text']
        self.session.save_draft({'revision': source['revision'], 'id': 'main.tex',
                                 'draft': {'file': 'main.tex', 'source': source['source'], 'text': text}})
        before = (self.repo/'main.tex').read_bytes()
        entry = self.note('New author paragraph.', 'Check this argument.')
        self.assertEqual((self.repo/'main.tex').read_bytes(), before)
        self.assertEqual(read_blob(self.repo, entry['anchor']['revision'], 'main.tex'), text)
        self.save_file(text)
        self.assertEqual(self.session.store.read()['history'][0]['anchor'], entry['anchor'])

    def test_reply_and_followup_preserve_the_original_comment(self):
        entry = self.note('We score', 'First question.')
        record = self.session.store.read()
        self.session.save_note({'revision': record['revision'], 'id': entry['id'], 'comment': 'Refined question.'})
        record = self.session.store.read()
        self.session.import_responses([{'id': entry['id'], 'text': 'Explanation.'}], record['revision'])
        record = self.session.store.read()
        with self.assertRaises(ValueError):
            self.session.save_note({'revision': record['revision'], 'id': entry['id'], 'comment': 'Overwrite the exchange.'})
        followup = self.note('We score', 'Follow-up question.', parent=entry['id'])
        history = self.session.report()['history']
        self.assertEqual(history[0]['comment'], 'Refined question.')
        self.assertEqual(history[0]['replies'][0]['text'], 'Explanation.')
        self.assertEqual(followup['origin_id'], entry['origin_id'])
        self.assertNotEqual(followup['id'], entry['id'])

    def test_stale_note_is_retained_and_cannot_overwrite_a_response(self):
        entry = self.note('We score', 'Original question.')
        before = self.session.store.read()
        self.session.import_responses([{'id': entry['id'], 'text': 'Response.'}], before['revision'])
        current = copy.deepcopy(self.session.store.read())
        with self.assertRaises(ValueError):
            self.session.save_note({'revision': before['revision'], 'id': entry['id'], 'comment': 'New local wording.'})
        self.assertEqual(self.session.store.read(), current)
        self.assertTrue(list((self.session.directory/'conflicting-drafts').glob('*.json')))

    def test_unicode_selection_and_repeated_text_keep_the_exact_location(self):
        source = self.source('unicode.tex')
        first = source['text'].index('Repeated sentence.')
        second = source['text'].index('Repeated sentence.', first+1)
        entry = self.note('Repeated sentence.', 'The second occurrence.', 'unicode.tex', second)
        self.assertEqual(entry['anchor']['start'], second)
        self.assertEqual(entry['context_before'], 'Repeated sentence.\r\n')
        self.assertEqual(self.source('unicode.tex')['notes'][0]['from'], len(source['text'][:second].encode('utf-16-le'))//2)
        prefix = 'Author introduction.\r\n\r\n'
        self.save_file(prefix+source['text'], 'unicode.tex')
        mark = self.source('unicode.tex')['notes'][0]
        expected = len((prefix+source['text'][:second]).encode('utf-16-le'))//2
        self.assertEqual(mark['from'], expected)
        self.assertEqual((self.repo/'unicode.tex').read_bytes(), (prefix+source['text']).encode())

    def test_agent_round_starts_from_author_edits_and_keeps_original_baseline(self):
        baseline = self.session.store.read()['baseline']
        self.save_file(self.source()['text'].replace('We score', 'We carefully score', 1))
        entry = self.note('We carefully score', 'Remove carefully, preserving the rest.')
        before = self.session.store.read()
        starting = self.library.begin(self.identifier)
        path = self.repo/'main.tex'
        path.write_bytes(path.read_bytes().replace(b'We carefully score', b'We deliberately score', 1))
        self.library.prepare({'repo': str(self.repo), 'previous': self.identifier, 'proposed': 'working',
                              'starting_version': starting['starting_version'],
                              'expected_revision': starting['revision'], 'require_changes': True}, 'finish')
        result = self.library.jobs['finish']
        self.assertEqual(result['status'], 'ready', result)
        next_round = ReviewSession(self.library.directory(result['review']))
        record = next_round.store.read()
        self.assertEqual(record['baseline'], baseline)
        self.assertEqual(record['snapshot']['base'], before['result'])
        self.assertEqual(record['decisions'], {})
        self.assertEqual(record['history'][0]['id'], entry['id'])
        self.assertEqual(record['history'][0]['anchor'], entry['anchor'])
        next_round.import_responses([{'id':entry['id'],'text':'Proposed a smaller wording change.'}],record['revision'])
        self.assertEqual(self.session.store.read(), before)
        self.assertTrue(next_round.report()['history'][0]['replies'])
