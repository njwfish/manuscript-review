"""Shared localhost transport rules for the library and review servers."""
import json
from http.server import BaseHTTPRequestHandler


class LocalHandler(BaseHTTPRequestHandler):
    content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"

    def log_message(self, *args):
        pass

    def trusted(self):
        port = self.server.server_address[1]
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        return self.headers.get('Host') in hosts and self.headers.get('Origin') in (None, *('http://' + host for host in hosts))

    def read_request(self, limit=2_000_000):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= limit:
            raise ValueError('Invalid request size.')
        request = json.loads(self.rfile.read(length))
        if not isinstance(request, dict):
            raise ValueError('Request must be an object.')
        return request

    def response(self, content, mime='application/json', status=200, attachment=None):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False).encode()
        elif isinstance(content, str):
            content = content.encode()
        self.send_response(status)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', self.content_security_policy)
        if attachment:
            self.send_header('Content-Disposition', f'attachment; filename="{attachment}"')
        self.end_headers()
        self.wfile.write(content)
