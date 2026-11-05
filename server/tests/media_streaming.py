#!/usr/bin/env python3
"""Real-binary media transport tests; no mocked HTTP/filesystem consumers."""

import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import quote

BINARY = os.environ.get(
    "LATTICE_SERVER_BINARY",
    str(Path(__file__).parents[1] / "target/debug/lattice-server"),
)


class MediaStreaming(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="lattice-media-")
        cls.base = Path(cls.temp.name)
        cls.root = cls.base / "workspace"
        cls.project = cls.root / "paper"
        cls.project.mkdir(parents=True)
        cls.payload = bytes(range(256)) * 4
        (cls.project / "clip.MP4").write_bytes(cls.payload)
        (cls.project / "empty.webm").touch()
        with (cls.project / "large.webm").open("wb") as file:
            file.truncate(1024**3)
            file.seek(1024**3 - 4)
            file.write(b"TAIL")
        (cls.project / ".private.mp4").write_bytes(b"PRIVATE")
        (cls.project / "hidden-alias.mp4").symlink_to(cls.project / ".private.mp4")
        (cls.base / "outside.mp4").write_bytes(b"OUTSIDE")
        (cls.project / "escape.mp4").symlink_to(cls.base / "outside.mp4")
        (cls.project / "linked").symlink_to(cls.project, target_is_directory=True)
        os.mkfifo(cls.project / "pipe.mp4")
        cls.token_file = cls.base / "server.token"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.log = (cls.base / "server.log").open("w+")
        cls.server = subprocess.Popen(
            [
                BINARY,
                "serve",
                "--workspace-root",
                str(cls.root),
                "--project",
                str(cls.project),
                "--state-dir",
                str(cls.base / "state"),
                "--token-file",
                str(cls.token_file),
                "--listen",
                f"127.0.0.1:{cls.port}",
            ],
            stdout=cls.log,
            stderr=cls.log,
        )
        for _ in range(200):
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            try:
                if cls.request("GET", "/api/session", auth=False)[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("Server did not become ready")
        cls.token = cls.token_file.read_text().strip()

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(
        cls, method="GET", path="/api/asset?path=clip.MP4", auth=True, headers=None
    ):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=3)
        sent = dict(headers or {})
        if auth:
            sent["Authorization"] = "Bearer " + cls.token
        connection.request(method, path, headers=sent)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_get_head_and_media_mime(self):
        status, headers, body = self.request()
        self.assertEqual((status, body), (200, self.payload))
        self.assertEqual(headers["content-type"], "video/mp4")
        self.assertEqual(headers["accept-ranges"], "bytes")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertIn("no-store", headers["cache-control"])
        status, headers, body = self.request("HEAD", headers={"Range": "bytes=4-9"})
        self.assertEqual((status, body, headers["content-length"]), (200, b"", "1024"))
        status, headers, body = self.request(path="/api/asset?path=empty.webm")
        self.assertEqual(
            (status, body, headers["content-length"], headers["content-type"]),
            (200, b"", "0", "video/webm"),
        )

    def test_single_open_suffix_and_clamped_ranges(self):
        cases = [
            ("bytes=4-9", 4, 9),
            ("bytes=1020-", 1020, 1023),
            ("bytes=-5", 1019, 1023),
            ("bytes=1022-99999", 1022, 1023),
            ("bytes=-99999", 0, 1023),
        ]
        for value, start, end in cases:
            with self.subTest(value=value):
                status, headers, body = self.request(headers={"Range": value})
                self.assertEqual((status, body), (206, self.payload[start : end + 1]))
                self.assertEqual(headers["content-range"], f"bytes {start}-{end}/1024")
                self.assertEqual(headers["content-length"], str(end - start + 1))

    def test_invalid_and_unsatisfiable_ranges(self):
        for value in [
            "bytes=1024-",
            "bytes=9-4",
            "bytes=-0",
            "bytes=0-1,4-5",
            "bytes=",
            "items=0-1",
            "bytes=18446744073709551616-",
            "bytes=+1-4",
            "bytes=--",
        ]:
            with self.subTest(value=value):
                status, headers, _ = self.request(headers={"Range": value})
                self.assertEqual(status, 416)
                self.assertEqual(headers["content-range"], "bytes */1024")
        self.assertEqual(
            self.request(
                path="/api/asset?path=empty.webm", headers={"Range": "bytes=0-"}
            )[0],
            416,
        )

    def test_large_sparse_file_uses_bounded_streaming(self):
        status, headers, body = self.request(
            path="/api/asset?path=large.webm", headers={"Range": "bytes=-4"}
        )
        self.assertEqual(
            (status, body, headers["content-range"]),
            (206, b"TAIL", f"bytes {1024**3 - 4}-{1024**3 - 1}/{1024**3}"),
        )
        status, headers, body = self.request("HEAD", "/api/asset?path=large.webm")
        self.assertEqual(
            (status, body, headers["content-length"]), (200, b"", str(1024**3))
        )
        # Abandon a full large-file response; the next request must still work.
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(
            "GET",
            "/api/asset?path=large.webm",
            headers={"Authorization": "Bearer " + self.token},
        )
        response = connection.getresponse()
        self.assertEqual((response.status, len(response.read(64))), (200, 64))
        connection.close()
        self.assertEqual(self.request()[2], self.payload)

    def test_validators_restart_stale_ranges(self):
        _, headers, _ = self.request()
        etag = headers["etag"]
        self.assertEqual(
            self.request(headers={"Range": "bytes=0-2", "If-Range": etag})[0], 206
        )
        self.assertEqual(self.request(headers={"If-None-Match": "W/" + etag})[0], 304)
        self.assertEqual(self.request("HEAD", headers={"If-None-Match": etag})[0], 304)
        self.assertEqual(
            self.request(headers={"Range": "bytes=0-2", "If-Range": '"stale"'})[2],
            self.payload,
        )
        source = self.project / "version.mp4"
        source.write_bytes(b"FIRST")
        path = "/api/asset?path=version.mp4"
        old = self.request(path=path)[1]["etag"]
        replacement = self.project / "replacement.mp4"
        replacement.write_bytes(b"SECOND")
        replacement.replace(source)
        status, headers, body = self.request(
            path=path, headers={"Range": "bytes=0-2", "If-Range": old}
        )
        self.assertEqual((status, body), (200, b"SECOND"))
        self.assertNotEqual(headers["etag"], old)

    def test_parent_swap_never_serves_outside_bytes(self):
        directory = self.project / "racing"
        directory.mkdir()
        (directory / "clip.mp4").write_bytes(b"SAFE")
        parked = self.project / "racing-parked"
        outside = self.base / "outside-dir"
        outside.mkdir()
        (outside / "clip.mp4").write_bytes(b"OUTSIDE")
        stop = threading.Event()

        def swap():
            while not stop.is_set():
                directory.rename(parked)
                directory.symlink_to(outside, target_is_directory=True)
                directory.unlink()
                parked.rename(directory)

        worker = threading.Thread(target=swap)
        worker.start()
        try:
            for _ in range(60):
                status, _, body = self.request(path="/api/asset?path=racing/clip.mp4")
                self.assertIn(status, (200, 403, 404))
                if status == 200:
                    self.assertEqual(body, b"SAFE")
                self.assertNotIn(b"OUTSIDE", body)
        finally:
            stop.set()
            worker.join(timeout=3)
        self.assertFalse(worker.is_alive())

    def test_auth_origin_and_descriptor_boundaries(self):
        for method in ("GET", "HEAD"):
            self.assertEqual(self.request(method, auth=False)[0], 401)
            self.assertEqual(
                self.request(method, headers={"Origin": "https://attacker.invalid"})[0],
                403,
            )
        for name in [
            ".private.mp4",
            "hidden-alias.mp4",
            "escape.mp4",
            "linked/clip.MP4",
            "pipe.mp4",
            ".",
            "../outside.mp4",
        ]:
            with self.subTest(path=name):
                status, _, body = self.request(path="/api/asset?path=" + quote(name))
                self.assertIn(status, (403, 404))
                self.assertNotIn(b"OUTSIDE", body)
                self.assertNotIn(b"PRIVATE", body)
                self.assertNotIn(str(self.base).encode(), body)


if __name__ == "__main__":
    unittest.main()
