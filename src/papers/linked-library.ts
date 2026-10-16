/**
 * A linked library: a .bib file a reference manager keeps outside the
 * project (a Zotero or Paperpile export), whose changes come into the
 * project's own .bib only once the writer has seen them.
 *
 * Three texts are compared. The base is the library as it was when its
 * changes were last taken in (src-tauri/src/project/linked_bibliography.rs
 * keeps it); the library is the file now; local is the project's .bib. A
 * field the library changed since the base, which the writer left alone
 * here, is an update. One the writer changed here too is theirs until they
 * choose otherwise. A field only the writer changed is never offered.
 *
 * An entry is the same paper in each text by its citation key, or else by
 * its DOI or arXiv id, or as a last resort by its title and year, and keeps
 * the key it has here: a library that renamed its keys does not break a
 * `\cite` in the paper. Nothing is deleted unless
 * the writer ticks it, and never an entry the paper cites. Every change is a
 * splice into the local text (bib-document.ts), so whatever it does not touch
 * stays byte-for-byte as written. A value naming an `@string` of the library
 * is written out, since the project's .bib may not define it.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import {
  addFieldEdit, applyBibEdit, bibUnreadableReason, changeTypeEdit, deleteEntryEdit, expandBibValue,
  parseBibDocument, removeFieldEdit, replaceValueEdit, selfContainedValue, summarizeEntry,
  type BibDocument, type BibEdit, type BibEntry,
} from "./bib-document";

/** The project's link, as `read_linked_bibliography` returns it. */
export type LinkedBibliography = {
  /** The library file, by its absolute path. */
  source: string;
  /** The project .bib it updates. */
  target: string;
  /** When its changes were last taken in (ms since the epoch). */
  updatedAt: number;
  /** The library's text then. */
  baseline: string;
};

/** The pseudo-field for the entry type, which a published preprint changes (`@misc` → `@inproceedings`). */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a key, never shown (the sheet names it)
export const ENTRY_TYPE_FIELD = "@type";

type FieldChange = {
  /** Lower-cased field name, or ENTRY_TYPE_FIELD. */
  name: string;
  /** The value here, expanded but still LaTeX; null when the field is absent. */
  local: string | null;
  /** The library's value. */
  library: string | null;
  /** The writer changed this field here too (or, before the first update, it differs). */
  conflict: boolean;
};

export type LibraryChangeKind = "new" | "updated" | "conflict" | "removed";

export type LibraryChange = {
  /** Stable within one comparison. */
  id: string;
  kind: LibraryChangeKind;
  /** The key here (for a new entry, the library's). */
  key: string;
  /** The library entry it comes from, by its key there; null for a removed entry. */
  libraryKey: string | null;
  title: string;
  /**
   * What would change, for "updated" and "conflict". An entry with both
   * kinds of field is two changes, so the library's own updates can come in
   * while the writer's fields stay.
   */
  fields: FieldChange[];
  /** A removed entry the paper cites: it cannot be removed here. */
  cited: boolean;
};

type Indexed = {
  document: BibDocument;
  source: string;
  byKey: Map<string, BibEntry>;
  byIdentity: Map<string, BibEntry>;
};

/** Read a .bib, or say why not with `name` in the message. */
function index(source: string, name: string): Indexed {
  const parse = parseBibDocument(source);
  if (!parse.document) {
    const reason = bibUnreadableReason(parse.error);
    throw new Error(i18n._(msg`${name} can't be read. ${reason}`));
  }
  const byKey = new Map<string, BibEntry>();
  const byIdentity = new Map<string, BibEntry>();
  for (const entry of parse.document.entries) {
    if (!byKey.has(entry.key.toLowerCase())) byKey.set(entry.key.toLowerCase(), entry);
    for (const identity of identities(source, entry, parse.document)) {
      if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
    }
  }
  return { document: parse.document, source, byKey, byIdentity };
}

/** Ways to tell the paper apart from its key, most certain first. */
function identities(source: string, entry: BibEntry, document: BibDocument): string[] {
  const { doi, arxivId, title, year } = summarizeEntry(source, entry, document.macros);
  // A book or a paper without either id, whose key a reference manager regenerated.
  const words = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return [
    doi && `doi:${doi.toLowerCase()}`,
    arxivId && `arxiv:${arxivId.replace(/v\d+$/, "")}`,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a key, never shown
    words && `title:${words}|${year}`,
  ].filter(Boolean);
}

