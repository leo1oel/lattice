/* eslint-disable lingui/no-unlocalized-strings -- SVG sprite markup and file names only. */
import type { FileTreeIconConfig, RemappedIcon } from "@pierre/trees";
import { FILE_GLYPH_EXTENSIONS, FILE_GLYPHS, fileGlyphMarkup, type FileGlyphKind } from "../components/ui/file-glyphs";

// The coloured glyph family (file-glyphs.ts) as the tree's sprite, so a file's
// row, its tab and its picker entry carry one icon. Folders have no slot in
// Pierre; project-tree-css.ts draws theirs.
const GLYPH_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">${
  (Object.keys(FILE_GLYPHS) as FileGlyphKind[]).map((kind) => (
    `<symbol id="lattice-glyph-${kind}" viewBox="0 0 24 24">${fileGlyphMarkup(kind)}</symbol>`
  )).join("")
}</svg>`;

const glyph = (kind: FileGlyphKind): RemappedIcon => ({ name: `lattice-glyph-${kind}`, viewBox: "0 0 24 24" });

export const PROJECT_FILE_TREE_ICONS: FileTreeIconConfig = {
  // No built-in set: a file no rule names falls to the remapped file slot, the
  // plain page, instead of Pierre's own monochrome icons.
  set: "none",
  spriteSheet: GLYPH_SPRITE,
  remap: { "file-tree-icon-file": glyph("text") },
  byFileName: { "index.tsx": glyph("slides") },
  byFileExtension: Object.fromEntries(
    FILE_GLYPH_EXTENSIONS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, glyph(kind)])),
  ),
};
