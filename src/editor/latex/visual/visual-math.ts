/**
 * Math as Visual mode draws it: KaTeX's HTML for a formula, cached by its
 * source, its display flag, its equation number and the project macros it
 * was set with, so a formula scrolled past or edited around is set once.
 * KaTeX ships in this chunk only, which loads with Visual mode.
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import { katexSource } from "../math-region";

/** Each macro table's revision: the table is rebuilt as a whole when a definition changes, so its identity is its revision. */
const revisions = new WeakMap<Record<string, string>, number>();
let nextRevision = 1;

/** A number for `macros` that changes whenever the table does, for cache keys and widget equality. */
export function macroRevision(macros: Record<string, string> | undefined): number {
  if (!macros) return 0;
  let revision = revisions.get(macros);
  if (revision === undefined) {
    revision = nextRevision++;
    revisions.set(macros, revision);
  }
  return revision;
}

/** Recently set formulas, newest last. A long thesis has thousands; the window shows a few dozen. */
const cache = new Map<string, string | null>();
const CACHE_LIMIT = 1_500;

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX environment names */
/** Environments whose rows KaTeX sets centered, one under another. */
const GATHERED = new Set(["gather", "gather*", "multline", "multline*"]);
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * The body of a math region as KaTeX should read it: bookkeeping that is not
 * math dropped and rows aligned (`katexSource`), a `gather`'s or
 * `multline`'s rows centered, and `tag` set as its equation number.
 */
export function visualMathSource(body: string, environment: string | null, tag: string | null): string {
  let source = katexSource(body);
  if (environment && GATHERED.has(environment) && source.includes("\\\\") && !source.startsWith("\\begin{aligned}")) {
    source = `\\begin{gathered}${source}\\end{gathered}`;
  }
  return tag === null ? source : `${source}\\tag{${tag}}`;
}

/**
 * KaTeX's HTML for `source` (already through `visualMathSource`), or null
 * when KaTeX cannot set it: the formula then shows as its source.
 */
export function mathHtml(source: string, display: boolean, macros: Record<string, string> | undefined): string | null {
  if (!source.trim()) return null;
  const key = `${macroRevision(macros)}\u0000${display ? 1 : 0}\u0000${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Refresh its place: a formula still on screen is not the one to drop.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let html: string | null;
  try {
    // KaTeX adds a `\gdef` to the macros it is given; the project's stay as they are.
    html = katex.renderToString(source, { displayMode: display, throwOnError: true, strict: "ignore", macros: { ...macros } });
  } catch {
    html = null;
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}
