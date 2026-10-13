/**
 * Reading what a writer typed or pasted to add papers: what kind of
 * reference each piece is, and whether the library already holds it. The
 * backend reads the same kinds (papers/import.rs); this only lets the
 * Papers box and the Add papers sheet say what will happen before it does.
 */
import type { PaperSummary } from "../app-types";
import { baseArxivId, explicitArxivId } from "./arxiv-id";
import { bibTextToPlain, parseBibDocument, summarizeEntry } from "./bib-document";
import { i18n } from "../i18n";
import { paperAuthorNames, paperShortAuthors } from "./paper-identity";

export type ReferenceKind = "arxiv" | "doi" | "url" | "bibtex" | "title";

const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** The kind of reference `input` is, or null for an empty box. */
export function referenceKind(input: string): ReferenceKind | null {
  const value = input.trim();
  if (!value) return null;
  if (/^@\w+\s*\{/.test(value)) return "bibtex";
  if (explicitArxivId(value)) return "arxiv";
  if (DOI.test(value)) return "doi";
  if (/^https?:\/\/\S+$/i.test(value)) return "url";
  return "title";
}

/** What identifies a work, lower-cased; an arXiv DOI (10.48550/arXiv.…) counts as its arXiv id. */
export type WorkIdentity = { arxivId?: string; doi?: string; key?: string; title?: string };

function normalDoi(value: string | undefined): string | undefined {
  const doi = value && DOI.exec(value.trim())?.[1].toLowerCase();
  return doi || undefined;
}

function arxivOfDoi(doi: string | undefined): string | undefined {
  const id = doi && /^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1];
  return id ? explicitArxivId(id) : undefined;
}

/** The identity a typed identifier carries on its own, before any lookup. */
export function identityOfInput(input: string): WorkIdentity {
  const value = input.trim();
  const doi = normalDoi(value);
  return { arxivId: explicitArxivId(value) ?? arxivOfDoi(doi), doi };
}

/** Titles compare by their letters and digits alone, case aside. */
const titleKey = (title: string) => title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The library's paper that is this work, matched by arXiv id, DOI or
 * citation key, and by title only when the title is long enough to name one
 * work (a resolved record's, never a query's).
 */
export function findInLibrary(papers: readonly PaperSummary[], identity: WorkIdentity): PaperSummary | undefined {
  const arxiv = identity.arxivId?.toLowerCase();
  const doi = identity.doi?.toLowerCase();
  const title = identity.title ? titleKey(identity.title) : "";
  return papers.find((paper) => (arxiv && baseArxivId(paper.arxivId).toLowerCase() === arxiv)
    || (doi && paper.doi?.toLowerCase() === doi)
    || (identity.key && paper.citationKey === identity.key))
    ?? (title.length >= 12 ? papers.find((paper) => titleKey(paper.title) === title) : undefined);
}

/** A record as a card shows it: title, "Hewitt and Liang · 2019 · EMNLP", and what identifies it. */
export type ReferenceRecord = {
  title: string;
  byline: string;
  identity: WorkIdentity;
};

export function bylineOf(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(" · ");
}

/** One reference the writer pasted: the text as given, and what it is. */
export type PastedReference = {
  /** Stable for the same text, so a re-read of the box keeps each line's lookup. */
  id: string;
  kind: ReferenceKind;
  /** What the import is given: the line, or the whole BibTeX entry. */
  input: string;
  /** The line as the card shows it (an entry's key for BibTeX). */
  label: string;
  /** Read straight from a pasted BibTeX entry; every other kind is looked up. */
  record?: ReferenceRecord;
};

/**
 * Everything pasted, one reference per line, with each BibTeX entry (a whole
 * .bib, say) taken whole. `%` comments and blank lines are skipped, and a
 * reference pasted twice is read once.
 */
export function parsePastedReferences(text: string): PastedReference[] {
  const found: Array<{ at: number; reference: PastedReference }> = [];
  let rest = text;
  if (/@\w+\s*\{/.test(text)) {
    const parsed = parseBibDocument(text);
    if (parsed.document) {
      const blanked = text.split("");
      for (const entry of parsed.document.entries) {
        const kind = entry.kind.toLowerCase();
        for (let index = entry.from; index < entry.to; index += 1) if (blanked[index] !== "\n") blanked[index] = " ";
        if (kind === "string" || kind === "comment" || kind === "preamble") continue;
        const source = text.slice(entry.from, entry.to);
        const summary = summarizeEntry(text, entry, parsed.document.macros);
        found.push({
          at: entry.from,
          reference: {
            id: `bibtex:${source}`,
            kind: "bibtex",
            input: source,
            label: entry.key,
            record: {
              title: summary.title || entry.key,
              byline: bylineOf([summary.shortAuthors, summary.year, summary.venue]),
              identity: { arxivId: summary.arxivId || arxivOfDoi(summary.doi.toLowerCase()), doi: normalDoi(summary.doi), key: entry.key, title: summary.title },
            },
          },
        });
      }
      rest = blanked.join("");
    }
  }
  let offset = 0;
  for (const line of rest.split("\n")) {
    const value = line.trim();
    const kind = referenceKind(value);
    if (kind && !value.startsWith("%")) found.push({ at: offset, reference: { id: `${kind}:${value}`, kind, input: value, label: value } });
    offset += line.length + 1;
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).map(({ reference }) => reference).filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
}

/** The resolver's record, in the fields a card needs. */
export type ResolvedRecordFields = {
  title: string;
  author: string;
  year: string;
  journal: string;
  booktitle: string;
  publisher: string;
  doi: string;
  url: string;
  key?: string;
};

export function recordOfResolved(resolved: ResolvedRecordFields): ReferenceRecord {
  const venue = recordVenue(resolved);
  const doi = normalDoi(resolved.doi);
  const title = bibTextToPlain(resolved.title);
  return {
    title,
    byline: bylineOf([bibTextToPlain(paperShortAuthors({ authors: resolved.author }) ?? ""), resolved.year, venue]),
    identity: { arxivId: explicitArxivId(resolved.url) ?? arxivOfDoi(doi), doi, title },
  };
}

/** "John Hewitt and Percy Liang": people as a reader names them, not as BibTeX sorts them. */
export function readableAuthors(field: string): string {
  const names = paperAuthorNames({ authors: field }).map(bibTextToPlain).filter(Boolean);
  // Chinese joins with 和 and no spaces; Latin names either side of it get
  // the space a CJK word takes from a Latin one.
  return new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names)
    // eslint-disable-next-line lingui/no-unlocalized-strings -- the list format's own Chinese conjunction, respaced
    .replace(/(?<=[\p{Script=Latin}.])和(?=\p{Script=Latin})/gu, " 和 ");
}

/** The record's venue as printed; empty for a record that names none. */
export function recordVenue(record: Pick<ResolvedRecordFields, "journal" | "booktitle" | "publisher">): string {
  return bibTextToPlain(record.journal || record.booktitle || record.publisher);
}
