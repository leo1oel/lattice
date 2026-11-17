/**
 * What tells two open documents with the same file name apart in their tabs:
 * the shortest run of parent folders, the same length across the files that
 * share the name, that differs between every one of them ("chapters" and
 * "appendix" for two `intro.tex`), as VS Code and Zed draw it after the name.
 * A file whose folders run out before that keeps what it has: one at the
 * project's top has no detail, and its siblings' details set it apart.
 *
 * The GPUI app draws the same rule (`tab_details` in
 * `gpui/crates/lattice-gpui/src/shell/tab_names.rs`).
 */
export function tabDetails(paths: Iterable<string>): Map<string, string> {
  const byName = new Map<string, { path: string; parts: string[] }[]>();
  for (const path of new Set(paths)) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.at(-1);
    if (!name) continue;
    const group = byName.get(name);
    if (group) group.push({ path, parts });
    else byName.set(name, [{ path, parts }]);
  }
  const details = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const folders = group.map(({ parts }) => parts.slice(0, -1));
    const deepest = Math.max(...folders.map((dirs) => dirs.length));
    for (let depth = 1; depth <= deepest; depth++) {
      const suffixes = folders.map((dirs) => dirs.slice(-depth).join("/"));
      if (depth < deepest && new Set(suffixes).size < suffixes.length) continue;
      group.forEach(({ path }, index) => {
        if (suffixes[index]) details.set(path, suffixes[index]);
      });
      break;
    }
  }
  return details;
}
