/**
 * Zotero annotations in a paper's note (paper-notes.ts). Each highlight,
 * underline, sticky note or comment the writer made in Zotero's PDF reader
 * becomes a quote or a paragraph of `notes/<citation key>.md`, ending with two
 * links: the page in Lattice's own reader (a source link, paper-source.ts,
 * which opens the paper's PDF there with the passage marked) and the
 * annotation in Zotero (`zotero://open-pdf/…`, opened through the backend's
 * `open_zotero_link`, zotero-link.ts).
 *
 * Bringing them in again adds only the ones the note does not hold yet, found
 * by the annotation key in their Zotero link, so what the writer edited or
 * deleted in the note stays as they left it; nothing is written back to Zotero.
 */
import type { PaperSummary } from "../app-types";
import { escapeRegExp } from "../lib/escape-regexp";
import { updatePaperNote, withPaperNoteEntry } from "./paper-notes";
import { markdownLinkText, paperSourceHref, sourceLinkMarkdown, sourceQuoteAnchors, sourceQuoteMarkdown } from "./paper-source";
import type { ZoteroAnnotation } from "./zotero";

type NotedPaper = Pick<PaperSummary, "arxivId" | "citationKey" | "title" | "hasFullText" | "url" | "hasLocalPdf">;

/** The words the note is written with, in the interface language. */
export type AnnotationLabels = { heading: string; page: (page: string) => string };

/** The annotation in Zotero's PDF reader: its PDF, at its page, with it selected. */
export function zoteroAnnotationHref(annotation: Pick<ZoteroAnnotation, "attachment" | "key" | "page">): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Zotero's URL parameters
  const page = annotation.page ? `page=${annotation.page}&` : "";
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Zotero's URL scheme
  return `zotero://open-pdf/library/items/${encodeURIComponent(annotation.attachment)}?${page}annotation=${encodeURIComponent(annotation.key)}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Zotero's rich-text comment tags: bold and italic become Markdown, a break a new line, the rest only their text. */
const COMMENT_TAG = /^<(\/?)(b|strong|i|em|sub|sup|span|br|p|div)(?:\s[^<>]*)?\/?>$/i;
const EMPHASIS: Record<string, string> = { b: "**", strong: "**", i: "*", em: "*" };

/**
 * A Zotero comment as Markdown: its words escaped (a `$` is not math, a `#`
 * at a line's start not a heading), its bold and italic kept, a blank line
 * between its paragraphs.
 */
export function zoteroCommentMarkdown(comment: string): string {
  let out = "";
  for (const part of comment.split(/(<\/?[a-z]+(?:\s[^<>]*)?\/?>)/i)) {
    const tag = COMMENT_TAG.exec(part);
    if (!tag) {
      out += markdownLinkText(decodeEntities(part));
      continue;
    }
    const name = tag[2].toLowerCase();
    if (EMPHASIS[name]) out += EMPHASIS[name];
    else if (name === "br" || (tag[1] && (name === "p" || name === "div"))) out += "\n";
  }
  return out.split("\n")
    .map((line) => line.trim().replace(/^[#+-]/, "\\$&").replace(/^(\d{1,9})([.)])/, "$1\\$2"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One annotation as the note writes it: a highlight's or underline's passage
 * as a quote, and any comment as a paragraph, the links after them. The
 * reader's link carries the passage's first and last words, so following it
 * marks the passage on the page; the page is named as the PDF prints it.
 */
export function zoteroAnnotationMarkdown(
  paper: Pick<PaperSummary, "arxivId" | "url" | "hasLocalPdf">, annotation: ZoteroAnnotation, labels: AnnotationLabels,
): string {
  const pageName = annotation.pageLabel || (annotation.page ? String(annotation.page) : "");
  const label = pageName ? labels.page(pageName) : "";
  const href = annotation.page ? paperSourceHref(paper, annotation.page) : null;
  const anchors = annotation.text ? sourceQuoteAnchors(annotation.text) : null;
  const reader = href && label
    ? anchors ? sourceLinkMarkdown(label, href, anchors) : `[${markdownLinkText(label)}](${href})`
    : markdownLinkText(label);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the application's name
  const links = [reader, `[Zotero](${zoteroAnnotationHref(annotation)})`].filter(Boolean).join(" · ");
  const comment = zoteroCommentMarkdown(annotation.comment);
  if (annotation.text) {
    const quote = sourceQuoteMarkdown(annotation.text, links);
    return comment ? `${quote}\n\n${comment}` : quote;
  }
  return comment ? `${comment} ${links}` : links;
}

/** Whether `note` holds the annotation `key`: its Zotero link names it. */
function holds(note: string, key: string): boolean {
  return new RegExp(`[?&]annotation=${escapeRegExp(encodeURIComponent(key))}(?![\\w%])`).test(note);
}

/**
 * `paper`'s note with the annotations it does not hold yet added at its end,
 * in Zotero's reading order, below a heading the first time any come in; and
 * how many were added. A note not yet written starts with the paper's title.
 */
export function withZoteroAnnotations(
  current: string | null, paper: NotedPaper, annotations: readonly ZoteroAnnotation[], labels: AnnotationLabels,
): { content: string; added: number } {
  const note = current ?? "";
  const seen = new Set<string>();
  const fresh = annotations.filter((annotation) => {
    if (seen.has(annotation.key) || holds(note, annotation.key)) return false;
    seen.add(annotation.key);
    return true;
  });
  if (!fresh.length) return { content: note, added: 0 };
  const entries = fresh.map((annotation) => zoteroAnnotationMarkdown(paper, annotation, labels)).join("\n\n");
  const first = !/\(zotero:\/\/open-pdf\//i.test(note);
  const entry = first ? `## ${markdownLinkText(labels.heading)}\n\n${entries}` : entries;
  return { content: withPaperNoteEntry(current, paper, entry), added: fresh.length };
}

/**
 * Add `annotations` to `paper`'s note in the project at `projectRoot`, as
 * `withZoteroAnnotations` gives it; a note that holds them all is left alone.
 * Resolves the note's path and how many were added.
 */
export async function addZoteroAnnotations(
  projectRoot: string, paper: NotedPaper, annotations: readonly ZoteroAnnotation[], labels: AnnotationLabels,
): Promise<{ path: string; added: number }> {
  let added = 0;
  const path = await updatePaperNote(projectRoot, paper, (current) => {
    const next = withZoteroAnnotations(current, paper, annotations, labels);
    added = next.added;
    return added ? next.content : null;
  });
  return { path, added };
}