/** The same paper in `other`: by key first, then by DOI or arXiv id, then by title and year. */
function find(other: Indexed, from: Indexed, entry: BibEntry): BibEntry | undefined {
  const byKey = other.byKey.get(entry.key.toLowerCase());
  if (byKey) return byKey;
  for (const identity of identities(from.source, entry, from.document)) {
    const match = other.byIdentity.get(identity);
    if (match) return match;
  }
  return undefined;
}

/** The entry's fields by lower-cased name, and its type, with whitespace runs read as one space. */
function fieldsOf(text: Indexed, entry: BibEntry): Map<string, string> {
  const values = new Map<string, string>([[ENTRY_TYPE_FIELD, entry.kind]]);
  for (const field of entry.fields) {
    const name = field.name.toLowerCase();
    if (values.has(name)) continue;
    values.set(name, expandBibValue(text.source.slice(field.valueFrom, field.valueTo), text.document.macros).replace(/\s+/g, " ").trim());
  }
  return values;
}

const titleOf = (text: Indexed, entry: BibEntry) => summarizeEntry(text.source, entry, text.document.macros).title || entry.key;

/** A base that no longer parses (edited by hand) is as good as none. */
function readBase(base: string | null, name: string): Indexed | null {
  if (base === null) return null;
  try {
    return index(base, name);
  } catch {
    return null;
  }
}

/**
 * What taking in the library would change here, entry by entry. `base` is
 * null before the first update: every difference then is the writer's to
 * settle, since nothing says which side made it.
 */
export function compareLibrary({ base, library, local, libraryName, localName, cited }: {
  base: string | null;
  library: string;
  local: string;
  libraryName: string;
  localName: string;
  /** Keys the paper cites, or null when they could not be read: then every removed entry counts as cited. */
  cited: ReadonlySet<string> | null;
}): LibraryChange[] {
  const theirs = index(library, libraryName);
  const ours = index(local, localName);
  const before = readBase(base, libraryName);
  const changes: LibraryChange[] = [];
  const seen = new Set<BibEntry>();
  for (const entry of theirs.document.entries) {
    if (theirs.byKey.get(entry.key.toLowerCase()) !== entry) continue;
    const was = before ? find(before, theirs, entry) : undefined;
    const here = find(ours, theirs, entry) ?? (was && before ? find(ours, before, was) : undefined);
    if (!here) {
      // In the base but gone from here: the writer removed it, or declined it once already.
      if (!was) {
        changes.push({
          id: `new:${entry.key}`, kind: "new", key: entry.key, libraryKey: entry.key, title: titleOf(theirs, entry), fields: [], cited: false,
        });
      }
      continue;
    }
    if (seen.has(here)) continue;
    seen.add(here);
    const now = fieldsOf(theirs, entry);
    const then = was && before ? fieldsOf(before, was) : null;
    const mine = fieldsOf(ours, here);
    const fields: FieldChange[] = [];
    for (const name of new Set([...now.keys(), ...(then?.keys() ?? [])])) {
      const library = now.get(name) ?? null;
      const local = mine.get(name) ?? null;
      if (library === local) continue;
      if (then) {
        const previous = then.get(name) ?? null;
        if (library === previous) continue;
        fields.push({ name, local, library, conflict: local !== previous });
      } else if (library !== null) {
        // Before the first update a field only here is the writer's own; one only in the library is new to the entry.
        fields.push({ name, local, library, conflict: local !== null });
      }
    }
    const updates = fields.filter((field) => !field.conflict);
    const conflicts = fields.filter((field) => field.conflict);
    const title = titleOf(ours, here);
    if (updates.length) {
      changes.push({ id: `entry:${here.key}`, kind: "updated", key: here.key, libraryKey: entry.key, title, fields: updates, cited: false });
    }
    if (conflicts.length) {
      changes.push({ id: `conflict:${here.key}`, kind: "conflict", key: here.key, libraryKey: entry.key, title, fields: conflicts, cited: false });
    }
  }
  if (before) {
    for (const was of before.document.entries) {
      if (find(theirs, before, was)) continue;
      const here = find(ours, before, was);
      if (!here || seen.has(here)) continue;
      seen.add(here);
      changes.push({
        id: `removed:${here.key}`, kind: "removed", key: here.key, libraryKey: null, title: titleOf(ours, here), fields: [],
        cited: !cited || [...cited].some((key) => key.toLowerCase() === here.key.toLowerCase()),
      });
    }
  }
  return changes;
}

