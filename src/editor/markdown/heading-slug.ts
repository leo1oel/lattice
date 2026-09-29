/**
 * Heading slugs: the fragment a heading answers to (`#results`), shared by the
 * visual editor's heading anchors, wiki links (`[[page#slug]]`) and the paper
 * converter's Contents links (spec R-BLK-13, R-INL-6, R-FMT-18).
 *
 * The text is decomposed (NFKD) and stripped of combining marks, lowercased,
 * every run of characters that are not letters or digits becomes one hyphen,
 * and hyphens at the edges are dropped. A slug seen before in the same
 * document gets `-1`, `-2`, … in document order. This is the rule the paper
 * converter writes Contents links with (`wiki_link_slug` in
 * src-tauri/src/papers/markdown.rs), so the two must change together.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

const LETTER_OR_DIGIT = /[\p{Alphabetic}\p{N}]/u;
const COMBINING_MARK = /\p{M}/gu;

/** The slug of one heading's text, before duplicates are told apart; empty when it has no letters or digits. */
export function headingSlug(text: string): string {
  let slug = "";
  let pendingHyphen = false;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a Unicode normalization form
  for (const char of text.trim().normalize("NFKD").replace(COMBINING_MARK, "")) {
    if (LETTER_OR_DIGIT.test(char)) {
      if (pendingHyphen && slug) slug += "-";
      pendingHyphen = false;
      slug += char.toLowerCase();
    } else {
      pendingHyphen = true;
    }
  }
  return slug;
}

/** Slugs for a document's headings in order: each call gives the next heading's unique slug, or "" for none. */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = headingSlug(text);
    if (!base) return "";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}
