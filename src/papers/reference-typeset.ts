import { msg } from "@lingui/core/macro";
import type { InlineEdit } from "../components/ui/inline-edits";
import { i18n } from "../i18n";
import { bibTextToPlain, entryValues, parseBibDocument } from "./bib-document";
import { paperAuthorNames } from "./paper-identity";

/**
 * Check references' findings drawn as the reader meets them: a reference as
 * it prints, with a proposed fix marked in place (struck and inserted words,
 * through `InlineEdits`), and two versions of a field with only the words
 * that differ marked.
 */

export type FieldChange = { field: string; before: string; after: string };

/** A printed reference and the edits that turn it into the verified one. */
export type TypesetFix = {
  text: string;
  edits: InlineEdit[];
  /** Changed fields a printed reference does not show (entry type, DOI, publisher). */
  unprinted: string[];
};

type Piece = "author" | "title" | "venue" | "volume" | "pages" | "year";
const PIECES: readonly Piece[] = ["author", "title", "venue", "volume", "pages", "year"];
const VENUE_FIELDS = ["journal", "journaltitle", "booktitle", "howpublished"];
const pieceOf = (field: string): Piece | null => {
  const name = field.toLowerCase();
  if (VENUE_FIELDS.includes(name) || name === "venue") return "venue";
  return (PIECES as readonly string[]).includes(name) ? name as Piece : null;
};

/** Every person's name, read as printed: "Alec Radford, Jong Wook Kim et al.", the first three unless `all`. */
function printedAuthors(raw: string, all: boolean): string {
  const people = paperAuthorNames({ authors: raw }).map(bibTextToPlain);
  const others = /\band\s+others\s*$/i.test(raw);
  if (!people.length) return "";
  const names = (all ? people : people.slice(0, 3)).join(", ");
  return others || names.length < people.join(", ").length ? i18n._(msg`${names} et al.`) : names;
}

/** One record's printed pieces, each with the punctuation that follows it. */
function printedPieces(bibtex: string, allAuthors: boolean): Record<Piece, string> {
  const parsed = parseBibDocument(bibtex);
  const entry = parsed.document?.entries[0];
  const values = entry ? entryValues(bibtex, entry, parsed.document!.macros) : new Map<string, string>();
  const plain = (name: string) => bibTextToPlain(values.get(name) ?? "");
  const eprint = plain("eprint");
  const preprint = eprint && /arxiv/i.test(`${plain("archiveprefix")} ${plain("eprinttype")}`) ? `arXiv:${eprint}` : "";
  const venue = VENUE_FIELDS.map(plain).find(Boolean) ?? preprint;
  const volume = plain("volume");
  const pages = plain("pages");
  const pieces: Record<Piece, string> = {
    author: printedAuthors(values.get("author") ?? values.get("editor") ?? "", allAuthors),
    title: plain("title"),
    venue,
    volume: volume && i18n._(msg`vol. ${volume}`),
    pages: pages && i18n._(msg`pp. ${pages}`),
    year: plain("year") || (values.get("date") ?? "").slice(0, 4),
  };
  for (const piece of PIECES) {
    if (!pieces[piece]) continue;
    // "et al." and a title ending in "?" already close their sentence.
    const closed = /[.?!]$/.test(pieces[piece]);
    pieces[piece] += piece === "year" ? "." : piece === "author" || piece === "title" ? (closed ? " " : ". ") : ", ";
  }
  return pieces;
}

/**
 * The reference `before` as it prints, each run of pieces the verified
 * `after` prints differently one edit, tagged with the fields it changes. A
 * run is whole pieces, so the marks fall on whole words.
 */
export function typesetBibFix(before: string, after: string, changes: readonly FieldChange[], label: (field: string) => string): TypesetFix {
  const changed = new Set(changes.map((change) => pieceOf(change.field)));
  const old = printedPieces(before, changed.has("author"));
  const next = printedPieces(after, changed.has("author"));
  const tagsOf = (pieces: Piece[]) => {
    const fields = changes.filter((change) => pieces.includes(pieceOf(change.field)!)).map((change) => label(change.field).toLocaleLowerCase(i18n.locale));
    return [...new Set(fields.length ? fields : pieces.map((piece) => label(piece).toLocaleLowerCase(i18n.locale)))].join(", ");
  };
  let text = "";
  const edits: InlineEdit[] = [];
  let run: { from: number; old: string; next: string; pieces: Piece[] } | null = null;
  const close = () => {
    if (!run) return;
    edits.push({ id: edits.length, from: run.from, to: run.from + run.old.length, insert: run.next, status: "applied", tag: tagsOf(run.pieces) });
    text += run.old;
    run = null;
  };
  for (const piece of PIECES) {
    if (old[piece] === next[piece]) {
      close();
      text += old[piece];
      continue;
    }
    run ??= { from: text.length, old: "", next: "", pieces: [] };
    run.old += old[piece];
    run.next += next[piece];
    run.pieces.push(piece);
  }
  close();
  const unprinted = changes.filter((change) => !pieceOf(change.field)).map((change) => label(change.field));
  // A reference without a year ends on its last piece's comma and space.
  const printed = text.trimEnd();
  return { text: printed, edits: edits.map((edit) => ({ ...edit, to: Math.min(edit.to, printed.length) })), unprinted };
}

