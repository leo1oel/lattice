/**
 * What the Project tree refuses to delete, matching `delete_entry` in
 * lattice-core's project/entries.rs. Only the primary bibliography is kept:
 * Add paper and the reference tools write into it. Any .tex may be deleted,
 * the main document included; the host then builds the project's only other
 * full document, or none until the writer chooses one.
 */
export function deletionProtectedPaths(manifest: { primaryBibliography: string } | undefined): string[] {
  const bibliography = manifest?.primaryBibliography ?? "";
  return bibliography ? [bibliography] : [];
}

/** Whether deleting `paths` would remove a protected path, itself or the folder holding it. */
export function deletesProtectedPath(paths: readonly string[], protectedPaths: readonly string[]): boolean {
  return paths.some((path) => protectedPaths.some(
    (protectedPath) => protectedPath === path || protectedPath.startsWith(`${path}/`),
  ));
}
