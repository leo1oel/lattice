/** A labelled equation set by KaTeX for its `\ref` hover card; loaded with KaTeX on the first such card. */
import katex from "katex";
import "katex/dist/katex.min.css";
import { katexSource } from "./math-region";

/** The equation as display math, or null when KaTeX cannot set it (the card then shows its source). */
export function equationHtml(body: string, macros: Record<string, string> = {}): string | null {
  const source = katexSource(body);
  if (!source) return null;
  try {
    // KaTeX adds a `\gdef` to the macros it is given; the project's stay as they are.
    return katex.renderToString(source, { displayMode: true, throwOnError: true, strict: "ignore", macros: { ...macros } });
  } catch {
    return null;
  }
}
