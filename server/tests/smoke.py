#!/usr/bin/env python3
"""Production-binary integration tests. No mocked domain or HTTP backend.

LATTICE_SERVER_BINARY=/path/to/lattice-server python3 server/tests/smoke.py
Set LATTICE_TEST_LATEX=1 to require a real latexmk/PDF build as well.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

BINARY = os.environ.get("LATTICE_SERVER_BINARY", str(Path(__file__).parents[1] / "target/debug/lattice-server"))

class HeadlessSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="lattice-headless-")
        cls.base = Path(cls.temp.name)
        cls.workspace = cls.base / "workspace"
        cls.workspace.mkdir()
        for name in ("alpha", "beta"):
            directory = cls.workspace / name
            directory.mkdir()
            (directory / "main.tex").write_text("\\documentclass{article}\n\\begin{document}Headless Linux.\\end{document}\n")
            (directory / "notes.md").write_text(name + " original\n")
        cls.outside = cls.base / "outside.txt"
        cls.outside.write_text("outside sentinel")
        (cls.workspace / "alpha" / "escape.txt").symlink_to(cls.outside)
        cls.assets = cls.base / "dist"
        cls.assets.mkdir()
        (cls.assets / "index.html").write_text("<!doctype html><html><head></head><body>workspace</body></html>")
        cls.token_file = cls.base / "server.token"
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        cls.port = sock.getsockname()[1]
        sock.close()
        cls.log = open(cls.base / "server.log", "w+")
        environment = dict(os.environ)
        environment.pop("DISPLAY", None)
        environment.pop("WAYLAND_DISPLAY", None)
        cls.server = subprocess.Popen([BINARY, "serve", "--workspace-root", str(cls.workspace), "--project", str(cls.workspace / "alpha"), "--state-dir", str(cls.base / "state"), "--token-file", str(cls.token_file), "--listen", f"127.0.0.1:{cls.port}", "--assets", str(cls.assets)] + json.loads(os.environ.get("LATTICE_TEST_SERVER_ARGS", "[]")), env=environment, stdout=cls.log, stderr=cls.log)
        for _ in range(200):
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            try:
                if cls.request("GET", "/api/session")[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.05)
        else:
            raise RuntimeError("Server did not become ready")
        cls.token = cls.token_file.read_text().strip()
        cls.cookie = cls.login()

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, path, value=None, cookie=None, bearer=False, origin=None, port=None, extra_headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port or cls.port, timeout=90)
        headers = {}
        if value is not None:
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        if bearer:
            headers["Authorization"] = "Bearer " + cls.token
        if origin:
            headers["Origin"] = origin
        headers.update(extra_headers or {})
        connection.request(method, path, json.dumps(value) if value is not None else None, headers)
        response = connection.getresponse()
        data = response.read()
        result = (response.status, dict(response.getheaders()), data)
        connection.close()
        return result

    @classmethod
    def login(cls):
        status, headers, _ = cls.request("POST", "/api/session", {"token": cls.token})
        assert status == 200
        return headers["set-cookie"].split(";", 1)[0]

    def invoke(self, command, args=None, cookie=None):
        status, _, body = self.request("POST", "/api/invoke", {"command": command, "args": args or {}}, cookie=cookie or self.cookie)
        return status, json.loads(body)

    def test_authentication_and_origin(self):
        self.assertEqual(self.request("GET", "/api/capabilities")[0], 401)
        self.assertEqual(self.request("POST", "/api/invoke", {"command": "initial_project"})[0], 401)
        self.assertEqual(self.request("POST", "/api/session", {"token": "wrong"})[0], 401)
        self.assertEqual(self.request("GET", "/api/capabilities", bearer=True, origin="https://attacker.example")[0], 403)
        status, headers, _ = self.request("POST", "/api/session", {"token": self.token})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["set-cookie"])
        self.assertIn("SameSite=Strict", headers["set-cookie"])
        self.assertEqual(self.token_file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.token.encode(), self.request("GET", "/api/session")[2])

    def test_edit_persists_with_shared_history(self):
        status, result = self.invoke("write_project_file", {"path": "notes.md", "content": "saved by HTTP\n", "baseContent": "alpha original\n", "projectRoot": str(self.workspace / "alpha")})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.invoke("read_project_file", {"path": "notes.md"})[1]["result"], "saved by HTTP\n")
        self.assertTrue(self.invoke("list_history")[1]["result"])
        process = subprocess.run([BINARY, "invoke", "read_project_file", "--project", str(self.workspace / "alpha"), "--state-dir", str(self.base / "cli-state")], input=json.dumps({"path": "notes.md"}), text=True, capture_output=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["result"], "saved by HTTP\n")

    def test_independent_projects_and_pinned_writes(self):
        cookie = self.login()
        status, result = self.invoke("open_project", {"path": str(self.workspace / "beta")}, cookie=cookie)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.invoke("read_project_file", {"path": "notes.md"}, cookie=cookie)[1]["result"], "beta original\n")
        self.assertEqual(Path(self.invoke("initial_project")[1]["result"]["root"]).name, "alpha")
        status, _ = self.invoke("write_project_file", {"path": "notes.md", "content": "wrong project", "projectRoot": str(self.workspace / "alpha")}, cookie=cookie)
        self.assertEqual(status, 400)
        self.assertEqual((self.workspace / "beta" / "notes.md").read_text(), "beta original\n")

    def test_escape_hidden_assets_and_unsupported(self):
        for path in ("../outside.txt", str(self.outside), "escape.txt"):
            self.assertNotEqual(self.invoke("read_project_file", {"path": path})[0], 200)
        self.assertNotEqual(self.invoke("write_project_file", {"path": "escape.txt", "content": "bad"})[0], 200)
        self.assertEqual(self.outside.read_text(), "outside sentinel")
        self.invoke("initial_project")
        self.assertEqual(self.request("GET", "/api/asset?path=.research%2Fproject.json", cookie=self.cookie)[0], 403)
        status, result = self.invoke("native_window_magic")
        self.assertEqual(status, 400)
        self.assertEqual(result["error"]["code"], "unsupported_command")

    def test_logout_revokes_session(self):
        cookie=self.login()
        self.assertEqual(self.request("DELETE","/api/session",cookie=cookie)[0],204)
        self.assertEqual(self.request("GET","/api/capabilities",cookie=cookie)[0],401)

    def test_static_bootstrap_and_capabilities(self):
        for path in ("/", "/index.html"):
            self.assertIn(b"window.__LATTICE_HEADLESS__=true", self.request("GET", path)[2])
        status, _, body = self.request("GET", "/api/capabilities", cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertIn("build_project", json.loads(body)["commands"])
        self.assertIn("agent_sidecar", json.loads(body)["unavailable"])

    @unittest.skipUnless(os.environ.get("LATTICE_TEST_LATEX") == "1", "set LATTICE_TEST_LATEX=1 to require a real TeX toolchain")
    def test_real_latex_build_and_pdf(self):
        status, result = self.invoke("build_project", {"projectRoot": str(self.workspace / "alpha"), "force": True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["result"]["hasPdf"], result)
        pdf=bytes(self.invoke("read_compiled_pdf")[1]["result"])
        self.assertTrue(pdf.startswith(b"%PDF-"))
        preview=self.invoke("read_project_asset",{"path":"main.pdf"})[1]["result"]
        version=preview["ranges"]["version"]
        status,_,data=self.request("GET",f"/api/asset?path=main.pdf&version={version}&start=0&end=5",cookie=self.cookie)
        self.assertEqual(status,200)
        self.assertEqual(data,b"%PDF-")
        self.assertEqual(self.request("GET","/api/asset?path=main.pdf&version=stale&start=0&end=5",cookie=self.cookie)[0],409)

if __name__ == "__main__":
    unittest.main()
