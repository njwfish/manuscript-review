import json
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_review import ReviewFixture
from manuscript_review.library import Library, create_library_server
from manuscript_review.storage import atomic_json
from manuscript_review.session import ReviewSession


class SourceDocumentTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.library = Library(self.root / 'library')
        record = self.session.store.read()
        self.identifier = record['metadata']['id']
        self.saved = self.library.reviews / self.identifier
        self.saved.mkdir()
        atomic_json(self.saved / 'review.json',record)

    def test_missing_working_source_uses_the_selected_version_without_restoring_it(self):
        before = (self.saved / 'review.json').read_bytes()
        path = self.repo / 'main.tex'
        original = path.read_text()
        path.unlink()
        source = self.library.source(self.identifier,'main.tex')
        self.assertEqual(source['text'],original)
        self.assertEqual(source['source'],self.session.store.read()['result'])
        self.assertFalse(path.exists())
        self.assertEqual((self.saved / 'review.json').read_bytes(),before)

    def test_a_proposed_deletion_can_open_its_original_source(self):
        self.assertFalse((self.repo / 'deleted.txt').exists())
        source = self.library.source(self.identifier,'deleted.txt')
        self.assertEqual(source['source'],self.base)
        self.assertEqual(source['text'],'Deleted source')
        self.assertFalse((self.repo / 'deleted.txt').exists())

    def test_pinned_documents_keep_their_text_after_decisions_change(self):
        first = self.library.source(self.identifier,'main.tex')
        store = self.library.store(self.identifier)
        record = store.read()
        from manuscript_review.versions import selected_version
        record['decisions'] = {edit['id']:'reject' for file in record['snapshot']['files'] for edit in file['edits']}
        record['result'] = selected_version(record)
        record['revision'] += 1
        store.commit(record)
        self.assertEqual(self.library.source(self.identifier,'main.tex',first['source']),first)
        self.assertNotEqual(self.library.source(self.identifier,'main.tex')['text'],first['text'])

    def test_historical_comments_project_when_both_current_versions_lack_the_file(self):
        session = ReviewSession(self.saved)
        record = session.store.read()
        note = session.save_note({'revision':record['revision'], 'file':'deleted.txt',
                                  'source':record['result'], 'text':'Deleted source',
                                  'start':0, 'end':7, 'comment':'Explain this deletion.'})['entry']
        record = session.store.read()
        record['metadata']['title'] = 'Example manuscript'
        session.store.commit(record)
        path = self.repo / 'main.tex'
        path.write_text(path.read_text() + '\nA subsequent revision.\n')
        self.commit()
        self.library.prepare({'repo':str(self.repo), 'previous':self.identifier, 'proposed':'HEAD'}, 'followup')
        result = self.library.jobs['followup']
        self.assertEqual(result['status'],'ready',result)
        identifier = result['review']
        current = ReviewSession(self.library.directory(identifier))
        before = current.store.path.read_bytes()
        source = self.library.source(identifier,'deleted.txt')
        projection = current.editor('deleted.txt',source['text'],version=source['source'])
        located = next(entry for entry in projection['notes'] if entry['id'] == note['id'])
        self.assertEqual((located['from'],located['to']),(0,7))
        self.assertEqual(projection['source'],current.store.read()['result'])
        self.assertEqual(projection['ranges'],[])
        self.assertEqual(current.store.path.read_bytes(),before)
        reply = current.save_note({'revision':projection['revision'], 'file':'deleted.txt',
                                   'source':projection['source'], 'text':source['text'],
                                   'start':0, 'end':7, 'comment':'The deletion is intentional.',
                                   'parent':note['id']})['entry']
        self.assertEqual(reply['origin_id'],note['origin_id'])
        self.assertEqual(reply['before'],'Deleted')
        self.assertFalse((self.repo / 'deleted.txt').exists())

    def test_deletion_edit_comment_retains_its_original_source_across_rounds(self):
        session = ReviewSession(self.saved)
        record = session.store.read()
        file = next(file for file in record['snapshot']['files'] if file['path'] == 'deleted.txt')
        session.update('save',{'revision':record['revision'], 'decisions':record['decisions'],
                               'comments':{file['edits'][0]['id']:'Explain this deletion.'}})
        record = session.store.read()
        record['metadata']['title'] = 'Example manuscript'
        session.store.commit(record)
        path = self.repo / 'main.tex'
        path.write_text(path.read_text() + '\nAnother revision.\n')
        self.commit()
        self.library.prepare({'repo':str(self.repo), 'previous':self.identifier, 'proposed':'HEAD'}, 'followup')
        result = self.library.jobs['followup']
        self.assertEqual(result['status'],'ready',result)
        identifier = result['review']
        current = ReviewSession(self.library.directory(identifier))
        before = current.store.path.read_bytes()
        source = self.library.source(identifier,'deleted.txt')
        self.assertEqual(source['text'],'Deleted source')
        projection = current.editor('deleted.txt',source['text'],version=source['source'])
        entry = next(entry for entry in current.store.read()['history'] if entry['file'] == 'deleted.txt')
        located = next(note for note in projection['notes'] if note['id'] == entry['id'])
        self.assertEqual((located['from'],located['to']),(0,14))
        self.assertEqual(current.store.path.read_bytes(),before)
        reply = current.save_note({'revision':projection['revision'], 'file':'deleted.txt',
                                   'source':projection['source'], 'text':source['text'],
                                   'start':0, 'end':14, 'comment':'I agree with this deletion.',
                                   'parent':entry['id']})['entry']
        self.assertEqual(reply['origin_id'],entry['origin_id'])
        self.assertFalse((self.repo / 'deleted.txt').exists())

    def test_path_and_version_validation_do_not_write_review_or_source(self):
        before = (self.saved / 'review.json').read_bytes()
        for path in ('../main.tex','/main.tex','./main.tex','a/../main.tex','a\\main.tex','missing.tex'):
            with self.subTest(path=path),self.assertRaises(ValueError):
                self.library.source(self.identifier,path)
        for version in ('HEAD','--all'):
            with self.subTest(version=version),self.assertRaises(ValueError):
                self.library.source(self.identifier,'main.tex',version)
        self.assertEqual((self.saved / 'review.json').read_bytes(),before)

    def test_http_source_requires_library_token_and_returns_immutable_text(self):
        server = create_library_server(self.library)
        worker = threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        endpoint = f'http://127.0.0.1:{server.server_address[1]}/source'
        body = json.dumps({'id':self.identifier,'file':'main.tex'}).encode()
        before = (self.saved / 'review.json').read_bytes()
        try:
            for token in ('wrong',self.library.token):
                request = Request(endpoint,body,headers={'Content-Type':'application/json','X-Review-Token':token})
                if token == 'wrong':
                    with self.assertRaises(HTTPError) as error:
                        urlopen(request)
                    self.assertEqual(error.exception.code,403)
                else:
                    result = json.load(urlopen(request))
                    self.assertEqual(result['text'],(self.repo / 'main.tex').read_text())
            self.assertEqual((self.saved / 'review.json').read_bytes(),before)
        finally:
            server.shutdown();server.server_close();worker.join()
