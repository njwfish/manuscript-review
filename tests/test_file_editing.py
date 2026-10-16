from test_review import ReviewFixture
from manuscript_review.editing import selected_content
from manuscript_review.comparison import build_snapshot, git
from manuscript_review.storage import new_record


class FileEditingTests(ReviewFixture):
    def versions(self, before, after):
        (self.repo / 'main.tex').write_text(before)
        self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / 'main.tex').write_text(after)
        self.commit()
        snapshot = build_snapshot(self.repo, base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='')
        self.session.store.commit(new_record(snapshot, self.session.store.read()['metadata']))

    def revise(self, text):
        return self.session.update('file', self.request(file='main.tex', source=self.session.store.read()['result'], text=text))

    def test_manual_save_preserves_unrelated_rejections_pending_source_and_comments(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'},
                                                comments={first['id']: 'Use chosen cells.', second['id']: 'Keep this comment.'}))
        record = self.session.store.read()
        before = (self.repo / 'main.tex').read_text()
        text = selected_content(self.file(), record['decisions']).replace('measured leaves', 'chosen cells')
        result = self.revise(text)
        current = self.file()
        self.assertEqual(result['data']['base'], record['snapshot']['base'])
        self.assertEqual(self.session.store.read()['baseline'], record['baseline'])
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')
        self.assertNotIn(third['id'], self.session.store.read()['decisions'])
        self.assertEqual(self.session.store.read()['comments'], {second['id']: 'Keep this comment.'})
        self.assertEqual((self.repo / 'main.tex').read_text(), before.replace('measured leaves', 'chosen cells'))
        self.assertIn('expand the explanation', current['after'])
        self.assertIn('retain the explanation', selected_content(current, self.session.store.read()['decisions']))
        self.assertEqual(self.session.store.read()['history'][0]['comment'], 'Use chosen cells.')
        self.assertNotEqual(self.session.store.read()['result'], record['result'])

    def test_changes_in_multiple_passages_and_outside_the_diff_accumulate(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={second['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions'])
        text = 'Context before the manuscript.\n\n' + text.replace('measured leaves', 'chosen cells').replace('E=1', 'E=3') + '\nA final explanation.\n'
        self.revise(text)
        working = (self.repo / 'main.tex').read_text()
        self.assertTrue(working.startswith('Context before the manuscript.'))
        self.assertIn('chosen cells', working)
        self.assertIn('E=3', working)
        self.assertTrue(working.endswith('A final explanation.\n'))
        self.assertIn('expand the explanation', working)
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')

    def test_manual_save_after_applying_choices_keeps_the_working_projection(self):
        first, second, third = self.file()['edits']
        self.session.update('apply', self.request(decisions={first['id']: 'reject', third['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions']).replace('explanation', 'short explanation')
        self.revise(text)
        self.assertEqual((self.repo / 'main.tex').read_text(), text)
        self.assertEqual(self.session.store.read()['decisions'][first['id']], 'reject')
        self.assertEqual(self.session.store.read()['decisions'][third['id']], 'reject')

    def test_editing_rejected_wording_revises_only_that_replacement(self):
        first, second, third = self.file()['edits']
        self.session.update('save', self.request(decisions={first['id']: 'reject', second['id']: 'reject'}))
        text = selected_content(self.file(), self.session.store.read()['decisions']).replace('all nodes', 'chosen nodes')
        self.revise(text)
        self.assertIn('chosen nodes', self.file()['after'])
        self.assertIn('expand the explanation', self.file()['after'])
        self.assertIn('retain the explanation', selected_content(self.file(), self.session.store.read()['decisions']))
        self.assertEqual(self.session.store.read()['decisions'][second['id']], 'reject')

    def test_outside_edits_are_refused_and_the_source_draft_is_retained(self):
        editor = self.session.editor('main.tex')
        text = editor['text'].replace('measured leaves', 'chosen cells')
        self.session.save_draft({'revision': editor['revision'], 'id': 'main.tex', 'draft': {'file': 'main.tex', 'source': editor['source'], 'text': text}})
        (self.repo / 'main.tex').write_text('Outside edit.\n')
        record = self.session.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'edited outside'):
            self.revise(text)
        self.assertEqual(self.session.store.path.read_bytes(), record)
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Outside edit.\n')
        self.assertEqual(self.session.store.read()['drafts']['main.tex']['text'], text)

    def test_rejected_deletion_at_a_manual_interval_end_is_not_duplicated(self):
        self.versions('Start old middle removed end.\n', 'Start new middle end.\n')
        removed = next(g for g in self.file()['edits'] if g['old'] == ' removed')
        self.session.update('apply', self.request(decisions={removed['id']: 'reject'}))
        self.revise('Start replacement end.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Start replacement end.\n')
        self.assertEqual(selected_content(self.file(), self.session.store.read()['decisions']), 'Start replacement end.\n')

    def test_an_untouched_rejected_deletion_at_the_boundary_remains(self):
        self.versions('Start old middle removed end.\n', 'Start new middle end.\n')
        removed = next(g for g in self.file()['edits'] if g['old'] == ' removed')
        self.session.update('apply', self.request(decisions={removed['id']: 'reject'}))
        self.revise('Start replacement removed end.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'Start replacement removed end.\n')

    def test_repeated_source_and_unicode_keep_their_locations(self):
        self.versions('α😀\n\nOne cell.\n\nRepeated description.\n\nOne cell.\n',
                      'α😀\n\nTwo cells.\n\nRepeated description.\n\nTwo cells.\n')
        first, second = self.file()['edits']
        self.session.update('apply', self.request(decisions={first['id']: 'reject', second['id']: 'accept'}))
        self.session.update('save', self.request(decisions={first['id']: 'accept', second['id']: 'reject'}))
        editor = self.session.editor('main.tex')
        mark = next(r for r in editor['ranges'] if r['id'] == first['id'])
        utf16 = editor['text'].encode('utf-16-le')
        self.assertEqual(utf16[mark['from'] * 2:mark['to'] * 2].decode('utf-16-le'), first['new'])
        self.revise('α😀\n\nTwo cells.\n\nRepeated description.\n\nChosen cells.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), 'α😀\n\nOne cell.\n\nRepeated description.\n\nChosen cells.\n')
        self.assertEqual(self.session.store.read()['decisions'][first['id']], 'accept')

    def test_new_and_previously_deleted_files_can_be_edited(self):
        for path, text in [('empty.txt', 'New text.\n'), ('deleted.txt', 'Restored text.\n')]:
            self.session.update('file', self.request(file=path, source=self.session.store.read()['result'], text=text))
            self.assertEqual((self.repo / path).read_text(), text)

    def test_equivalent_realigned_changes_keep_accept_reject_and_pending_choices(self):
        base = 'value value value leaf root node graph node value state value value graph root state leaf edge cell leaf leaf value graph graph cell.\n'
        proposed = 'value value value leaf root node graph value state value value graph root first leaf edge cell leaf leaf value graph graph\n'
        for choice in ('accept', 'reject', None):
            with self.subTest(choice=choice):
                self.versions(base, proposed)
                deletion = next(edit for edit in self.file()['edits'] if edit['old'] == 'node ')
                decisions = {deletion['id']: choice} if choice else {}
                self.session.update('apply', self.request(decisions=decisions, comments={deletion['id']: 'Keep this decision and its discussion.'}))
                text = selected_content(self.file(), decisions).replace('root node', 'root chosen', 1)
                baseline = self.session.store.read()['baseline']
                self.revise(text)
                record = self.session.store.read()
                realigned = next(edit for edit in self.file()['edits'] if edit['old'] == ' node')
                self.assertNotEqual(realigned['id'], deletion['id'])
                self.assertEqual(record['decisions'].get(realigned['id']), choice)
                self.assertEqual(selected_content(self.file(), record['decisions']), text)
                self.assertEqual((self.repo / 'main.tex').read_text(), text)
                self.assertEqual(record['baseline'], baseline)
                self.assertTrue(any(note['comment'] == 'Keep this decision and its discussion.' for note in record['history']))

    def test_ordered_native_saves_preserve_a_realigned_rejection_and_discussion(self):
        import secrets
        self.versions(
            'value value value leaf root node graph node value state value value graph root state leaf edge cell leaf leaf value graph graph cell.\n',
            'value value value leaf root node graph value state value value graph root first leaf edge cell leaf leaf value graph graph\n')
        deletion = next(edit for edit in self.file()['edits'] if edit['old'] == 'node ')
        self.session.update('apply', self.request(decisions={deletion['id']: 'reject'}, comments={deletion['id']: 'Retain this node.'}))
        self.session.edit_workspace(self.request())
        previous = self.session.store.read()
        edited = selected_content(self.file(), previous['decisions']).replace('root node', 'root chosen', 1)
        latest = edited + '\nAdditional author context.\n'
        saves = [{'id': secrets.token_hex(16), 'intent': 'proposal', 'text': text} for text in (edited, latest)]
        destination = self.repo / 'main.tex'
        destination.write_text(latest)
        timestamp = destination.stat().st_mtime_ns
        result = self.session.capture_file(self.request(file='main.tex', text=latest,
            source=previous['metadata']['workspace_version'], saves=saves, cursor=None))
        record = self.session.store.read()
        realigned = next(edit for edit in self.file()['edits'] if edit['old'] == ' node')
        self.assertEqual(record['decisions'][realigned['id']], 'reject')
        self.assertEqual(selected_content(self.file(), record['decisions']), latest)
        self.assertEqual(destination.read_text(), latest)
        self.assertEqual(destination.stat().st_mtime_ns, timestamp)
        self.assertEqual(result['cursor'], saves[-1]['id'])
        self.assertEqual(record['revision'], previous['revision'] + 1)
        self.assertEqual(record['baseline'], previous['baseline'])
        self.assertTrue(any(note['comment'] == 'Retain this node.' for note in record['history']))

    def test_different_wording_and_distinct_occurrences_do_not_inherit_decisions(self):
        from manuscript_review.comparison import compare, enrich_snapshot
        from manuscript_review.file_editing import equivalent_edits
        baseline = 'First old. Second old.\n'
        file = enrich_snapshot({'files': [compare('main.tex', baseline, 'First new. Second old.\n')]})['files'][0]
        for text in ('First changed. Second old.\n', 'First old. Second new.\n'):
            revised = enrich_snapshot({'files': [compare('main.tex', baseline, text)]})['files'][0]
            self.assertEqual(equivalent_edits(file, revised), {})

    def test_manual_context_can_expand_an_accepted_replacement(self):
        self.versions(
            'graph cell node root value edge root leaf value graph root value value state edge root root value.\n',
            'graph cell node root value edge leaf value root second value third edge root root value.\n')
        edit = next(group for group in self.file()['edits'] if group['new'] == 'root second')
        self.session.update('apply', self.request(decisions={edit['id']: 'accept'}))
        text = self.file()['after'].replace('root second value', 'root second extra context value')
        self.revise(text)
        record = self.session.store.read()
        self.assertEqual(selected_content(self.file(), record['decisions']), text)
        self.assertEqual((self.repo / 'main.tex').read_text(), text)
        expanded = next(group for group in self.file()['edits'] if 'extra context' in group['new'])
        self.assertEqual(record['decisions'][expanded['id']], 'accept')

    def test_repeated_words_can_move_a_rejected_deletion_into_the_manual_edit(self):
        self.versions('One leaf graph graph graph end.\n', 'One leaf graph graph end.\n')
        deletion = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={deletion['id']: 'reject'},
                                                comments={deletion['id']: 'Keep all three graphs.'}))
        text = 'One manual graph graph graph end.\n'
        self.revise(text)
        record = self.session.store.read()
        self.assertEqual(selected_content(self.file(), record['decisions']), text)
        self.assertEqual((self.repo / 'main.tex').read_text(), text)
        self.assertTrue(any(note['comment'] == 'Keep all three graphs.' for note in record['history']))

    def test_native_refinement_preserves_a_newer_adjacent_choice(self):
        self.versions('One old.\n', 'New One old.\n')
        insertion = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={insertion['id']: 'reject'}))
        self.session.edit_workspace(self.request())
        self.session.update('save', self.request(decisions={insertion['id']: 'accept'}))
        record = self.session.store.read()
        saved = 'Chosen old.\n'
        (self.repo / 'main.tex').write_text(saved)
        self.session.capture_file(self.capture_request(file='main.tex', text=saved,
            source=record['metadata']['workspace_version']))
        current = self.session.store.read()
        self.assertEqual(selected_content(self.file(), current['decisions']), 'New Chosen old.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), saved)

    def test_native_refinement_can_edit_a_previously_rejected_projection(self):
        self.versions('One old.\n', 'One new.\n')
        edit = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={edit['id']: 'reject'}))
        self.session.edit_workspace(self.request())
        self.session.update('save', self.request(decisions={}))
        record = self.session.store.read()
        saved = 'One chosen.\n'
        (self.repo / 'main.tex').write_text(saved)
        self.session.capture_file(self.capture_request(file='main.tex', text=saved,
            source=record['metadata']['workspace_version']))
        current = self.session.store.read()
        self.assertEqual(selected_content(self.file(), current['decisions']), saved)
        self.assertEqual((self.repo / 'main.tex').read_text(), saved)

    def test_native_boundary_insertion_preserves_a_newer_rejection(self):
        self.versions('One old.\n', 'One new.\n')
        self.session.edit_workspace(self.request())
        edit = self.file()['edits'][0]
        self.session.update('save', self.request(decisions={edit['id']: 'reject'}))
        record = self.session.store.read()
        saved = 'One new extra.\n'
        (self.repo / 'main.tex').write_text(saved)
        self.session.capture_file(self.capture_request(file='main.tex', text=saved,
            source=record['metadata']['workspace_version']))
        current = self.session.store.read()
        self.assertEqual(selected_content(self.file(), current['decisions']), 'One old extra.\n')
        self.assertEqual((self.repo / 'main.tex').read_text(), saved)

    def test_regrouping_preserves_unchanged_choices_inside_the_transport_interval(self):
        for choice in (None, 'accept', 'reject'):
            with self.subTest(choice=choice):
                self.versions('node node state cell state.\n', 'node second cell node leaf cell state.\n')
                insertion, replacement = self.file()['edits']
                decisions = {insertion['id']: 'reject'}
                if choice:
                    decisions[replacement['id']] = choice
                self.session.update('apply', self.request(decisions=decisions,
                    comments={replacement['id']: 'Keep this separate decision.'}))
                text = selected_content(self.file(), decisions).rsplit('state', 1)
                saved = 'manual'.join(text)
                self.revise(saved)
                record = self.session.store.read()
                self.assertEqual(record['decisions'].get(replacement['id']), choice)
                self.assertEqual(record['comments'][replacement['id']], 'Keep this separate decision.')
                self.assertEqual(selected_content(self.file(), record['decisions']), saved)
