/**
 * Page search across the workspace: wiki-link autocomplete in the Markdown
 * editor and media-src autocomplete in the property panel.
 *
 * Clean implementation for Lattice, specified from Lattice's own behavior:
 * `markdown-workspace-index.test.ts`, `workspace-search.test.ts` and the
 * wiki-link suggestion UX.
 *
 * A page ranks first by how its name meets the whole query (exactly, as a
 * prefix, as a folder, anywhere inside), then by BM25+ relevance of the
 * query's words, where each query word stands for every indexed word it
 * begins. Pages inside hidden folders (`.research/…`) count half a name
 * match. Equal scores fall back to path order. Body text is never searched.
 */

export type SearchablePage = { path: string; title: string; content: string };

/**
 * Word characters are ASCII letters and digits, `_`, `'`, `-` and the
 * accented vowels below (read as plain vowels); any other character,
 * including other accented letters, ends a word. Scripts written without
 * spaces are split into words by the platform's dictionary segmenter.
 */
const WORD_BREAK = /[^a-z0-9_'\-àèéìòóù]+/;
const PLAIN_VOWELS: Record<string, string> = { à: "a", è: "e", é: "e", ì: "i", ò: "o", ó: "o", ù: "u" };
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_WORDS = new Intl.Segmenter(undefined, { granularity: "word" });

/** The distinct index words of `text`. */
function termsOf(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(WORD_BREAK).map((word) => word.replace(/[àèéìòóù]/g, (vowel) => PLAIN_VOWELS[vowel]));
  const segmented = [...lower.matchAll(CJK_RUN)].flatMap(([run]) =>
    [...CJK_WORDS.segment(run)].filter((segment) => segment.isWordLike).map((segment) => segment.segment));
  return [...new Set([...words, ...segmented])].filter(Boolean);
}

/** Lower case with single spaces: how whole names are compared with the query. */
function normalizeName(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const EXACT = 7;
const PREFIX = 6;
const FOLDER_PREFIX = 5.5;
const CONTAINS = 5;
const PATH_CONTAINS = 4.5;
const HIDDEN_FACTOR = 0.5;

type PageName = { path: string; names: string[]; folders: string[]; hidden: boolean };

function pageName(page: SearchablePage): PageName {
  const path = normalizeName(page.path);
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  return {
    path,
    names: [normalizeName(page.title), name.replace(/\.[a-z0-9]+$/, ""), name],
    folders: segments.slice(0, -1),
    hidden: isHiddenPath(page.path),
  };
}

/**
 * A path inside a dot-folder is hidden, except for agent skill bundles
 * (`.claude/skills/<name>/…` and the like), which only live in dot-folders
 * because agent harnesses look for them there.
 */
function isHiddenPath(path: string): boolean {
  return !/^\.[^/]+\/skills\/[^/]+\//.test(path) && path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * How the page's name meets the whole query, strongest first; 0 when it
 * does not. A name is the title or the file name, with or without extension.
 */
function nameTier({ names, path, folders }: PageName, query: string): number {
  if (names.includes(query) || path === query) return EXACT;
  if (names.some((name) => name.startsWith(query))) return PREFIX;
  if (folders.some((folder) => folder.startsWith(query))) return FOLDER_PREFIX;
  if (names.some((name) => name.includes(query))) return CONTAINS;
  return path.includes(query) ? PATH_CONTAINS : 0;
}

/** BM25+ saturation, length normalisation and lower bound. */
const K1 = 1.2;
const B = 0.75;
const DELTA = 0.5;

/**
 * Field-weighted BM25+ over a fixed set of pages. Every field keeps its own
 * word statistics; a word's frequency is relative to its field's length.
 */
class FieldIndex {
  private readonly frequency: Map<string, number>[];
  private readonly averageLength: number[];

  constructor(private readonly fields: string[][][], private readonly weights: number[]) {
    this.frequency = weights.map((_, field) => {
      const counts = new Map<string, number>();
      for (const page of fields) for (const term of page[field]) counts.set(term, (counts.get(term) ?? 0) + 1);
      return counts;
    });
    this.averageLength = weights.map((_, field) =>
      fields.reduce((sum, page) => sum + page[field].length, 0) / Math.max(fields.length, 1));
  }

  /** Each query word stands for every indexed word it begins, weighted by that word's rarity. */
  expand(queryTerms: string[]): Map<string, number>[] {
    const count = this.fields.length;
    return this.frequency.map((counts) => {
      const weights = new Map<string, number>();
      for (const [term, pages] of counts) {
        if (queryTerms.some((queryTerm) => term.startsWith(queryTerm))) {
          weights.set(term, Math.log(1 + (count - pages + 0.5) / (pages + 0.5)));
        }
      }
      return weights;
    });
  }

  score(page: number, expansions: Map<string, number>[]): number {
    let score = 0;
    this.fields[page].forEach((terms, field) => {
      const frequency = 1 / terms.length;
      const norm = K1 * (1 - B + (B * terms.length) / Math.max(this.averageLength[field], 1e-9));
      for (const term of terms) {
        const rarity = expansions[field].get(term);
        if (rarity !== undefined) score += (this.weights[field] * rarity * (DELTA + frequency * (K1 + 1))) / (frequency + norm);
      }
    });
    return score;
  }
}

const byPath = (left: { page: SearchablePage }, right: { page: SearchablePage }) =>
  left.page.path.localeCompare(right.page.path);

/** Autocomplete weighs title, full path and file name words 10 : 9 : 9. */
const AUTOCOMPLETE_FIELDS = [10, 9, 9];
const AUTOCOMPLETE_TIER_WEIGHT = 100_000;
/** Pages that match only some query words, or only inside hidden folders, form a short tail. */
const AUTOCOMPLETE_TAIL = 6;

type IndexedPage = { page: SearchablePage; name: PageName; fields: string[][] };

const nameFields = (page: SearchablePage) =>
  [termsOf(page.title), termsOf(page.path), termsOf(page.path.split("/").at(-1) ?? "")];

/** Page autocomplete for wiki links over an incrementally updated set of pages. */
export class PageSearchIndex {
  private pages: IndexedPage[] = [];
  private index = new FieldIndex([], AUTOCOMPLETE_FIELDS);

  /**
   * Replace the indexed pages. A page whose path and title are unchanged
   * keeps its analysis (body text is not searched), so republishing one
   * edited document does not re-tokenize the workspace.
   */
  update(pages: readonly SearchablePage[]): void {
    const previous = new Map(this.pages.map((entry) => [entry.page.path, entry]));
    this.pages = pages.map((page) => {
      const known = previous.get(page.path);
      return known && known.page.title === page.title
        ? { ...known, page }
        : { page, name: pageName(page), fields: nameFields(page) };
    });
    this.index = new FieldIndex(this.pages.map((entry) => entry.fields), AUTOCOMPLETE_FIELDS);
  }

  /**
   * The best `limit` pages for `query`: name matches by strength, each
   * ordered by relevance relative to the best match, then at most six pages
   * that only share words with the query or sit in hidden folders.
   */
  search(query: string, limit: number): SearchablePage[] {
    const name = normalizeName(query);
    if (!name) return [];
    const expansions = this.index.expand(termsOf(query));
    const candidates = this.pages.flatMap((entry, position) => {
      const tier = nameTier(entry.name, name);
      const relevance = this.index.score(position, expansions);
      return tier || relevance > 0 ? [{ page: entry.page, hidden: entry.name.hidden, tier, relevance }] : [];
    });
    const best = Math.max(0, ...candidates.map((candidate) => candidate.relevance));
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      score: candidate.tier * AUTOCOMPLETE_TIER_WEIGHT * (candidate.hidden ? HIDDEN_FACTOR : 1)
        + (best > 0 ? candidate.relevance / best : 0),
    })).sort((left, right) => right.score - left.score || byPath(left, right));
    let tail = 0;
    return ranked
      .filter((candidate) => (candidate.tier > 0 && !candidate.hidden) || tail++ < AUTOCOMPLETE_TAIL)
      .slice(0, limit)
      .map((candidate) => candidate.page);
  }
}
