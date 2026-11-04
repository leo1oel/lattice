"""Consumer tests for installation planning and preservation of unrelated services."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SCRIPT = Path(__file__).with_name("install-headless-service.py")
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DeploymentTests(unittest.TestCase):
    def fixture(self, root):
        binary = root / "lattice-server"
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o700)
        assets = root / "assets"
        assets.mkdir()
        (assets / "index.html").write_text("<html></html>")
        workspace = root / "papers"
        workspace.mkdir()
        runtime = root / "runtime"
        runtime.mkdir()
        arguments = [
            "installer",
            "--binary",
            str(binary),
            "--assets",
            str(assets),
            "--workspace-root",
            str(workspace),
            "--data-dir",
            str(root / "data"),
            "--tailscale",
            "--agent-runtime",
            str(runtime),
            "--public-origin",
            "https://node.tail.example:8443",
            "--agent-public-origin",
            "https://node.tail.example:8444",
        ]
        return arguments

    def test_dual_origin_unit_and_explicit_agent_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            arguments = self.fixture(root)
            environment = {**os.environ, "XDG_CONFIG_HOME": str(root / "config")}
            result = subprocess.run(
                ["python3", str(SCRIPT), *arguments[1:], "--dry-run"],
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"--agent-listen" "127.0.0.1:18583"', result.stdout)
            self.assertIn(
                '"--public-origin" "https://node.tail.example:8443"', result.stdout
            )
            self.assertIn(
                '"--agent-public-origin" "https://node.tail.example:8444"',
                result.stdout,
            )
            unit = root / "config/systemd/user/lattice-headless.service"
            unit.parent.mkdir(parents=True)
            unit.write_text(result.stdout)
            simple = arguments[: arguments.index("--agent-runtime")]
            result = subprocess.run(
                ["python3", str(SCRIPT), *simple[1:], "--dry-run"],
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Preserve the existing agent", result.stderr)
            self.assertFalse((root / "data").exists())
            result = subprocess.run(
                ["python3", str(SCRIPT), *simple[1:], "--disable-agent", "--dry-run"],
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('"--agent-runtime"', result.stdout)

    def test_agent_handler_collision_is_refused_before_release_or_service_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            arguments = self.fixture(root)
            status = {
                "TCP": {"8443": {"HTTPS": True}, "8444": {"HTTPS": True}},
                "Web": {
                    "node.tail.example:8443": {
                        "Handlers": {"/": {"Proxy": "http://127.0.0.1:18482"}}
                    },
                    "node.tail.example:8444": {
                        "Handlers": {"/": {"Proxy": "http://127.0.0.1:9000"}}
                    },
                },
            }

            def external(*args, **kwargs):
                self.assertEqual(args, ("tailscale", "serve", "status", "--json"))
                return SimpleNamespace(
                    returncode=0, stdout=json.dumps(status), stderr=""
                )

            with (
                patch.object(sys, "argv", arguments),
                patch.dict(os.environ, {"XDG_CONFIG_HOME": str(root / "config")}),
                patch.object(installer.platform, "system", return_value="Linux"),
                patch.object(installer, "run", side_effect=external),
            ):
                with self.assertRaisesRegex(RuntimeError, "8444.*unrelated handler"):
                    installer.main()
            self.assertFalse((root / "data").exists())
            self.assertFalse(
                (root / "config/systemd/user/lattice-headless.service").exists()
            )

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
            arguments = [
                "python3",
                str(SCRIPT),
                "--binary",
                str(binary),
                "--assets",
                str(assets),
                "--workspace-root",
                str(workspace),
                "--data-dir",
                str(root / "private%state"),
                "--dry-run",
                "--tailscale",
            ]
            result = subprocess.run(
                arguments,
                text=True,
                capture_output=True,
                env={**os.environ, "XDG_CONFIG_HOME": str(root / "config")},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(
                '"' + str(root / "private%%state/current/lattice-server") + '"',
                result.stdout,
            )
            self.assertIn('"127.0.0.1:18482"', result.stdout)
            self.assertIn('"--secure-cookies"', result.stdout)
            self.assertIn("UMask=0077", result.stdout)
            self.assertFalse((root / "private%state").exists())
            outside = root / "outside"
            outside.mkdir()
            result = subprocess.run(
                arguments + ["--project", str(outside)], capture_output=True, text=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("inside the workspace", result.stderr)

    def test_serve_preserves_unrelated_handlers_and_accepts_exact_existing_proxy(self):
        self.assertEqual(
            installer.serve_port_state({}, 8443, "http://127.0.0.1:18482"), "free"
        )
        status = {
            "TCP": {"8443": {"HTTPS": True}},
            "Web": {
                "server.tail.example:8443": {
                    "Handlers": {"/": {"Proxy": "http://127.0.0.1:18482"}}
                }
            },
        }
        self.assertEqual(
            installer.serve_port_state(status, 8443, "http://127.0.0.1:18482"), "ours"
        )
        with self.assertRaisesRegex(RuntimeError, "unrelated handler"):
            installer.serve_port_state(status, 8443, "http://127.0.0.1:9000")


if __name__ == "__main__":
    unittest.main()
