import { normalizeProjectRelativePath } from "../project/project-files-changed";

/**
 * Extensions only a LaTeX run writes. latexmk compiles in the project root,
 * so every build lands these beside the sources: the document's own outputs,
 * and an `.aux` per `\include`d chapter.
 */
const GENERATED_FILE = new RegExp(`\\.(?:${[
  "aux", "log", "fls", "fdb_latexmk", "synctex(?:\\.gz)?(?:\\(busy\\))?", "out", "toc", "lof", "lot", "blg", "bcf",
  "run\\.xml", "nav", "snm", "vrb", "xdv", "dvi", "brf", "ilg", "glg", "auxlock", "figlist", "makefile", "dpth", "md5",
].join("|")})$`, "i");

/**
 * What a build writes under its root document's own name, beyond
 * GENERATED_FILE: `main.pdf`, the bibliography and index it generates, and
 * biblatex's `main-blx.bib`. A writer's `main.bib` is a source.
 */
const GENERATED_FOR_DOCUMENT = /^(?:\.(?:pdf|bbl|idx|ind|ist|gl[os]|ac[nr]|alg|loa|thm|nlo|nls|tdo|pytxcode)|-blx\.bib)$/i;

/** Folders a package fills while compiling (minted's cache, the svg package's conversions). */
const GENERATED_FOLDER = /^(?:_minted[^/]*|svg-inkscape)(?:\/|$)/;

/** The temporary `ProjectFs::atomic_write` writes beside a file and renames over it. */
const ATOMIC_WRITE_TEMPORARY = /(?:^|\/)\.lattice-[0-9a-f-]+\.tmp$/i;

/**
 * Whether a change the project watcher reported at `path` cannot have changed
 * what a build compiles: a file a LaTeX run itself writes, the app's own
 * atomic-write temporary, or Git's own state. Anything not known to be one counts as an input, so an unfamiliar
 * package's output costs an extra (quick) latexmk run, never a stale PDF.
 */
export function isBuildOutput(path: string, rootDocuments: readonly string[]): boolean {
  const file = normalizeProjectRelativePath(path);
  if (!file) return false;
  if (
    file === ".git" || file.startsWith(".git/") || GENERATED_FOLDER.test(file) || GENERATED_FILE.test(file)
    || ATOMIC_WRITE_TEMPORARY.test(file)
  ) {
    return true;
  }
  return rootDocuments.some((document) => {
    const stem = normalizeProjectRelativePath(document)?.replace(/\.tex$/i, "") ?? "";
    return stem !== "" && file.startsWith(stem) && GENERATED_FOR_DOCUMENT.test(file.slice(stem.length));
  });
}
