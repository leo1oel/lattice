/**
 * The title block `\maketitle` prints, read from the document's `\title` and
 * `\author` (in the preamble, or in the body before `\maketitle`), as their
 * LaTeX: the title block sets it as rich text (visual-inline.ts), with the
 * preamble's own macros expanded, its line breaks, spacing and font switches.
 */
import type { Text } from "@codemirror/state";
import { blankIgnored, groupEnd, skipSpace } from "../latex-visible-source";

/** The title's LaTeX, and each author block's (`\and` separates them). */
export type FrontMatter = { title: string; authors: string[] };

/** How far into the document the title and authors are looked for. */
const FRONT_MATTER_REACH = 60_000;

/** The argument of each `\name` in `text` (an optional `[…]` skipped), comments and definitions excluded. */
function argumentsOf(text: string, visible: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`\\\\${name}(?![A-Za-z@])`, "g");
  for (let match = pattern.exec(visible); match; match = pattern.exec(visible)) {
    let at = skipSpace(visible, match.index + match[0].length);
    at = skipSpace(visible, groupEnd(visible, at, "[", "]") ?? at);
    const end = groupEnd(visible, at);
    if (end != null) found.push(text.slice(at + 1, end - 1));
  }
  return found;
}

/** The document's title block, read up to `before` (where `\maketitle` is); null without a title or authors. */
export function frontMatter(doc: Text, before: number): FrontMatter | null {
  const text = doc.sliceString(0, Math.min(before, FRONT_MATTER_REACH));
  // Typing anywhere redraws the window; the front matter it reads rarely changed.
  if (last?.text === text) return last.front;
  const front = readFrontMatter(text);
  last = { text, front };
  return front;
}

let last: { text: string; front: FrontMatter | null } | null = null;

function readFrontMatter(text: string): FrontMatter | null {
  const visible = blankIgnored(text);
  const title = argumentsOf(text, visible, "title").at(-1)?.trim() ?? "";
  const authors = argumentsOf(text, visible, "author")
    .flatMap((argument) => argument.split(/\\and(?![A-Za-z@])/))
    .filter((block) => block.replace(/%[^\n]*/g, "").trim());
  return title || authors.length ? { title, authors } : null;
}
