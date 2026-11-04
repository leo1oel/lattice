"""Consumer tests for installation planning and preservation of unrelated services."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("install-headless-service.py")
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DeploymentTests(unittest.TestCase):
    def test_dry_run_quotes_real_paths_and_keeps_secrets_out_of_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            binary = root / "lattice server%binary"
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o700)
            assets = root / "web assets"
            assets.mkdir()
            (assets / "index.html").write_text("<html></html>")
            workspace = root / "papers with spaces"
            workspace.mkdir()
            arguments = ["python3", str(SCRIPT), "--binary", str(binary), "--assets", str(assets),
                         "--workspace-root", str(workspace), "--data-dir", str(root / "private%state"), "--dry-run", "--tailscale"]
            result = subprocess.run(arguments, text=True, capture_output=True, env={**os.environ, "XDG_CONFIG_HOME": str(root / "config")})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"' + str(root / "private%%state/current/lattice-server") + '"', result.stdout)
            self.assertIn('"127.0.0.1:18482"', result.stdout)
            self.assertIn('"--secure-cookies"', result.stdout)
            self.assertIn("UMask=0077", result.stdout)
            self.assertFalse((root / "private%state").exists())
            outside = root / "outside"
            outside.mkdir()
            result = subprocess.run(arguments + ["--project", str(outside)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("inside the workspace", result.stderr)

    def test_serve_preserves_unrelated_handlers_and_accepts_exact_existing_proxy(self):
        self.assertEqual(installer.serve_port_state({}, 8443, "http://127.0.0.1:18482"), "free")
        status = {"TCP": {"8443": {"HTTPS": True}}, "Web": {"server.tail.example:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:18482"}}}}}
        self.assertEqual(installer.serve_port_state(status, 8443, "http://127.0.0.1:18482"), "ours")
        with self.assertRaisesRegex(RuntimeError, "unrelated handler"):
            installer.serve_port_state(status, 8443, "http://127.0.0.1:9000")


if __name__ == "__main__":
    unittest.main()
