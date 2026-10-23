#!/usr/bin/env python3
"""Local dev server that mimics GitHub Pages: extensionless paths serve the
matching .html file (so /portal/admin -> portal/admin.html). Usage:
    python3 dev-server.py 8080
"""
import http.server, os, sys, urllib.parse

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = urllib.parse.urlparse(path).path
        full = super().translate_path(clean)
        if not os.path.exists(full) and not os.path.splitext(clean)[1]:
            if os.path.exists(full + '.html'):
                return full + '.html'
        return full
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
