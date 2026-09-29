/**
 * The headings of a Markdown page, read line by line as the workspace index
 * needs them (spec R-INL-6): ATX headings (`#` to `######`) outside fenced
 * code, each with the slug a link to it uses, repeats told apart in document
 * order. Frontmatter is the caller's to skip.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { createHeadingSlugger } from "./heading-slug";

export type HeadingEntry = { level: number; text: string; slug: string };

/** An opening or closing code fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** An ATX heading: up to three spaces, one to six `#`, then a space or the line's end. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** A closing sequence of `#` after a space, which is not part of the heading's text. */
const CLOSING = /(?:^|[ \t]+)#+[ \t]*$/;

/**
 * A tracker fed a page's lines in order: true for a fence line and every line
 * inside a fence. A backtick fence's info string may not contain a backtick;
 * a fence closes on the same character, at least as long, with nothing after.
 */
function fenceTracker(): (line: string) => boolean {
  let open: { char: string; length: number } | null = null;
  return (line) => {
    const match = FENCE.exec(line.replace(/\r$/, ""));
    if (!open) {
      if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return false;
      open = { char: match[1]![0]!, length: match[1]!.length };
      return true;
    }
    if (match && match[1]![0] === open.char && match[1]!.length >= open.length && !match[2]!.trim()) open = null;
    return true;
  };
}

/** Every heading of `lines` in order, with its slug. */
export function scanHeadings(lines: readonly string[]): HeadingEntry[] {
  const inFence = fenceTracker();
  const slug = createHeadingSlugger();
  const headings: HeadingEntry[] = [];
  for (const line of lines) {
    if (inFence(line)) continue;
    const match = ATX.exec(line.replace(/\r$/, ""));
    if (!match) continue;
    const text = (match[2] ?? "").replace(CLOSING, "").trim();
    headings.push({ level: match[1]!.length, text, slug: slug(text) });
  }
  return headings;
}
