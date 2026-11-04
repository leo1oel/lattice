#!/usr/bin/env python3
"""A public-content-only native WebView QA fixture; no account or project files."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer

PAGES = {
    "/": """<!doctype html><meta charset=utf-8><title>Browser fixture one</title>
<h1>Browser fixture one</h1><p>This page forbids framing.</p>
<a href=/two>Second page</a> <a href=/two target=_blank>New-window link</a>
<button id=check>Check IPC boundary</button><p id=result></p>
<script>document.getElementById('check').onclick=async()=>{
const commands=['get_app_locale','plugin:window|inner_size'];let blocked=0;
for(const command of commands){try{await window.__TAURI_INTERNALS__.invoke(command)}catch{blocked++}}
document.getElementById('result').textContent=blocked===2?'Workspace and plugin IPC blocked':'ERROR: privileged IPC available';
};</script>""",
    "/two": "<!doctype html><meta charset=utf-8><title>Browser fixture two</title><h1>Browser fixture two</h1><a href=/>First page</a>",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = PAGES.get(self.path)
        self.send_response(200 if data else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write((data or "Not found").encode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18592)
    options = parser.parse_args()
    HTTPServer(("127.0.0.1", options.port), Handler).serve_forever()
