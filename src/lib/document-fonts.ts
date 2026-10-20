/**
 * The faces documents are drawn in, loaded before a document opens.
 *
 * A web font loads on its first use, and the app's faces swap in when they
 * arrive (`font-display: swap`), so a document opened before its cuts were
 * in drew its first frames in a fallback and then reflowed into them: a
 * Markdown page's text set in the sans fallback until the reading serif
 * arrived, its headings turning semibold and rewrapping; a LaTeX line
 * rewrapping when the editor's italic or medium cut replaced the fallback's
 * wider one. Opening waits for them instead. They are files of the app's
 * own bundle, so the wait is a few milliseconds and is paid once.
 */

/* eslint-disable lingui/no-unlocalized-strings -- CSS font tokens and shorthands */
/** The cuts each document face is drawn in, per the font token that names it. */
const DOCUMENT_CUTS: ReadonlyArray<readonly [token: string, cuts: readonly string[]]> = [
  // The source editor: text, LaTeX commands (500), Markdown headings and bold (600, 700), comments and arguments.
  ["--editor-font", ["400", "500", "700", "italic 400", "italic 700"]],
  // A rendered Markdown page: text, medium, headings (600), bold, emphasis.
  ["--reading-font", ["400", "500", "600", "700", "italic 400", "italic 600"]],
];
/* eslint-enable lingui/no-unlocalized-strings */

/** How long an open waits for its faces at most: a face that never arrives must not hold the document back. */
const DOCUMENT_FONTS_WAIT_MS = 500;

let loading: Promise<void> | null = null;
let loaded = false;

/** The first family of a font list, as the CSS font shorthand takes it. */
function firstFamily(list: string) {
  return list.split(",")[0]?.trim() ?? "";
}

/**
 * Starts loading every document face (once) and resolves when they are in,
 * or have failed, or after DOCUMENT_FONTS_WAIT_MS, whichever comes first.
 */
export function documentFontsReady(): Promise<void> {
  if (!loading) {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts?.load) {
      loaded = true;
      loading = Promise.resolve();
    } else {
      // Custom properties compute with their var()s substituted, so the
      // private build's faces come first here when it has them.
      const style = getComputedStyle(document.documentElement);
      loading = Promise.all(DOCUMENT_CUTS.flatMap(([token, cuts]) => {
        const family = firstFamily(style.getPropertyValue(token));
        // Latin sample text: a face split by unicode-range loads its Latin part only.
        // eslint-disable-next-line lingui/no-unlocalized-strings -- sample text for font matching
        return family ? cuts.map((cut) => fonts.load(`${cut} 16px ${family}`, "Aa").catch(() => [])) : [];
      })).then(() => { loaded = true; });
    }
  }
  if (loaded) return loading;
  return Promise.race([loading, new Promise<void>((resolve) => window.setTimeout(resolve, DOCUMENT_FONTS_WAIT_MS))]);
}
