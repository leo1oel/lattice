/**
 * What kind of change a reference check proposes, which decides whether
 * "Apply N fixes" may take it without the writer reading it:
 *
 * - "published": the entry becomes its published version or gains fields it
 *   left blank (a preprint's venue, DOI, pages). Nothing the writer typed is
 *   overwritten except preprint markers (`howpublished = {arXiv preprint …}`,
 *   an arXiv link, the preprint's year).
 * - "cosmetic": the same words, braced or cased differently (`{ARC}`,
 *   `{N}orth {A}merican`).
 * - "disputed": a value the entry states is replaced by a different one (a
 *   publisher, a venue, a page range). Both may be right, so it waits for the
 *   writer.
 */
export type FixGroup = "published" | "cosmetic" | "disputed";

type Change = { field: string; before: string; after: string };

/** Entry types a preprint or unpublished record is filed under. */
const PREPRINT_TYPES = new Set(["misc", "unpublished", "online", "techreport", "preprint", "report"]);

const words = (value: string) => value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
const isPreprintVenue = (value: string) => /arxiv|corr\b|preprint|biorxiv|medrxiv/i.test(value);
const isArxivLink = (value: string) => /arxiv\.org\/|doi\.org\/10\.48550\//i.test(value);

/** Whether `changes` move a preprint to its publication rather than edit a published record. */
function becomesPublished(changes: readonly Change[]): boolean {
  return changes.some(({ field, before, after }) =>
    (field === "ENTRYTYPE" && PREPRINT_TYPES.has(before.toLowerCase()) && !PREPRINT_TYPES.has(after.toLowerCase()))
    || (["howpublished", "journal", "booktitle"].includes(field) && isPreprintVenue(before) && !isPreprintVenue(after)));
}

export function fixGroup(changes: readonly Change[]): FixGroup {
  const published = becomesPublished(changes);
  let cosmetic = true;
  for (const { field, before, after } of changes) {
    if (field !== "ENTRYTYPE" && before && words(before) === words(after)) continue;
    cosmetic = false;
    const filled = !before.trim();
    const preprintDropped = isPreprintVenue(before) && (!after.trim() || !isPreprintVenue(after));
    const linkPublished = field === "url" && isArxivLink(before) && !isArxivLink(after);
    // A preprint's type and year are the arXiv record's, not the writer's call.
    const upgraded = published && (field === "ENTRYTYPE" || field === "year");
    if (!(filled || preprintDropped || linkPublished || upgraded)) return "disputed";
  }
  return cosmetic ? "cosmetic" : "published";
}
