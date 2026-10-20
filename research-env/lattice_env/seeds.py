"""The seed papers tasks are generated from, each with its licence recorded.

A seed is a small LaTeX project that builds cleanly under the pinned build:
no errors and no undefined references, so every problem in a generated task
is the one the generator put there.

Two sources, both public:

- **Lattice's bundled templates** (`src-tauri/templates/`): the tutorial
  paper and the NeurIPS, ICML and ICLR skeletons, written into a project the
  way Lattice's own project creation writes them.
- **Seeds written for this environment** (`research-env/seeds/<name>/`),
  Apache-2.0 like the rest of Lattice, with a `seed.json` naming the root.

Conference style files ship unmodified and carry no licence grant of their
own (see each template's UPSTREAM.md); they are recorded as such, so a
dataset release can decide whether to include tasks that need them. The
tutorial's two figure panels reproduce Google's Transformer figure under a
grant limited to scholarly use, which is not a licence an Apache-2.0 release
can pass on, so the seed swaps them for plain placeholder images of the same
size, generated here, and words its caption accordingly.

Private seeds (the rotating held-out split) are folders in the same layout
outside the repository, passed with `--seeds-dir`.
"""

from __future__ import annotations

import json
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

ENV_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ENV_ROOT.parent
TEMPLATES = REPO_ROOT / "src-tauri" / "templates"
SEEDS_DIR = ENV_ROOT / "seeds"

APACHE = "Apache-2.0"
NO_GRANT = "LicenseRef-no-grant"
# The natbib-derived .bst files: "LaTeX Project Public License, version 1 or later".
LPPL = "LPPL-1.0+"
# Licences a public dataset can pass on, attribution aside.
REDISTRIBUTABLE = (APACHE, LPPL, "MIT", "CC-BY-4.0", "CC0-1.0")


@dataclass
class Seed:
    name: str
    root: str
    files: dict[str, bytes]
    # Path to SPDX identifier (or LicenseRef-*) for every file.
    licences: dict[str, str]
    source: str
    notes: list[str] = field(default_factory=list)

    def text(self, path: str) -> str:
        return self.files[path].decode("utf-8")

    @property
    def redistributable(self) -> bool:
        return all(licence in REDISTRIBUTABLE for licence in self.licences.values())


def placeholder_png(width: int, height: int, shade: int = 0xD8) -> bytes:
    """An opaque grey PNG of the given size, built byte for byte so it is the
    same on every machine (and owes nothing to any image library)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    row = b"\x00" + bytes([shade]) * width
    pixels = zlib.compress(row * height, 9)
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


TUTORIAL_CAPTION = (
    "reproduced from Figure~2 of \\citet{vaswani2017attention} with permission from Google "
    "for use in scholarly works."
)
TUTORIAL_PLACEHOLDER_CAPTION = (
    "after Figure~2 of \\citet{vaswani2017attention}; this copy shows placeholder panels."
)
TUTORIAL_FIGURES = {
    "figures/scaled-dot-product-attention.png": (445, 869),
    "figures/multi-head-attention.png": (826, 1077),
}


def tutorial() -> Seed:
    base = TEMPLATES / "tutorial"
    main = (base / "main.tex").read_text("utf-8")
    if TUTORIAL_CAPTION not in main:
        raise RuntimeError("The tutorial's figure caption changed; update seeds.TUTORIAL_CAPTION.")
    files = {
        "main.tex": main.replace(TUTORIAL_CAPTION, TUTORIAL_PLACEHOLDER_CAPTION).encode("utf-8"),
        "references.bib": (base / "references.bib").read_bytes(),
    }
    for path, (width, height) in TUTORIAL_FIGURES.items():
        files[path] = placeholder_png(width, height)
    # Project creation writes the NeurIPS style under the name the tutorial loads.
    style = (TEMPLATES / "neurips-2026" / "neurips_2026.sty").read_text("utf-8")
    files["neurips.sty"] = style.replace(
        "\\ProvidesPackage{neurips_2026}", "\\ProvidesPackage{neurips}", 1
    ).encode("utf-8")
    licences = {path: APACHE for path in files}
    licences["neurips.sty"] = NO_GRANT
    return Seed("tutorial", "main.tex", files, licences, "src-tauri/templates/tutorial",
                ["figure panels replaced by placeholders: the originals' grant is scholarly-use only"])


SKELETON_TITLES = {
    "neurips-2026": "Sparse Routing for Efficient Sequence Models",
    "icml-2026": "Calibrated Uncertainty for Tabular Benchmarks",
    "iclr-2026": "Curriculum Signals in Self-Supervised Vision",
}


def skeleton(name: str) -> Seed:
    """A conference skeleton as project creation writes it, with a title."""
    base = TEMPLATES / name
    files: dict[str, bytes] = {}
    licences: dict[str, str] = {}
    for path in sorted(base.iterdir()):
        if path.name == "UPSTREAM.md":
            continue
        data = path.read_bytes()
        if path.name == "main.tex":
            data = data.decode("utf-8").replace("LATTICE_PROJECT_TITLE", SKELETON_TITLES[name]).encode("utf-8")
            licences[path.name] = APACHE
        elif path.suffix == ".bst":
            licences[path.name] = LPPL
        else:
            licences[path.name] = NO_GRANT
        files[path.name] = data
    return Seed(name, "main.tex", files, licences, f"src-tauri/templates/{name}")


def from_folder(folder: Path) -> Seed:
    """A seed written in the environment's own layout: the project's files
    plus `seed.json` with its root, licence and any per-file exceptions."""
    meta = json.loads((folder / "seed.json").read_text("utf-8"))
    files = {}
    for path in sorted(folder.rglob("*")):
        if path.is_file() and path.name != "seed.json":
            files[path.relative_to(folder).as_posix()] = path.read_bytes()
    default = meta.get("licence", APACHE)
    licences = {path: meta.get("files", {}).get(path, default) for path in files}
    # Seeds may borrow a bundled conference style instead of carrying a copy.
    for path, template in meta.get("styles", {}).items():
        files[path] = (TEMPLATES / template).read_bytes()
        licences[path] = NO_GRANT
    # Figures are plain placeholders made at load time, so the repository
    # holds no binary images for them.
    for path, (width, height) in meta.get("placeholders", {}).items():
        files[path] = placeholder_png(width, height)
        licences[path] = APACHE
    return Seed(meta.get("name", folder.name), meta.get("root", "main.tex"), files, licences,
                str(folder), meta.get("notes", []))


def from_directory(directory: Path) -> list[Seed]:
    """Every seed folder (one with a `seed.json`) directly inside `directory`."""
    return [from_folder(path) for path in sorted(directory.iterdir()) if (path / "seed.json").is_file()]


def bundled() -> list[Seed]:
    seeds = [tutorial(), *(skeleton(name) for name in SKELETON_TITLES)]
    if SEEDS_DIR.is_dir():
        seeds.extend(from_directory(SEEDS_DIR))
    return seeds


def load(names: list[str] | None = None, extra_dirs: list[Path] | None = None) -> list[Seed]:
    seeds = bundled()
    for directory in extra_dirs or []:
        seeds.extend(from_directory(directory))
    if names:
        wanted = set(names)
        seeds = [seed for seed in seeds if seed.name in wanted]
        missing = wanted - {seed.name for seed in seeds}
        if missing:
            raise SystemExit(f"Unknown seeds: {', '.join(sorted(missing))}")
    return seeds
