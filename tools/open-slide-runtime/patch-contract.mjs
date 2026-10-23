// The checks every Lattice patch of Open Slide's editor source relies on.

/** The file a Vite module id names, without its query and with forward slashes. */
export function moduleFilePath(id) {
  return id.split("?", 1)[0].replaceAll("\\", "/");
}

/**
 * Every Lattice patch edits upstream source it expects verbatim. When an
 * @open-slide/core upgrade moves any of it, fail loudly instead of shipping a
 * half-patched editor.
 */
export function requireContract(source, fragments, contract) {
  if (!fragments.every((fragment) => source.includes(fragment))) {
    throw new Error(`Open Slide's ${contract} contract changed`);
  }
}

export function replaceRequired(source, before, after, contract) {
  requireContract(source, [before], contract);
  return source.replace(before, after);
}
