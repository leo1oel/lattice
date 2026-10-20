"""Pinned pdfLaTeX builds: what the verifier means by "the paper builds".

The app's own build follows the writer's context: it retargets the root onto
the open file, switches engines, and honours a project `.latexmkrc`. Each of
those is a lever an agent could pull to change what gets graded, so this
build pins all of them instead:

- a fresh copy of the sources, minus every artifact a previous build (or the
  agent) left beside the root document, so a planted `.aux` or `.bbl` cannot
  stand in for a real pass;
- latexmk with `-norc`: no system, user or project rc file runs, so a Perl
  `.latexmkrc` cannot replace the compiler;
- no shell escape, a fixed root document and the pdfTeX engine only, the one
  whose output was verified byte-identical across runs and folders;
- a fresh HOME and fresh TeX user trees (TEXMFHOME, TEXMFVAR, TEXMFCONFIG), so
  nothing in the real home directory (or an agent-written `~/texmf`) is read;
- a pinned clock (`SOURCE_DATE_EPOCH` with `FORCE_SOURCE_DATE`), without which
  pdfTeX stamps the time into every PDF and no two builds compare equal.

The child gets an environment built from scratch rather than inherited, so
TEXINPUTS and friends cannot redirect the search either.
"""

from __future__ import annotations

import glob
import os
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

# 2023-11-14T22:13:20Z: the epoch the scout report verified determinism under.
DEFAULT_EPOCH = 1_700_000_000
DEFAULT_TIMEOUT_SEC = 120

# Directories that are never part of a submission's sources: version control,
# Lattice's own state, and Python caches the verifier might leave behind.
SKIP_DIRS = frozenset({".git", ".research", "__pycache__", ".texlive-home"})
# Files no TeX run reads that tools drop into a project: Lattice writes a
# `.gitignore` when it opens one (as the in-binary environment does).
SKIP_FILES = frozenset({".gitignore", ".DS_Store"})

# What a build of `<stem>.tex` writes beside it. Removed before every build so
# the pass starts from the sources alone; `.aux` goes everywhere, because each
# `\include`d chapter writes its own.
ROOT_ARTIFACT_SUFFIXES = (
    ".aux", ".bbl", ".bcf", ".blg", ".brf", ".dvi", ".fdb_latexmk", ".fls", ".idx",
    ".ilg", ".ind", ".loa", ".lof", ".log", ".lot", ".nav", ".out", ".pdf",
    ".run.xml", ".snm", ".synctex", ".synctex.gz", ".thm", ".toc", ".vrb", ".xdv",
)

# Where TeX and latexmk live when the PATH does not say: MacTeX's symlink
# farm, TeX Live's own per-year trees, and the distribution's /usr/bin.
TEX_SEARCH_PATHS = (
    "/Library/TeX/texbin",
    "/usr/local/texlive/*/bin/*",
    "/opt/texlive/*/bin/*",
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
)

ENGINE_FLAGS = {"pdf": "-pdf"}


class ToolMissing(RuntimeError):
    """A tool the verifier needs is not installed: an infrastructure failure,
    never the agent's fault, so it must not be scored as a 0."""


@dataclass
class BuildResult:
    success: bool
    timed_out: bool
    pdf: bytes | None
    log: str
    aux: dict[str, str]
    inputs: list[str]
    seconds: float
    workdir: Path
    command: list[str] = field(default_factory=list)

    @property
    def pdf_sha256(self) -> str | None:
        if self.pdf is None:
            return None
        import hashlib

        return hashlib.sha256(self.pdf).hexdigest()


def search_path() -> list[str]:
    entries = [entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry]
    for pattern in TEX_SEARCH_PATHS:
        entries.extend(sorted(glob.glob(pattern), reverse=True))
    seen: list[str] = []
    for entry in entries:
        if entry not in seen:
            seen.append(entry)
    return seen


def find_tool(name: str) -> str:
    found = shutil.which(name, path=os.pathsep.join(search_path()))
    if not found:
        raise ToolMissing(f"{name} is not installed or not on PATH.")
    return found


def is_artifact(relative: str, root_stem: str) -> bool:
    """Whether `relative` is something a build writes, not a source."""
    name = relative.rsplit("/", 1)[-1]
    if name.endswith(".aux"):
        return True
    if "/" in relative:
        return False
    return any(name == root_stem + suffix for suffix in ROOT_ARTIFACT_SUFFIXES)


def source_files(directory: Path, root: str, keep: frozenset[str] = frozenset()) -> list[str]:
    """Every source file under `directory`, as sorted relative POSIX paths.

    Symlinks are skipped rather than followed: a link out of the project is a
    way to read (or shadow) files the task never contained.
    """
    stem = root.rsplit(".", 1)[0]
    found: list[str] = []
    for current, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in files:
            if name in SKIP_FILES:
                continue
            path = Path(current) / name
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(directory).as_posix()
            if relative in keep or not is_artifact(relative, stem):
                found.append(relative)
    return sorted(found)


def copy_sources(source: Path, target: Path, root: str, keep: frozenset[str] = frozenset()) -> list[str]:
    files = source_files(source, root, keep)
    for relative in files:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, destination)
    return files


def tex_environment(home: Path, tex_bin: str, epoch: int) -> dict[str, str]:
    """The child's whole environment. Nothing is inherited."""
    for tree in ("texmf", "texmf-var", "texmf-config", "tmp"):
        (home / tree).mkdir(parents=True, exist_ok=True)
    return {
        "PATH": os.pathsep.join([tex_bin, "/usr/bin", "/bin"]),
        "HOME": str(home),
        "TEXMFHOME": str(home / "texmf"),
        "TEXMFVAR": str(home / "texmf-var"),
        "TEXMFCONFIG": str(home / "texmf-config"),
        "TMPDIR": str(home / "tmp"),
        "SOURCE_DATE_EPOCH": str(epoch),
        "FORCE_SOURCE_DATE": "1",
        "TZ": "UTC",
        "LC_ALL": "C",
        "LANG": "C",
    }


