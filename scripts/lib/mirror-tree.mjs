/**
 * Mirrors a checkout's files into a fixed directory for `scripts/gpui-build.mjs`,
 * so every checkout's GPUI build compiles from the same absolute paths.
 *
 * Cargo decides what to rebuild from mtimes, so the copy must never make a
 * changed file look old: a file whose content differs is rewritten (it gets
 * the current time), and a file whose content is the same is left alone (its
 * outputs stay fresh). Copying mtimes along, as `cp -p` or `rsync -t` would,
 * is wrong here: a file from a checkout made before the last build would keep
 * an mtime older than that build's outputs, and Cargo would keep the stale
 * crate.
 *
 * Only the files the source lists are written, and a file the previous sync
 * wrote that the source no longer lists is deleted, so what is not the
 * checkout's (target/, the fetched PDFium) stays in the mirror untouched. The
 * list of files written is kept in `manifest`, outside the tree.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Makes `dest` hold `files` (paths relative to `source`) as `source` has them.
 * A listed file missing from `source` (deleted, not yet committed) counts as
 * not listed. Returns how many files were written and deleted.
 */
export function mirrorTree(source, dest, files, manifest) {
  const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
  const present = [];
  for (const file of files) {
    let stat;
    try {
      stat = lstatSync(path.join(source, file));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // A submodule's gitlink is listed as a directory; it is not a file to copy.
    if (!stat.isDirectory()) present.push({ file, stat });
  }
  const kept = new Set(present.map(({ file }) => file));

  // Until this sync completes, the manifest names what either sync may have
  // written, so an interrupted one never strands a file the next cannot delete.
  writeFileSync(manifest, JSON.stringify([...new Set([...previous, ...kept])]));

  // Deletions first, so a file that became a directory is gone before the
  // directory's files are written under its name.
  let deleted = 0;
  for (const file of previous) {
    if (kept.has(file)) continue;
    const target = path.join(dest, file);
    if (!existsSync(target) && !isLink(target)) continue;
    rmSync(target, { recursive: true, force: true });
    deleted += 1;
    removeEmptyParents(path.dirname(target), dest);
  }
  let written = 0;
  for (const { file, stat } of present) {
    if (copyIfChanged(path.join(source, file), path.join(dest, file), stat)) written += 1;
  }
  writeFileSync(manifest, JSON.stringify([...kept]));
  return { written, deleted };
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyIfChanged(from, to, stat) {
  let existing;
  try {
    existing = lstatSync(to);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (stat.isSymbolicLink()) {
    const link = readlinkSync(from);
    if (existing?.isSymbolicLink() && readlinkSync(to) === link) return false;
    if (existing) rmSync(to, { recursive: true, force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(link, to);
    return true;
  }

  const mode = stat.mode & 0o777;
  if (existing?.isFile() && existing.size === stat.size && readFileSync(to).equals(readFileSync(from))) {
    // Same content: keep the mtime, so Cargo keeps what it built from it. A
    // mode change (a script made executable) does not touch the mtime.
    if ((existing.mode & 0o777) !== mode) chmodSync(to, mode);
    return false;
  }
  if (existing && !existing.isFile()) rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  // Through a temporary name, so the file is never seen half written.
  const temporary = `${to}.mirror-tmp`;
  writeFileSync(temporary, readFileSync(from), { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, to);
  return true;
}

function removeEmptyParents(dir, root) {
  while (dir.startsWith(root + path.sep)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