/** The library's value for `name`, readable without its `@string` macros. */
function libraryRaw(theirs: Indexed, entry: BibEntry, name: string): string | null {
  const field = entry.fields.find((candidate) => candidate.name.toLowerCase() === name);
  if (!field) return null;
  return selfContainedValue(theirs.source.slice(field.valueFrom, field.valueTo), theirs.document.macros);
}

/** A new entry's text as the library writes it, its values readable without the library's `@string` macros. */
function libraryEntry(theirs: Indexed, entry: BibEntry): string {
  return entry.fields.reduceRight((text, field) => applyBibEdit(text, {
    from: field.valueFrom - entry.from,
    to: field.valueTo - entry.from,
    insert: selfContainedValue(theirs.source.slice(field.valueFrom, field.valueTo), theirs.document.macros),
  }), theirs.source.slice(entry.from, entry.to));
}

/** The splice giving `entry` the library's `name`, or null when neither has it. */
function fieldEdit(text: string, entry: BibEntry, theirs: Indexed, source: BibEntry, name: string): BibEdit | null {
  if (name === ENTRY_TYPE_FIELD) return changeTypeEdit(entry, source.type);
  const field = entry.fields.find((candidate) => candidate.name.toLowerCase() === name);
  const raw = libraryRaw(theirs, source, name);
  if (raw === null) return field ? removeFieldEdit(text, entry, field) : null;
  if (field) return replaceValueEdit(field, raw);
  const written = source.fields.find((candidate) => candidate.name.toLowerCase() === name)?.name ?? name;
  return addFieldEdit(text, entry, written, raw);
}

/** The entry's text with the library's side of `fields`, one splice at a time. */
function updatedEntry(text: string, theirs: Indexed, source: BibEntry, fields: FieldChange[]): string {
  for (const change of fields) {
    const entry = parseBibDocument(text).document?.entries[0];
    if (!entry) return text;
    const edit = fieldEdit(text, entry, theirs, source, change.name);
    if (edit) text = applyBibEdit(text, edit);
  }
  return text;
}

/**
 * The project's .bib with the chosen changes taken in: updated entries keep
 * their keys and place, removed ones go (never one the paper cites), and new
 * ones are added at the end as the library writes them. Each comes from the
 * library entry the comparison matched, by `libraryKey`.
 */
export function applyLibraryChanges(local: string, library: string, chosen: readonly LibraryChange[]): string {
  const theirs = index(library, "library");
  const ours = index(local, "bibliography");
  const edits: BibEdit[] = [];
  const added: string[] = [];
  // An entry's update and its conflict, both ticked, are one splice.
  const updates = new Map<BibEntry, { source: BibEntry; fields: FieldChange[] }>();
  for (const change of chosen) {
    const source = change.libraryKey === null ? undefined : theirs.byKey.get(change.libraryKey.toLowerCase());
    if (change.kind === "new") {
      if (source && !ours.byKey.has(change.key.toLowerCase())) added.push(libraryEntry(theirs, source));
      continue;
    }
    const here = ours.byKey.get(change.key.toLowerCase());
    if (!here) continue;
    if (change.kind === "removed") {
      if (!change.cited) edits.push(deleteEntryEdit(local, here));
      continue;
    }
    if (!source) continue;
    const update = updates.get(here) ?? { source, fields: [] };
    update.fields.push(...change.fields);
    updates.set(here, update);
  }
  for (const [here, { source, fields }] of updates) {
    edits.push({ from: here.from, to: here.to, insert: updatedEntry(local.slice(here.from, here.to), theirs, source, fields) });
  }
  let next = edits.sort((a, b) => b.from - a.from).reduce(applyBibEdit, local);
  for (const entry of added) {
    const trimmed = next.replace(/\s*$/, "");
    next = trimmed ? `${trimmed}\n\n${entry}\n` : `${entry}\n`;
  }
  return next;
}