def latexmk_command(latexmk: str, root: str, engine: str) -> list[str]:
    if engine not in ENGINE_FLAGS:
        raise ValueError(f"Engine {engine!r} is not supported; only pdfTeX output is pinned.")
    return [
        latexmk,
        "-norc",
        "-interaction=nonstopmode",
        "-file-line-error",
        "-halt-on-error",
        ENGINE_FLAGS[engine],
        "-no-shell-escape",
        root,
    ]


def _run(command: list[str], cwd: Path, env: dict[str, str], timeout: float) -> tuple[int | None, str]:
    """Run in a new session so a timeout can stop latexmk and every pass it started."""
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, output.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        output, _ = process.communicate()
        return None, output.decode("utf-8", "replace")


def read_inputs(fls: Path, workdir: Path) -> list[str]:
    """The files TeX read, from the recorder's `.fls`: absolute paths for
    files outside the build folder, relative ones inside it."""
    if not fls.is_file():
        return []
    inputs: list[str] = []
    for line in fls.read_text("utf-8", "replace").splitlines():
        if not line.startswith("INPUT "):
            continue
        name = line[len("INPUT "):].strip()
        path = Path(name)
        if not path.is_absolute():
            path = workdir / path
        resolved = os.path.realpath(path)
        base = os.path.realpath(workdir)
        if resolved == base or resolved.startswith(base + os.sep):
            entry = os.path.relpath(resolved, base)
        else:
            entry = resolved
        if entry not in inputs:
            inputs.append(entry)
    return inputs


def build(
    sources: Path,
    root: str = "main.tex",
    engine: str = "pdf",
    *,
    epoch: int = DEFAULT_EPOCH,
    timeout: float = DEFAULT_TIMEOUT_SEC,
    keep_artifacts: frozenset[str] = frozenset(),
    scratch: Path | None = None,
) -> BuildResult:
    """Build a fresh copy of `sources` and report what came out.

    The copy lives under `scratch` (a new temporary folder when omitted) and is
    left there for the caller to inspect; the caller removes it.
    """
    latexmk = find_tool("latexmk")
    tex_bin = os.path.dirname(find_tool("pdflatex"))
    base = Path(tempfile.mkdtemp(prefix="lattice-build-", dir=scratch))
    workdir = base / "project"
    workdir.mkdir()
    copy_sources(sources, workdir, root, keep_artifacts)
    env = tex_environment(base / ".texlive-home", tex_bin, epoch)
    command = latexmk_command(latexmk, root, engine)
    # Without -recorder there is no .fls, and the inputs check below needs it.
    command.insert(1, "-recorder")
    started = time.monotonic()
    code, output = _run(command, workdir, env, timeout)
    seconds = time.monotonic() - started
    stem = root.rsplit(".", 1)[0]
    pdf_path = workdir / f"{stem}.pdf"
    log_path = workdir / f"{stem}.log"
    log = log_path.read_text("latin-1") if log_path.is_file() else output
    aux = {
        path.relative_to(workdir).as_posix(): path.read_text("latin-1")
        for path in sorted(workdir.rglob("*.aux"))
    }
    success = code == 0 and pdf_path.is_file()
    return BuildResult(
        success=success,
        timed_out=code is None,
        pdf=pdf_path.read_bytes() if pdf_path.is_file() and code is not None else None,
        log=log,
        aux=aux,
        inputs=read_inputs(workdir / f"{stem}.fls", workdir),
        seconds=seconds,
        workdir=workdir,
        command=command,
    )


def system_trees() -> list[str]:
    """The TeX installation's own trees: where a pinned build may read files
    from outside the project. Asked of kpsewhich so it holds for MacTeX,
    TeX Live's installer and Debian's split layout alike."""
    kpsewhich = find_tool("kpsewhich")
    trees: list[str] = []
    for variable in ("SELFAUTOPARENT", "TEXMFROOT", "TEXMFDIST", "TEXMFMAIN", "TEXMFSYSVAR",
                     "TEXMFSYSCONFIG", "TEXMFLOCAL", "TEXMFCNF"):
        result = subprocess.run(
            [kpsewhich, f"-var-value={variable}"],
            capture_output=True, text=True, env={"PATH": os.path.dirname(kpsewhich) + ":/usr/bin:/bin"},
        )
        for value in result.stdout.replace("{", "").replace("}", "").replace(";", ":").split(":"):
            value = value.strip().lstrip("!")
            if value.startswith("/") and os.path.isdir(value):
                trees.append(os.path.realpath(value))
    # Debian keeps the distribution's trees outside SELFAUTOPARENT.
    for fixed in ("/usr/share/texlive", "/usr/share/texmf", "/var/lib/texmf", "/etc/texmf"):
        if os.path.isdir(fixed):
            trees.append(os.path.realpath(fixed))
    return sorted(set(trees))


def outside_inputs(inputs: list[str], trees: list[str]) -> list[str]:
    """Absolute inputs that are neither in the project nor in TeX's own trees."""
    outside = []
    for entry in inputs:
        if not os.path.isabs(entry):
            continue
        if not any(entry == tree or entry.startswith(tree + os.sep) for tree in trees):
            outside.append(entry)
    return outside


def tex_version() -> str:
    """pdfTeX's banner line: the toolchain identity a reference PDF depends on."""
    result = subprocess.run([find_tool("pdflatex"), "--version"], capture_output=True, text=True)
    return result.stdout.splitlines()[0] if result.stdout else "unknown"
