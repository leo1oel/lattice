#!/usr/bin/env python3
"""Real CLI/HTTP consumers for operations shared with desktop IPC."""

import base64
import json
import os
from pathlib import Path
import subprocess
import unittest
import zipfile
import smoke


class CoreParity(unittest.TestCase):
    request = smoke.HeadlessSmoke.__dict__["request"]
    login = smoke.HeadlessSmoke.__dict__["login"]
    invoke = smoke.HeadlessSmoke.__dict__["invoke"]

    @classmethod
    def setUpClass(cls):
        smoke.HeadlessSmoke.setUpClass.__func__(cls)
        (cls.workspace / "alpha/escape.txt").unlink()
        cls.invoke(cls, "initial_project")

    @classmethod
    def tearDownClass(cls):
        smoke.HeadlessSmoke.tearDownClass.__func__(cls)

    def test_native_history_names_and_project_settings(self):
        status, result = self.invoke(
            "write_project_file",
            {"path": "parity.md", "content": "history through the API\n"},
        )
        self.assertEqual(status, 200, result)
        history = self.invoke("list_history")[1]["result"]
        identifier = history[0]["id"]
        status, result = self.invoke(
            "revert_transaction", {"transactionId": identifier}
        )
        self.assertEqual(status, 200, result)
        self.assertIsInstance(result["result"], str)
        self.assertEqual(
            self.invoke("delete_history_entry", {"transactionId": identifier})[0], 200
        )
        self.assertEqual(
            self.invoke(
                "set_project_spelling_words", {"words": ["Landlock", "SyncTeX"]}
            )[0],
            200,
        )
        self.assertEqual(
            self.invoke("set_project_deadline", {"deadline": None})[0], 200
        )
        self.assertEqual(
            self.invoke(
                "save_annotations",
                {
                    "annotations": [],
                    "rounds": [],
                    "save": 1,
                    "projectRoot": str(self.workspace / "alpha"),
                },
            )[0],
            200,
        )
        self.assertEqual(
            self.invoke("list_annotations")[1]["result"]["annotations"], []
        )
        self.assertEqual(
            self.invoke(
                "restore_annotation_round",
                {
                    "projectRoot": str(self.workspace / "alpha"),
                    "label": "Restore a reviewed round",
                    "files": [
                        {
                            "path": "parity.md",
                            "before": None,
                            "after": "reviewed text\n",
                        }
                    ],
                },
            )[0],
            200,
        )
        self.assertEqual(
            self.invoke("read_project_file", {"path": "parity.md"})[1]["result"],
            "reviewed text\n",
        )

    def test_binary_assets_replace_and_zip_roundtrip(self):
        raw = b"\x89PNG\r\n\x1a\nfixture"
        status, result = self.invoke(
            "write_project_bytes",
            {"path": "image.png", "base64Data": base64.b64encode(raw).decode()},
        )
        self.assertEqual(status, 200, result)
        self.assertEqual((self.workspace / "alpha/image.png").read_bytes(), raw)
        self.invoke(
            "write_project_file",
            {"path": "replace.md", "content": "original placeholder\n"},
        )
        self.assertEqual(
            self.invoke(
                "replace_in_project",
                {"query": "placeholder", "replacement": "replacement"},
            )[0],
            200,
        )
        self.assertIn(
            "replacement",
            self.invoke("read_project_file", {"path": "replace.md"})[1]["result"],
        )
        self.assertEqual(
            self.invoke("export_project_zip", {"zipPath": str(self.outside)})[0], 400
        )
        source = (self.workspace / "alpha/main.tex").read_bytes()
        self.assertEqual(
            self.invoke("export_project_zip", {"zipPath": "main.tex"})[0], 400
        )
        self.assertEqual((self.workspace / "alpha/main.tex").read_bytes(), source)
        self.assertEqual(
            self.invoke("export_project_zip", {"zipPath": ".research/source.zip"})[0],
            400,
        )
        self.assertFalse((self.workspace / "alpha/.research/source.zip").exists())
        archive = self.workspace / "alpha/paper.zip"
        status, result = self.invoke("export_project_zip", {"zipPath": str(archive)})
        self.assertEqual(status, 200, result)
        with zipfile.ZipFile(archive) as bundle:
            self.assertIn("main.tex", bundle.namelist())
            self.assertFalse(
                any(name.startswith(".research/") for name in bundle.namelist())
            )
        process = subprocess.run(
            [
                smoke.BINARY,
                "invoke",
                "import_project_zip",
                "--project",
                str(self.workspace),
                "--state-dir",
                str(self.base / "import-state"),
            ],
            input=json.dumps({"zipPath": str(archive), "parent": str(self.workspace)}),
            capture_output=True,
            text=True,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        imported = json.loads(process.stdout)["result"]
        self.assertTrue((Path(imported["root"]) / "main.tex").is_file())
        self.assertNotEqual(Path(imported["root"]), self.workspace / "alpha")

    @unittest.skipUnless(
        os.environ.get("LATTICE_TEST_LATEX") == "1",
        "requires actual latexmk and synctex",
    )
    def test_real_synctex_forward_inverse_and_boundaries(self):
        source = "\\documentclass{article}\n\\begin{document}\nA real SyncTeX navigation target.\n\\end{document}\n"
        self.assertEqual(
            self.invoke("write_project_file", {"path": "main.tex", "content": source})[
                0
            ],
            200,
        )
        status, result = self.invoke("build_project", {"force": True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["result"]["hasPdf"], result)
        status, forward = self.invoke(
            "synctex_view", {"path": "main.tex", "line": 3, "column": 1}
        )
        self.assertEqual(status, 200, forward)
        self.assertIsNotNone(forward["result"], forward)
        position = forward["result"]
        status, inverse = self.invoke(
            "synctex_edit",
            {"page": position["page"], "x": position["x"], "y": position["y"]},
        )
        self.assertEqual(status, 200, inverse)
        self.assertEqual(inverse["result"]["path"], "main.tex")
        self.assertGreater(inverse["result"]["line"], 0)
        self.assertEqual(
            self.invoke(
                "synctex_view", {"path": str(self.outside), "line": 1, "column": 1}
            )[0],
            400,
        )
        self.assertEqual(
            self.invoke("synctex_edit", {"page": 0, "x": 0, "y": 0})[0], 400
        )
        self.assertEqual(
            self.invoke(
                "synctex_heading_pages", {"headings": [{"path": "main.tex", "line": 3}]}
            )[0],
            200,
        )


if __name__ == "__main__":
    unittest.main()
