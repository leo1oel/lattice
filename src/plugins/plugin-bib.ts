/**
 * The text edits behind a plugin's bibliography actions. Lattice performs
 * them through the app's own bibliography write (`rewriteBibliography`:
 * the open file saved first, the file read as it is on disk now, a write
 * with that base, history and the Overleaf upload) once the writer confirmed
 * what the palette showed.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { applyBibEdit, bibUnreadableReason, readBibDocument } from "../papers/bib-document";

export { appendBibEntry } from "../papers/bib-entry";

/** Entry `key` (any case) as written in `source`, with where it is. */
export function findBibEntry(source: string, key: string): { text: string; from: number; to: number } | null {
  const parse = readBibDocument(source);
  if (!parse.document) throw new Error(bibUnreadableReason(parse.error));
  const wanted = key.toLowerCase();
  const entry = parse.document.entries.find((candidate) => candidate.key.toLowerCase() === wanted);
  return entry ? { text: source.slice(entry.from, entry.to), from: entry.from, to: entry.to } : null;
}

/** `source` with entry `key` replaced by `bibtex`; throws when the entry is gone. */
export function replaceBibEntry(source: string, key: string, bibtex: string): string {
  const entry = findBibEntry(source, key);
  if (!entry) throw new Error(i18n._(msg`There is no entry “${key}” to update any more.`));
  return applyBibEdit(source, { from: entry.from, to: entry.to, insert: bibtex.trim() });
}
