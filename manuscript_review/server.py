"""HTTP routes delegate review behavior to ReviewSession."""
import re
from urllib.parse import urlsplit, parse_qs
from http.server import ThreadingHTTPServer
from pathlib import Path
from .http import LocalHandler
from .session import ReviewSession
from .storage import StaleReview
from .previews import preview_assets


def review_payload(data, selected=None):
    """Transfer source for the selected file and current feedback only."""
    files = []
    for index, file in enumerate(data['files']):
        file = {**file, 'hunks': [{**passage, **({'rendered': preview_assets({'passage': passage['rendered']})['passage']} if 'rendered' in passage else {})}
                                for passage in file['hunks']]}
        ids = [file['id'] for file in file['edits']] + [passage['id'] for passage in file['hunks']]
        if (file['path'] == selected or index == 0
                or any(data['comments'].get(identifier) for identifier in ids)):
            files.append(file)
            continue
        edits = [{key: value for key, value in edit.items() if key not in ('old', 'new')} for edit in file['edits']]
        groups = {edit['id']: edit for edit in edits}
        hunks = [{key: value for key, value in passage.items() if key not in ('before', 'after', 'segments', 'grouped_segments', 'edits')}
                 | {'edits': [groups[edit['id']] for edit in passage['edits']]} for passage in file['hunks']]
        files.append({key: value for key, value in file.items() if key not in ('before', 'after', 'pieces', 'edits', 'hunks')}
                     | {'loaded': False, 'edits': edits, 'hunks': hunks})
    return {**data, 'files': files}


def create_server(directory, port=0, library_url=None, review_context=None, *, store=None):
    session = ReviewSession(directory, library_url, review_context, store=store)
    token = session.snapshot['token']
    static = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
              '/review_model.js': ('review_model.js', 'text/javascript'),
              '/editor.js': ('editor.js', 'text/javascript'), '/host.js': ('host.js', 'text/javascript')}

    class Handler(LocalHandler):
        content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"

        def do_GET(self):
            if not self.trusted():
                return self.response({'error': 'Unexpected host or origin.'}, status=403)
            if self.path in static:
                filename, mime = static[self.path]
                self.response(Path(__file__).with_name(filename).read_bytes(), mime)
            elif urlsplit(self.path).path == '/data':
                query = parse_qs(urlsplit(self.path).query)
                scope = query.get('scope', ['round'])[0]
                if scope not in ('round', 'baseline', 'manuscript'):
                    return self.response({'error': 'Unknown comparison scope.'}, status=400)
                result = session.view(scope)
                self.response(review_payload(result, query.get('file', [None])[0]))
                if result['preview_status'] in ('queued', 'rendering'):
                    session.previews.queue('baseline' if scope == 'baseline' else 'round')
            elif urlsplit(self.path).path == '/previews':
                scope = parse_qs(urlsplit(self.path).query).get('scope', ['round'])[0]
                try:
                    self.response(session.preview(scope))
                except ValueError as error:
                    self.response({'error': str(error)}, status=400)
            elif self.path == '/status':
                self.response(session.status())
            elif urlsplit(self.path).path == '/editor':
                try:
                    path = parse_qs(urlsplit(self.path).query).get('file', [''])[0]
                    self.response(session.editor(path))
                except ValueError as error:
                    self.response({'error': str(error)}, status=409)
            elif self.path == '/feedback.json':
                with session.store.lock:
                    self.response(session.report(), attachment='manuscript-review-feedback.json')
            elif urlsplit(self.path).path == '/selected.patch':
                scope = parse_qs(urlsplit(self.path).query).get('scope', ['round'])[0]
                if scope not in ('round', 'baseline', 'manuscript'):
                    return self.response({'error': 'Unknown comparison scope.'}, status=400)
                self.response(session.selected_patch(scope), 'text/plain', attachment='manuscript-selected.patch')
            elif self.path.startswith(('/assets/', '/baseline-assets/')) and re.fullmatch(r'[A-Za-z0-9_-]+\.(?:svg|pdf)', self.path.rsplit('/', 1)[-1]):
                path = session.directory / ('baseline-renders' if self.path.startswith('/baseline-assets/') else 'renders') / self.path.rsplit('/', 1)[-1]
                if path.exists():
                    self.response(path.read_bytes(), 'application/pdf' if path.suffix == '.pdf' else 'image/svg+xml')
                else:
                    self.response({'error': 'Preview not found'}, status=404)
            else:
                self.response({'error': 'Not found'}, status=404)

        def do_POST(self):
            if not self.trusted() or self.headers.get('X-Review-Token') != token:
                return self.response({'error': 'Unexpected origin or review token.'}, status=403)
            try:
                request = self.read_request()
                if self.path == '/editor':
                    result = session.editor(request['file'], request['text'], request.get('point'), request.get('version'))
                elif self.path == '/workspace':
                    result = session.edit_workspace(request)
                elif self.path == '/capture':
                    result = session.capture_file(request)
                elif self.path == '/responses':
                    result = session.import_responses(request['responses'], request['revision'])
                elif self.path == '/explanations':
                    result = session.import_explanations(request['explanations'], request['revision'])
                elif self.path == '/ui':
                    result = session.save_ui(request.get('ui'))
                elif self.path == '/draft':
                    result = session.save_draft(request)
                elif self.path == '/note':
                    result = session.save_note(request)
                elif self.path == '/thread':
                    result = session.resolve_thread(request)
                elif self.path == '/agent-request':
                    result = session.agent_request(request)
                elif self.path == '/agent':
                    from .dispatch import dispatch_comment
                    result = dispatch_comment(session.agent_request(request), request['agent'], session.directory.parent.parent)
                elif self.path == '/retain':
                    session.store.backup_request(request)
                    result = {'message': 'Unsaved changes retained.'}
                else:
                    result = session.update(self.path.removeprefix('/'), request)
                if isinstance(result.get('data'), dict):
                    result['data'] = review_payload(result['data'], request.get('file'))
                self.response(result)
            except StaleReview as error:
                self.response({'error': str(error), 'stale': True}, status=409)
            except (ValueError, KeyError, UnicodeError) as error:
                self.response({'error': str(error)}, status=409)
            except Exception as error:
                self.response({'error': str(error)}, status=500)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    session.resume_previews()
    return server
