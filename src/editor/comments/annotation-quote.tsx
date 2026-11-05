/**
 * The passage a note quotes, as the PDF reads it rather than as LaTeX source:
 * the text typeset (accents composed, groups and markup commands dropped, a
 * citation as its key in brackets) and inline math as text, with roots,
 * fractions, Greek letters and real sub- and superscripts. KaTeX would set
 * the math exactly, but its chunk is not worth loading for a line of quote.
 */
import type { ReactNode } from "react";
import { bibTextToPlain } from "../../papers/bib-document";

const INLINE_MATH = /\$([^$]+)\$|\\\(([\s\S]+?)\\\)/g;
const REFERENCE = /\\(?:cite[pt]?|ref|eqref|autoref|cref|Cref)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;
/** A sub- or superscript: braced, a command, or one character. */
const SCRIPT = /([_^])(?:\{([^{}]*)\}|(\\[A-Za-z]+|[^\s\\{}]))/g;

/** Typeset text, keeping the edges' spaces (which bibTextToPlain trims) so it runs on around a formula. */
const plain = (text: string) => {
  const set = bibTextToPlain(text);
  return set ? `${/^\s/.test(text) ? " " : ""}${set}${/\s$/.test(text) ? " " : ""}` : /\s/.test(text) ? " " : "";
};

/** One formula as text: √ and / for roots and fractions, then each script set as one. */
function math(source: string, key: number): ReactNode {
  let body = source;
  // Innermost first, so a root of a fraction (or the reverse) resolves too.
  for (let before = ""; before !== body;) {
    before = body;
    body = body
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, inner: string) => (/^\w(?:_\{?\w+\}?)?$/.test(inner) ? `√${inner}` : `√(${inner})`))
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
  }
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of body.matchAll(SCRIPT)) {
    parts.push(plain(body.slice(at, match.index)));
    const Script = match[1] === "_" ? "sub" : "sup";
    parts.push(<Script key={match.index}>{plain(match[2] ?? match[3] ?? "")}</Script>);
    at = match.index + match[0].length;
  }
  parts.push(plain(body.slice(at)));
  return <span key={key} className="annotation-card-math">{parts}</span>;
}

export function AnnotationQuote({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    parts.push(plain(text.slice(at, match.index).replace(REFERENCE, "[$1]")));
    parts.push(math(match[1] ?? match[2] ?? "", match.index));
    at = match.index + match[0].length;
  }
  parts.push(plain(text.slice(at).replace(REFERENCE, "[$1]")));
  return <>{parts}</>;
}
