from test_review import ReviewFixture
from manuscript_review.comparison import build_snapshot, git
from manuscript_review.storage import new_record


def utf16_offset(text, point):
    return len(text[:point].encode('utf-16-le')) // 2


def marked_text(text, mark):
    return text.encode('utf-16-le')[mark['from'] * 2:mark['to'] * 2].decode('utf-16-le')


class ExternalEditorTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.before = 'Intro α😀.\n\nWe score all nodes.\n\nWe retain the explanation.\n\n\\[E=2\\]\n'
        self.after = self.before.replace('all nodes', 'measured leaves').replace('retain', 'expand').replace('E=2', 'E=1')
        (self.repo / 'main.tex').write_bytes(self.before.encode())
        (self.repo / 'context.tex').write_bytes('Context 🧬.\r\nSecond line.\r\n'.encode())
        self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / 'main.tex').write_bytes(self.after.encode())
        self.commit()
        snapshot = build_snapshot(self.repo, base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='')
        self.session.store.commit(new_record(snapshot, self.session.store.read()['metadata']))

    def preserved(self):
        return {
            'review': {path.relative_to(self.directory): path.read_bytes()
                       for path in self.directory.rglob('*') if path.is_file()},
            'repository': {path.relative_to(self.repo): path.read_bytes()
                           for path in self.repo.rglob('*') if path.is_file()},
            'record_stat': (self.session.store.path.stat().st_ino, self.session.store.path.stat().st_mtime_ns),
        }

    def note(self, text, quote):
        source = self.session.editor('main.tex')
        start = text.index(quote)
        return self.session.save_note({'revision': source['revision'], 'file': 'main.tex',
                                      'source': source['source'], 'text': text,
                                      'start': utf16_offset(text, start),
                                      'end': utf16_offset(text, start + len(quote)),
                                      'comment': 'Preserve this exact wording.'})['entry']

    def test_dirty_unicode_buffer_projects_edits_passages_notes_and_source_point_without_writes(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'}))
        selected = self.after.replace('expand', 'retain')
        captured = 'Earlier unsaved 😀 context.\n\n' + selected
        entry = self.note(captured, 'measured leaves')
        dirty = ('Current 🧬 context.\n\n' + captured.replace('Intro α😀.', 'Intro α😀🙂.')
                 .replace('measured leaves', 'selected 🧬 cells'))
        point = utf16_offset(selected, selected.index('retain') + 3)
        record = self.session.store.read()
        preserved = self.preserved()

        editor = self.session.editor('main.tex', dirty, point)

        self.assertEqual(editor['text'], dirty)
        self.assertEqual(editor['original'], selected)
        self.assertEqual(editor['revision'], record['revision'])
        self.assertEqual(editor['source'], record['result'])
        ranges = {mark['id']: mark for mark in editor['ranges']}
        for group, quote, rejected in [(first, 'selected 🧬 cells', False),
                                       (second, 'retain', True), (third, '1', False)]:
            self.assertEqual(marked_text(dirty, ranges[group['id']]), quote)
            self.assertEqual(ranges[group['id']]['rejected'], rejected)
        self.assertEqual([marked_text(dirty, mark) for mark in editor['passages']],
                         ['We score selected 🧬 cells.', 'We retain the explanation.', '\\[E=1\\]\n'])
        self.assertEqual(editor['notes'], [{'id': entry['id'], 'note': True,
                                           'from': utf16_offset(dirty, dirty.index('selected 🧬 cells')),
                                           'to': utf16_offset(dirty, dirty.index('selected 🧬 cells') + len('selected 🧬 cells'))}])
        self.assertEqual(editor['position'], utf16_offset(dirty, dirty.index('retain') + 3))
        self.assertEqual(self.preserved(), preserved)
        self.assertEqual(self.session.store.read()['history'][0]['anchor'], entry['anchor'])

    def test_external_buffer_overrides_retained_draft_without_replacing_or_discarding_it(self):
        original = self.session.editor('main.tex')
        draft = {'file': 'main.tex', 'source': original['source'],
                 'text': 'Standalone draft 😀.\n\n' + original['text']}
        self.session.save_draft({'revision': original['revision'], 'id': 'main.tex', 'draft': draft})
        preserved = self.preserved()
        dirty = 'VS Code buffer 🧬.\n\n' + original['text']

        projected = self.session.editor('main.tex', dirty)
        empty = self.session.editor('main.tex', '', 0)
        restored = self.session.editor('main.tex')

        self.assertEqual(projected['text'], dirty)
        self.assertEqual(projected['source'], draft['source'])
        self.assertIsNone(projected['position'])
        self.assertEqual(empty['text'], '')
        self.assertEqual(empty['position'], 0)
        self.assertTrue(all(mark['from'] == mark['to'] == 0 for mark in empty['ranges'] + empty['passages']))
        self.assertEqual(restored['text'], draft['text'])
        self.assertEqual(self.session.store.read()['drafts']['main.tex'], draft)
        self.assertEqual(self.preserved(), preserved)

    def test_unchanged_file_projects_external_unicode_buffer_and_preserves_crlf(self):
        original = 'Context 🧬.\r\nSecond line.\r\n'
        dirty = 'Unsaved 😀 prefix.\r\n' + original
        point = utf16_offset(original, original.index('Second'))
        preserved = self.preserved()

        editor = self.session.editor('context.tex', dirty, point)

        self.assertEqual(editor['text'], dirty)
        self.assertEqual(editor['original'], original)
        self.assertEqual(editor['ranges'], [])
        self.assertEqual(editor['passages'], [])
        self.assertEqual(editor['notes'], [])
        self.assertEqual(editor['position'], utf16_offset(dirty, dirty.index('Second')))
        self.assertEqual(self.preserved(), preserved)

    def test_invalid_buffers_and_points_do_not_change_any_saved_state(self):
        original = self.session.editor('main.tex')['text']
        split_emoji = utf16_offset(original, original.index('😀')) + 1
        preserved = self.preserved()
        for text in [False, 42, [], {}, b'source', 'x' * 1_000_001, '\ud800']:
            with self.subTest(text_type=type(text).__name__, length=len(text) if hasattr(text, '__len__') else None):
                with self.assertRaises(ValueError):
                    self.session.editor('main.tex', text)
        for point in [True, -1, 1.5, '1', utf16_offset(original, len(original)) + 1, split_emoji]:
            with self.subTest(point=point):
                with self.assertRaises(ValueError):
                    self.session.editor('main.tex', 'Dirty 🧬.\n\n' + original, point)
        self.assertEqual(self.preserved(), preserved)