/** Where `needle` first appears in `text`, exactly or ignoring case. */
function locate(text: string, needle: string): number {
  if (!needle) return -1;
  const exact = text.indexOf(needle);
  return exact >= 0 ? exact : text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

/**
 * A `\bibitem` as written, as it prints, each difference from the verified
 * record marked where the item states it. A difference the item does not
 * state word for word (an abbreviated author list) is listed instead.
 */
export function typesetInlineFix(written: string, changes: readonly FieldChange[], label: (field: string) => string): TypesetFix {
  const text = bibTextToPlain(written);
  const edits: InlineEdit[] = [];
  const unprinted: string[] = [];
  for (const change of changes) {
    const before = bibTextToPlain(change.before);
    const at = locate(text, before);
    const clash = edits.some((edit) => at < edit.to && at + before.length > edit.from);
    if (at < 0 || clash) {
      unprinted.push(label(change.field));
      continue;
    }
    edits.push({ id: edits.length, from: at, to: at + before.length, insert: bibTextToPlain(change.after), status: "applied", tag: label(change.field).toLocaleLowerCase(i18n.locale) });
  }
  return { text, edits, unprinted };
}

const escapeLatex = (text: string) => text.replace(/([&%#_])/g, "\\$1");

/**
 * The `\bibitem` with the verified record's corrections. When the item states
 * every differing field word for word, only those words change and the rest
 * stays as the writer wrote it; otherwise the item is written afresh from the
 * verified record.
 */
export function correctedBibitem(key: string, written: string, record: string, changes: readonly FieldChange[]): string {
  const places = changes.map((change) => ({ change, at: change.before ? written.indexOf(change.before) : -1 }));
  if (places.every(({ at }) => at >= 0)) {
    let body = written;
    for (const { change, at } of [...places].sort((left, right) => right.at - left.at)) {
      body = body.slice(0, at) + escapeLatex(change.after) + body.slice(at + change.before.length);
    }
    return `\\bibitem{${key}} ${body}`;
  }
  const parsed = parseBibDocument(record);
  const entry = parsed.document?.entries[0];
  const values = entry ? entryValues(record, entry, parsed.document!.macros) : new Map<string, string>();
  const authors = paperAuthorNames({ authors: values.get("author") ?? "" }).join(", ");
  const venue = VENUE_FIELDS.map((name) => values.get(name) ?? "").find(Boolean);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX written into the document, not interface copy
  const details = [venue && `\\emph{${venue}}`, values.get("volume") && `vol.~${values.get("volume")}`, values.get("pages") && `pp.~${values.get("pages")}`, values.get("year")].filter(Boolean).join(", ");
  return [`\\bibitem{${key}}`, `${authors}.`, `\\newblock ${values.get("title") ?? ""}.`, details && `\\newblock ${details}.`].filter(Boolean).join("\n");
}

/** The words of `ours` and `theirs`, each marked where only that side has it (a longest common run of words is shared). */
export function wordDifference(ours: string, theirs: string): { ours: { word: string; differs: boolean }[]; theirs: { word: string; differs: boolean }[] } {
  const a = ours.split(/(\s+)/).filter(Boolean);
  const b = theirs.split(/(\s+)/).filter(Boolean);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const left: { word: string; differs: boolean }[] = [];
  const right: { word: string; differs: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ word: a[i]!, differs: false });
      right.push({ word: b[j]!, differs: false });
      i += 1; j += 1;
    } else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      left.push({ word: a[i]!, differs: !!a[i]!.trim() });
      i += 1;
    } else {
      right.push({ word: b[j]!, differs: !!b[j]!.trim() });
      j += 1;
    }
  }
  return { ours: left, theirs: right };
}
