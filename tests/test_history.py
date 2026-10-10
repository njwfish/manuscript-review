from test_review import ReviewFixture
from manuscript_review.feedback import feedback_report
from manuscript_review.history import add_responses, build_history
from manuscript_review.comparison import build_snapshot


class DiscussionTests(ReviewFixture):
    def test_reimport_keeps_a_saved_explanation_identity_without_duplicating_it(self):
        from manuscript_review.comparison import stable_id
        target = self.file()['hunks'][0]['id']
        row = {'id':target,'text':'Reviewer 1 asked which observations enter the loss.'}
        self.session.import_explanations([row], 0)
        record = self.session.store.read()
        snapshot = record['snapshot']
        original_round = stable_id('round',[snapshot['repo'],snapshot['base'],snapshot['proposed'],snapshot['created']])
        original_id = stable_id('agent-discussion',[original_round,target,row['text']])
        record['history'][0].update(id=original_id,round_id=original_round)
        self.session.store.commit(record)
        repeated = self.session.import_explanations([row],record['revision'])
        self.assertEqual(repeated['revision'],record['revision'])
        self.assertEqual(len(repeated['history']),1)
        self.assertEqual(repeated['history'][0]['id'],original_id)

    def test_explanations_validate_the_whole_import_before_saving(self):
        target = self.file()['hunks'][0]['id']
        before = self.session.store.path.read_bytes()
        valid = {'id': target, 'text': 'Reviewer 1 asked which observations enter the loss.'}
        for records in ([valid, {'id': 'unknown', 'text': 'Cannot attach'}], [valid, valid],
                        [{'id': target, 'text': ' '}], [{'id': target, 'text': 'a' * 20001}],
                        [{'id': target, 'text': 'Reason', 'title': 1}], {'id': target, 'text': 'Reason'}):
            with self.assertRaises(ValueError):
                self.session.import_explanations(records, 0)
            self.assertEqual(self.session.store.path.read_bytes(), before)

    def test_explanation_context_and_replies_survive_manual_revision_and_new_round(self):
        h = self.file()['hunks'][0]
        row = {'id': h['id'], 'text': 'R1: State which observations enter the loss.'}
        explained = self.session.import_explanations([row], 0)
        entry = explained['history'][0]
        identifier, original = entry['id'], entry['context_before']
        self.session.import_responses([{'id': identifier, 'text': 'The author refined this wording.'}], explained['revision'])
        self.session.update('file', self.file_request(passage_id=h['id'], text='We score chosen cells.'))
        record = self.session.store.read()
        self.assertEqual(record['history'][0]['id'], identifier)
        self.assertEqual(record['history'][0]['context_before'], original)
        self.assertEqual(record['history'][0]['author'], 'agent')
        self.assertEqual(record['history'][0]['target']['kind'], 'passage')
        path = self.repo / 'main.tex'
        path.write_text(path.read_text().replace('chosen cells', 'chosen measured cells'))
        self.commit()
        next_snapshot = build_snapshot(self.repo, record['result'], 'HEAD')
        report = feedback_report(self.session.snapshot, record['decisions'], record['comments'], record['history'], record['metadata']['id'])
        history = build_history(self.session.snapshot, next_snapshot, record, report, record['history'], self.directory)
        self.assertEqual(history[0]['id'], identifier)
        self.assertEqual(history[0]['context_before'], original)
        self.assertEqual(history[0]['anchor'], record['history'][0]['anchor'])
        self.assertIsNotNone(history[0]['target'])
        self.assertEqual(history[0]['replies'][-1]['text'], 'The author refined this wording.')

    def test_response_import_is_atomic_and_keeps_current_notes(self):
        h = self.file()['hunks'][0]
        self.session.update('save', self.request(comments={h['id']: 'Exact note. \n'}))
        self.session.update('file', self.file_request(passage_id=h['id'], text='We score chosen cells.'))
        before = self.session.store.read()
        row = {'id': before['history'][0]['id'], 'text': 'Corrected the scoring.'}
        with self.assertRaises(ValueError):
            self.session.import_responses([row, {'id':'unknown','text':'Wrong'}], before['revision'])
        self.assertEqual(self.session.store.read(), before)
        result = self.session.import_responses([row], before['revision'])
        self.assertEqual(result['history'][0]['comment'], 'Exact note. \n')
        self.assertEqual(result['history'][0]['replies'][-1]['text'], row['text'])
        with self.assertRaises(ValueError):
            self.session.import_responses([row], before['revision'])

    def test_update_retains_old_response_and_new_followup(self):
        h = self.file()['hunks'][0]
        self.session.update('save', self.request(comments={h['id']: 'First note'}))
        self.session.update('file', self.file_request(passage_id=h['id'], text='We score chosen cells.'))
        state = self.session.store.read()
        state['history'] = add_responses(state['history'], [{'id':state['history'][0]['id'],'text':'First reply'}])
        self.session.store.commit(state)
        h = self.file()['hunks'][0]
        self.session.update('save', self.request(comments={h['id']:'Follow-up note'}))
        self.session.update('file', self.file_request(passage_id=h['id'], text='We score final cells.'))
        history = self.session.store.read()['history']
        self.assertEqual([e['comment'] for e in history], ['First note','Follow-up note'])
        self.assertEqual(history[0]['replies'][-1]['text'], 'First reply')
        self.assertEqual(len({e['id'] for e in history}), 2)
