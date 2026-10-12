/* eslint-disable lingui/no-unlocalized-strings -- SVG path data, file extensions and CSS only. */
/**
 * One coloured glyph per kind of file, shared by the Project tree (as a sprite,
 * `project-file-icons.ts`), the workspace tabs and the pickers (`file-glyph.tsx`),
 * so a file shows the same icon wherever it appears.
 *
 * What you write is a page (the page with its fold, plus a mark inside); what
 * you collect or insert is an object (a book, an image, a board, a sheet, a
 * deck). Each kind strokes in its own hue, `--file-glyph-<kind>`, and fills its
 * body with `--file-glyph-tint` of it; every hue clears 3:1 on the sheet, the
 * lift and a selected row in both themes (theme.css).
 * Shapes adapted from Lucide (ISC), on its 24-unit grid.
 */
export type FileGlyphKind =
  | "tex" | "style" | "bib" | "markdown" | "pdf" | "image" | "board" | "sheet" | "slides" | "code" | "config" | "text";

type Glyph = {
  /** Filled with the tint, under the strokes. */
  body: string[];
  /** Stroked in the hue. */
  marks: string[];
  /** Stroked circles: cx, cy, r. */
  dots?: [number, number, number][];
};

const PAGE = "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z";
const FOLD = "M14 2v5a1 1 0 0 0 1 1h5";
const TILE = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const BOOK = "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20";
const TRIANGLE = "M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z";
const SQUARE = "M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z";
const page = (...marks: string[]): Glyph => ({ body: [PAGE], marks: [PAGE, FOLD, ...marks] });

export const FILE_GLYPHS: Record<FileGlyphKind, Glyph> = {
  tex: page("M9 12.5h6", "M12 12.5v5.5"),
  style: page("M8 13h8", "M10 12v2", "M8 17h8", "M14 16v2"),
  markdown: page("M10 9H8", "M16 13H8", "M16 17H8"),
  pdf: page("M8 13.5h8", "M8 17h5"),
  code: page("M10 12.5 8 15l2 2.5", "m14 12.5 2 2.5-2 2.5"),
  config: page(
    "M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1",
    "M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1",
  ),
  text: page(),
  bib: { body: [BOOK], marks: [BOOK, "M10 2v8l3-3 3 3V2"] },
  image: { body: [TILE], marks: [TILE, "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"], dots: [[9, 9, 2]] },
  board: { body: [TRIANGLE, SQUARE], marks: [TRIANGLE, SQUARE], dots: [[17.5, 17.5, 3.5]] },
  sheet: { body: [TILE], marks: ["M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"] },
  slides: { body: ["M3 3h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"], marks: ["M2 3h20", "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3", "m7 21 5-5 5 5"] },
};

/** Each kind's hue, spelled out so the token contract can see every name. */
const HUES: Record<FileGlyphKind, string> = {
  tex: "var(--file-glyph-tex)",
  style: "var(--file-glyph-style)",
  bib: "var(--file-glyph-bib)",
  markdown: "var(--file-glyph-markdown)",
  pdf: "var(--file-glyph-pdf)",
  image: "var(--file-glyph-image)",
  board: "var(--file-glyph-board)",
  sheet: "var(--file-glyph-sheet)",
  slides: "var(--file-glyph-slides)",
  code: "var(--file-glyph-code)",
  config: "var(--file-glyph-config)",
  text: "var(--file-glyph-text)",
};

/**
 * Extensions by kind, without the leading dot. A slide deck has no extension of
 * its own: it is a deck's `index.tsx`, which the callers recognise by path.
 */
export const FILE_GLYPH_EXTENSIONS: [FileGlyphKind, string[]][] = [
  ["tex", ["tex", "ltx", "latex", "tikz", "aux", "synctex", "synctex.gz", "dtx", "ins"]],
  ["style", ["sty", "sty.txt", "cls", "clo", "bst", "bbx", "cbx", "lbx"]],
  ["bib", ["bib", "bbl", "bcf", "blg"]],
  ["markdown", ["md", "markdown", "mdx"]],
  ["pdf", ["pdf"]],
  ["image", ["png", "jpg", "jpeg", "gif", "svg", "eps", "webp", "tif", "tiff"]],
  ["board", ["tldr"]],
  ["sheet", ["lattice-sheet", "csv", "tsv", "xlsx"]],
  ["code", ["html", "htm", "js", "mjs", "ts", "tsx", "jsx", "py", "r", "jl", "sh", "css"]],
  ["config", ["json", "toml", "yaml", "yml", "ini", "cfg", "xml", "lock"]],
];

const KIND_BY_EXTENSION = new Map(
  FILE_GLYPH_EXTENSIONS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind] as const)),
);

/**
 * A file's glyph kind by its extension, the longest first (`synctex.gz` before
 * `gz`), as the tree's icon resolver matches them.
 */
export function fileGlyphKind(name: string): FileGlyphKind {
  const segments = (name.split("/").at(-1) ?? name).toLocaleLowerCase("en-US").split(".");
  for (let index = 1; index < segments.length; index += 1) {
    const kind = KIND_BY_EXTENSION.get(segments.slice(index).join("."));
    if (kind) return kind;
  }
  return "text";
}

/** The glyph's parts with their paint, for the sprite string and the React element alike. */
export function fileGlyphParts(kind: FileGlyphKind) {
  const glyph = FILE_GLYPHS[kind];
  const hue = HUES[kind];
  const tint = { fill: `color-mix(in srgb, ${hue} var(--file-glyph-tint), transparent)`, stroke: "none" };
  const line = {
    fill: "none", stroke: hue, strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round",
  } as const;
  return {
    paths: [...glyph.body.map((d) => ({ d, paint: tint })), ...glyph.marks.map((d) => ({ d, paint: line }))],
    circles: (glyph.dots ?? []).map(([cx, cy, r]) => ({ cx, cy, r, paint: line })),
  };
}

const css = (paint: Record<string, string | number>) =>
  Object.entries(paint).map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`).join(";");

/**
 * The glyph as SVG markup for a `<symbol>`. The paint is inline style rather
 * than a class, so it applies inside the tree's shadow root, where the hues
 * still inherit from the document.
 */
export function fileGlyphMarkup(kind: FileGlyphKind): string {
  const { paths, circles } = fileGlyphParts(kind);
  return [
    ...paths.map(({ d, paint }) => `<path d="${d}" style="${css(paint)}"/>`),
    ...circles.map(({ cx, cy, r, paint }) => `<circle cx="${cx}" cy="${cy}" r="${r}" style="${css(paint)}"/>`),
  ].join("");
}
