"""Repeated proposal words must not revive an adjacent rejected replacement."""
from pathlib import Path

from test_review import ReviewFixture
from manuscript_review.comparison import build_snapshot, git
from manuscript_review.editing import selected_content
from manuscript_review.library import Library
from manuscript_review.session import ReviewSession
from manuscript_review.storage import atomic_json, new_record


class AlignmentSaveTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        (self.repo / 'main.tex').write_text('b a')
        self.commit()
        base = git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        (self.repo / 'main.tex').write_text('changed a')
        self.commit()
        snapshot = build_snapshot(self.repo, base, 'HEAD')
        snapshot.update(source_head=snapshot['proposed'], entry='')
        self.session.store.commit(new_record(snapshot, self.session.store.read()['metadata']))
        edit = self.file()['edits'][0]
        self.session.update('apply', self.request(decisions={edit['id']: 'reject'}))

    def test_native_insertion_beside_rejected_word_preserves_exact_saved_text(self):
        self.session.edit_workspace(self.request())
        previous = self.session.store.read()
        saved = 'b changed a'
        destination = self.repo / 'main.tex'
        destination.write_text(saved)
        timestamp = destination.stat().st_mtime_ns
        request = self.capture_request(file='main.tex', text=saved,
                                       source=previous['metadata']['workspace_version'])

        response = self.session.capture_file(request)

        record = self.session.store.read()
        self.assertEqual(selected_content(self.file(), record['decisions']), saved)
        self.assertEqual(destination.read_text(), saved)
        self.assertEqual(destination.stat().st_mtime_ns, timestamp)
        self.assertEqual(response['cursor'], request['saves'][-1]['id'])
        self.assertEqual(record['baseline'], previous['baseline'])
        added = [edit for edit in self.file()['edits'] if 'changed' in edit['new']]
        self.assertTrue(added)
        self.assertTrue(all(record['decisions'].get(edit['id']) == 'accept' for edit in added))

    def test_parallel_insertion_beside_rejected_word_preserves_exact_proposed_text(self):
        library = Library(self.root / 'library')
        identifier = self.session.store.read()['metadata']['id']
        directory = library.reviews / identifier
        directory.mkdir()
        atomic_json(directory / 'review.json', self.session.store.read())
        self.session = ReviewSession(directory)
        previous = self.session.store.read()
        destination = self.repo / 'main.tex'
        author_text = destination.read_text()
        timestamp = destination.stat().st_mtime_ns
        task = library.begin(identifier, parallel=True)
        proposal = Path(task['workspace']) / 'main.tex'
        proposed = 'b changed a'
        proposal.write_text(proposed)

        library.finish_parallel(identifier, task['starting_version'], task['workspace'])

        record = self.session.store.read()
        self.assertEqual(selected_content(self.file(), record['decisions']), proposed)
        self.assertEqual(destination.read_text(), author_text)
        self.assertEqual(destination.stat().st_mtime_ns, timestamp)
        self.assertEqual(record['baseline'], previous['baseline'])
        added = [edit for edit in self.file()['edits'] if 'changed' in edit['new']]
        self.assertTrue(added)
        self.assertTrue(all(edit['id'] not in record['decisions'] for edit in added))
