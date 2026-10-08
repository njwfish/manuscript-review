import json
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_review import ReviewFixture
from manuscript_review.library import Library, inspect_repo, working_snapshot
from manuscript_review.server import create_server
from manuscript_review.storage import ReviewStore
from manuscript_review.comparison import git


class LibraryTests(ReviewFixture):
    def test_library_create_update_and_clean_import(self):
        library = Library(self.root / 'library')
        request = {'repo':str(self.repo),'base':self.base,'proposed':'working','entry':''}
        library.prepare(request,'one')
        self.assertEqual(library.jobs['one']['status'], 'ready')
        identifier=library.jobs['one']['review'];store=ReviewStore(library.directory(identifier))
        record=store.read();g=record['snapshot']['files'][0]['edits'][0]
        record['comments'][g['id']]='Original request';record['decisions'][g['id']]='accept';store.commit(record)
        library.prepare(request,'same');self.assertEqual(library.jobs['same']['review'],identifier)
        self.assertEqual(library.listing()[0]['done'],1)
        imported=library.import_review(library.directory(identifier))
        copied=ReviewStore(library.directory(imported)).read()
        self.assertEqual(copied['comments'],record['comments'])
        self.assertNotEqual(copied['snapshot']['token'],record['snapshot']['token'])
        path=self.repo/'main.tex';path.write_text(path.read_text().replace('measured leaves','selected leaves'))
        library.prepare({**request,'previous':identifier},'next')
        second=ReviewStore(library.directory(library.jobs['next']['review'])).read()
        self.assertEqual(second['history'][0]['comment'],'Original request')
        self.assertEqual(store.read(),record)

    def test_working_snapshot_preserves_staged_index(self):
        path=self.repo/'main.tex';path.write_text('Staged source');git(self.repo,'add','main.tex');path.write_text('Working source')
        index=git(self.repo,'ls-files','--stage');head=git(self.repo,'rev-parse','HEAD')
        revision,_=working_snapshot(self.repo)
        self.assertEqual(git(self.repo,'show',revision+':main.tex'), b'Working source')
        self.assertEqual(git(self.repo,'ls-files','--stage'),index)
        self.assertEqual(git(self.repo,'rev-parse','HEAD'),head)

    def test_http_requires_revision_and_preserves_notes_across_windows(self):
        server=create_server(self.directory)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base='http://127.0.0.1:'+str(server.server_address[1])
        token=self.session.snapshot['token']
        def post(value):
            request=Request(base+'/save',json.dumps(value).encode(),headers={'Content-Type':'application/json','X-Review-Token':token})
            return json.load(urlopen(request))
        try:
            initial=self.request(comments={self.file()['edits'][0]['id']: 'Saved note'})
            self.assertEqual(post(initial)['revision'],1)
            with self.assertRaises(HTTPError) as error:post(initial)
            self.assertEqual(error.exception.code,409)
            self.assertTrue(json.load(error.exception)['stale'])
            self.assertEqual(json.load(urlopen(base+'/data'))['revision'],1)
            request=Request(base+'/save',json.dumps(self.request()).encode(),headers={'Content-Type':'application/json','X-Review-Token':'wrong'})
            with self.assertRaises(HTTPError) as error:urlopen(request)
            self.assertEqual(error.exception.code,403)
        finally:
            server.shutdown();server.server_close()
