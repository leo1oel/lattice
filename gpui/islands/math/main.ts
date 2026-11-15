/**
 * The math island: KaTeX setting one formula at a time for the GPUI app's
 * editor cards (a `\ref` card's equation), which draw the picture the host
 * takes of it (`gpui/crates/lattice-gpui/src/structured/card_math.rs`).
 *
 * The page is never shown. The host loads it into a windowless WKWebView,
 * calls `latticeMath.render` and snapshots the box it returns, so the card
 * shows exactly what the Tauri app's card shows: the same KaTeX, CSS and
 * fonts, through the same `equationHtml` (`src/editor/latex/equation-card.ts`,
 * which strips `\label`s and sets an `align` body as `aligned`) with the
 * project's macros read by the same `katexMacrosFromSources`.
 *
 * Host to page (`callAsyncJavaScript`):
 *   latticeMath.ready()                                → true once KaTeX's fonts are in
 *   latticeMath.setSources(sources)                    the project's TeX sources, for its macros
 *   latticeMath.render({ tex, display, size, color })  → { x, y, width, height } | null
 * `size` is the card's text size in CSS pixels (KaTeX sets itself at 1.21em
 * of it, as in the card), `color` its ink as a CSS colour; null when KaTeX
 * cannot set the math, where the card keeps its source.
 */
import { equationHtml } from "@/editor/latex/equation-card";
import { katexMacrosFromSources } from "@/editor/latex/latex-text";

type Box = { x: number; y: number; width: number; height: number };

let macros: Record<string, string> = {};

// Every face KaTeX may use, loaded before the first picture: a face is only
// fetched once text needs it, so a snapshot taken right after setting an
// integral would catch it before its glyph arrived.
const fontsLoaded = (async () => {
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
  await document.fonts.ready;
  return true;
})();

const math = document.getElementById("math")!;

declare global {
  interface Window {
    latticeMath: {
      ready(): Promise<boolean>;
      setSources(sources: string[]): void;
      render(request: { tex: string; display: boolean; size: number; color: string }): Promise<Box | null>;
    };
  }
}

window.latticeMath = {
  ready: () => fontsLoaded,
  setSources(sources) {
    macros = katexMacrosFromSources(sources);
  },
  async render({ tex, display, size, color }) {
    await fontsLoaded;
    const html = equationHtml(tex, macros, display);
    if (!html) return null;
    math.style.fontSize = `${size}px`;
    math.style.color = color;
    math.innerHTML = html;
    // A face a formula needs that the preload missed (none should) is in before the box is read.
    await document.fonts.ready;
    const box = math.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  },
};
