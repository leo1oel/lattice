export type BibEntryType = "article" | "inproceedings" | "book" | "misc";

export type BibEntryDraft = {
  type: BibEntryType;
  key: string;
  title: string;
  author: string;
  year: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  url?: string;
  doi?: string;
  note?: string;
};

export const BIB_ENTRY_TYPES: { value: BibEntryType; label: string }[] = [
  { value: "article", label: "Article" },
  { value: "inproceedings", label: "In proceedings" },
  { value: "book", label: "Book" },
  { value: "misc", label: "Misc" },
];

function escapeBibValue(value: string): string {
  return value.replace(/[{}]/g, "");
}

export function slugifyCitationKey(title: string, author: string, year: string): string {
  const last = (author.split(/ and /i)[0] ?? author)
    .split(",")[0]
    ?.trim()
    .split(/\s+/)
    .pop()
    ?? "key";
  const word = (title.match(/[A-Za-z0-9]+/g) ?? ["work"])[0] ?? "work";
  const yearPart = (year.match(/\d{4}/) ?? ["0000"])[0];
  return `${last.toLowerCase().replace(/[^a-z0-9]+/g, "")}${yearPart}${word.toLowerCase()}`;
}

export function formatBibEntry(draft: BibEntryDraft): string {
  const key = draft.key.trim() || slugifyCitationKey(draft.title, draft.author, draft.year);
  const fields: [string, string][] = [
    ["title", draft.title],
    ["author", draft.author],
    ["year", draft.year],
  ];
  if (draft.type === "article" && draft.journal?.trim()) fields.push(["journal", draft.journal]);
  if (draft.type === "inproceedings" && draft.booktitle?.trim()) fields.push(["booktitle", draft.booktitle]);
  if (draft.type === "book" && draft.publisher?.trim()) fields.push(["publisher", draft.publisher]);
  if (draft.url?.trim()) fields.push(["url", draft.url]);
  if (draft.doi?.trim()) fields.push(["doi", draft.doi.trim()]);
  if (draft.note?.trim()) fields.push(["note", draft.note]);
  const body = fields
    .filter(([, value]) => value.trim())
    .map(([name, value]) => `  ${name} = {${escapeBibValue(value.trim())}}`)
    .join(",\n");
  return `@${draft.type}{${key},\n${body}\n}\n`;
}

export function appendBibEntry(existing: string, entry: string): string {
  const trimmed = existing.replace(/\s*$/, "");
  if (!trimmed) return entry.endsWith("\n") ? entry : `${entry}\n`;
  return `${trimmed}\n\n${entry.endsWith("\n") ? entry : `${entry}\n`}`;
}
