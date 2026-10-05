import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const touched = (text) => [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);

/**
 * REF's text of each file a PDF.js patch touches, by its path in the package,
 * where it differs from the installed package: copies of the installed files,
 * with the installed patch (`currentPatch`, its text) taken off and REF's
 * (`refPatch`) put on.
 *
 * `git apply` outside a repository applies to the working directory, but one
 * whose working directory is inside a repository (a TMPDIR in this checkout)
 * patches only paths under it, relative to the repository's root: it skips
 * every file and still exits 0, and "before" would silently be this
 * checkout's PDF.js. GIT_CEILING_DIRECTORIES stops it finding one, and each
 * step is checked to have changed every file its patch touches.
 */
export function patchedAt(installed, currentPatch, refPatch, tmpRoot = os.tmpdir()) {
  const work = realpathSync(mkdtempSync(path.join(tmpRoot, "lattice-pdf-window-pdfjs-")));
  try {
    const files = [...new Set([...touched(currentPatch), ...touched(refPatch)])];
    const tree = path.join(work, "package");
    for (const file of files) {
      mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      cpSync(path.join(installed, file), path.join(tree, file));
    }
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: work };
    const apply = (name, text, args) => {
      const patch = path.join(work, name);
      writeFileSync(patch, text);
      const was = new Map(touched(text).map((file) => [file, readFileSync(path.join(tree, file), "utf8")]));
      execFileSync("git", ["apply", ...args, patch], { cwd: tree, env, stdio: ["ignore", "ignore", "pipe"] });
      const unchanged = [...was].filter(([file, text]) => readFileSync(path.join(tree, file), "utf8") === text).map(([file]) => file);
      if (unchanged.length) throw new Error(`git apply ${[...args, name].join(" ")} left ${unchanged.join(", ")} unchanged`);
    };
    apply("current.patch", currentPatch, ["-R"]);
    apply("ref.patch", refPatch, []);
    const pdfjs = new Map();
    // Type declarations never reach the page.
    for (const file of files.filter((name) => !name.endsWith(".d.ts"))) {
      const text = readFileSync(path.join(tree, file), "utf8");
      if (text !== readFileSync(path.join(installed, file), "utf8")) pdfjs.set(file, text);
    }
    return pdfjs;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
