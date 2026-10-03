import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import type { PaperSummary } from "../app-types";
import { paperPdfUrl } from "./paper-source";

/**
 * How a Paper names itself wherever it is listed or read: its authors as
 * people write them, and where it came from. Only what the bibliography or
 * bundle actually records — a missing field yields nothing, never a guess.
 */

type Author = { name: string; surname: string };

/** BibTeX braces protect case and grouping; neither belongs on screen. */
const unbrace = (value: string) => value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

/** "{Gemini Team}": one outer brace group protects the whole name as a unit. */
function isOneBraceGroup(value: string): boolean {
  if (!value.startsWith("{")) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") depth -= 1;
    if (depth === 0) return index === value.length - 1;
  }
  return false;
}

/**
 * A BibTeX author list as people: "Vaswani, Ashish and Shazeer, Noam" reads
 * "Ashish Vaswani", "Noam Shazeer". A trailing "and others" is kept as a flag.
 */
function parseAuthors(authors: string | undefined): { people: Author[]; others: boolean } {
  const parts = (authors ?? "").split(/\s+and\s+/i).map((part) => part.trim()).filter((part) => unbrace(part));
  const others = unbrace(parts.at(-1) ?? "").toLocaleLowerCase() === "others";
  const people = (others ? parts.slice(0, -1) : parts).map((raw) => {
    const part = unbrace(raw);
    if (isOneBraceGroup(raw)) return { name: part, surname: part };
    // "von Last, Jr, First" and "Last, First": the surname leads; a plain
    // "First Last" (or a single CJK name) ends with it.
    const [last, ...rest] = part.split(",").map((piece) => piece.trim()).filter(Boolean);
    if (rest.length) return { name: `${rest.at(-1)} ${last}`, surname: last };
    return { name: part, surname: part.split(" ").at(-1) ?? part };
  });
  return { people, others };
}

/** Every author's name in reading order; empty when the entry has none. */
export function paperAuthorNames(paper: Pick<PaperSummary, "authors">): string[] {
  return parseAuthors(paper.authors).people.map((author) => author.name);
}

/** "Vaswani", "Vaswani and Shazeer" or "Vaswani et al."; null without authors. */
export function paperShortAuthors(paper: Pick<PaperSummary, "authors">): string | null {
  const { people, others } = parseAuthors(paper.authors);
  const [first, second] = people.map((author) => author.surname);
  if (!first) return null;
  if (people.length > 2 || others) return i18n._(msg`${first} et al.`);
  return second ? i18n._(msg`${first} and ${second}`) : first;
}

/**
 * Where the reading came from: the arXiv id (with its version), else the DOI,
 * else the cited page's site. A captured webpage's bundle key is not an arXiv
 * id and is never shown as one. Null when nothing records a source.
 */
export function paperSourceLabel(paper: Pick<PaperSummary, "arxivId" | "doi" | "url">): string | null {
  const id = paper.arxivId.trim();
  if (id && paperPdfUrl({ arxivId: id })) return `arXiv ${id}`;
  if (paper.doi) return `DOI ${paper.doi}`;
  try {
    const url = new URL(paper.url ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return url.hostname.replace(/^www\./i, "") || null;
  } catch {
    // An unparseable cited URL names no site.
  }
  return null;
}
