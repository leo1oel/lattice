/** Math set by KaTeX for the editor's cards (a `\ref` hover card, the live math preview); loaded with KaTeX on the first one. */
import katex from "katex";
import "katex/dist/katex.min.css";
import { katexSource } from "./math-region";

/**
 * The math as display math (or inline when `display` is false), or null when
 * KaTeX cannot set it: the `\ref` card then shows its source, the live preview
 * keeps its last good picture.
 */
export function equationHtml(body: string, macros: Record<string, string> = {}, display = true): string | null {
  const source = katexSource(body);
  if (!source) return null;
  try {
    // KaTeX adds a `\gdef` to the macros it is given; the project's stay as they are.
    return katex.renderToString(source, { displayMode: display, throwOnError: true, strict: "ignore", macros: { ...macros } });
  } catch {
    return null;
  }
}
