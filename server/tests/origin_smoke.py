#!/usr/bin/env python3
"""Real reverse-proxy compatibility: implicit no-agent HTTPS vs explicit origin."""
import json
import os
import unittest
import smoke


class ReverseProxyOrigin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["LATTICE_TEST_SERVER_ARGS"] = json.dumps(cls.flags)
        smoke.HeadlessSmoke.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        smoke.HeadlessSmoke.tearDownClass.__func__(cls)
        os.environ.pop("LATTICE_TEST_SERVER_ARGS", None)

    request = smoke.HeadlessSmoke.__dict__["request"]
    login = smoke.HeadlessSmoke.__dict__["login"]
    flags = ["--secure-cookies"]

    def test_https_proxy_login_and_real_write(self):
        headers = {"Host": "private.tail.example:8443"}
        origin = "https://private.tail.example:8443"
        status, response, _ = self.request("POST", "/api/session", {"token": self.token}, origin=origin, extra_headers=headers)
        self.assertEqual(status, 200)
        self.assertIn("Secure", response["set-cookie"])
        cookie = response["set-cookie"].split(";", 1)[0]
        status, _, _ = self.request("POST", "/api/invoke", {"command": "write_project_file", "args": {"path": "notes.md", "content": "reverse proxy write\n", "baseContent": "alpha original\n"}}, cookie=cookie, origin=origin, extra_headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual((self.workspace / "alpha/notes.md").read_text(), "reverse proxy write\n")
        for forbidden in ["http://private.tail.example:8443", "https://foreign.example", "https://private.tail.example:8444"]:
            self.assertEqual(self.request("POST", "/api/session", {"token": self.token}, origin=forbidden, extra_headers=headers)[0], 401)
            self.assertEqual(self.request("POST", "/api/invoke", {"command": "initial_project"}, cookie=cookie, origin=forbidden, extra_headers=headers)[0], 403)
        self.assertEqual(self.request("POST", "/api/invoke", {"command": "initial_project"}, cookie=cookie, extra_headers={**headers, "Sec-Fetch-Site": "same-site"})[0], 403)


class ExplicitProxyOrigin(ReverseProxyOrigin):
    flags = ["--secure-cookies", "--public-origin", "https://private.tail.example:8443"]

    def test_explicit_origin_is_not_overridden_by_host(self):
        self.assertEqual(self.request("POST", "/api/session", {"token": self.token}, origin="https://other.tail.example:8443", extra_headers={"Host": "other.tail.example:8443"})[0], 401)


if __name__ == "__main__":
    unittest.main()
