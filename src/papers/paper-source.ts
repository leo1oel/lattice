import type { PaperSummary } from "../app-types";
import { explicitArxivId } from "./arxiv-id";

type PaperIdentity = Pick<PaperSummary, "arxivId" | "url">;

/** An http(s) URL, or null for anything unparseable or on another scheme. */
function webUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value ?? "");
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const hasCredentials = (url: URL) => Boolean(url.username || url.password);

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;
const arxivPath = (id: string) => id.split("/").map(encodeURIComponent).join("/");

function doiUrl(doi: string | undefined): string | null {
  return doi && /^10\.\d{4,9}\/\S+$/i.test(doi) ? `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}` : null;
}

/** Bibliography fields are untrusted; only open web URLs, never local/OS schemes. */
export function citationSourceUrl(citation?: { url?: string; doi?: string; arxivId?: string }): string | null {
  if (!citation) return null;
  const url = webUrl(citation.url);
  if (url && !hasCredentials(url)) return url.href;
  // Otherwise fall back to the DOI or arXiv identity.
  return doiUrl(citation.doi) ?? paperPdfUrl({ arxivId: citation.arxivId ?? "" });
}

/**
 * Where a paper lives on the web, for reading it there instead of in Lattice:
 * its DOI's resolver (the version of record), else its arXiv abstract page,
 * else the web page it was cited or captured from. A captured page's bundle
 * key is not an arXiv id. Null when nothing records a web address.
 */
export function paperLinkUrl(paper: Pick<PaperSummary, "arxivId" | "doi" | "url">): string | null {
  const doi = doiUrl(paper.doi?.trim());
  if (doi) return doi;
  const id = paper.arxivId.trim();
  if (ARXIV_ID.test(id)) return `https://arxiv.org/abs/${arxivPath(id)}`;
  const url = webUrl(paper.url);
  return url && !hasCredentials(url) ? url.href : null;
}

function alphaxivId(url: URL): string | null {
  if (!/^https?:$/.test(url.protocol) || !/^(www\.)?alphaxiv\.org$/i.test(url.hostname)) return null;
  return /^\/(?:abs|pdf|overview)\/([\w.-]+(?:\/\d+(?:v\d+)?)?)(?:\/)?$/.exec(url.pathname)?.[1]
    ?.replace(/\.(?:pdf|md)$/i, "") ?? null;
}

/** A source PDF is independent of the URL used to cite the work. */
export function paperPdfUrl(paper: PaperIdentity): string | null {
  if (ARXIV_ID.test(paper.arxivId)) return `https://arxiv.org/pdf/${arxivPath(paper.arxivId)}`;
  const url = webUrl(paper.url);
  if (!url || hasCredentials(url)) return null;
  const id = alphaxivId(url);
  if (id) return `https://www.alphaxiv.org/abs/${id}.pdf`;
  return /\.pdf$/i.test(url.pathname) ? url.href : null;
}

export type PaperSourceCitation = { page: number; first: string; last: string };

/**
 * Between a quote's first and last words in a source link's title. The
 * alphaXiv overview writes its links this way, and links copied from the
 * reader follow it so either kind opens the same way.
 */
const QUOTE_ANCHOR_SEPARATOR = " … ";

/** Only intercept references to this paper, never another work's PDF link. */
export function paperSourceCitation(paper: PaperIdentity, href: string, title: string): PaperSourceCitation | null {
  try {
    const url = new URL(href);
    const pageValue = new URLSearchParams(url.hash.slice(1)).get("page") ?? "";
    if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue))) return null;
    const source = paperPdfUrl(paper);
    const linkedAlpha = alphaxivId(url)?.replace(/v\d+$/, "");
    const currentAlpha = paper.url ? alphaxivId(new URL(paper.url))?.replace(/v\d+$/, "") : null;
    const sameAlpha = linkedAlpha && (linkedAlpha === currentAlpha || linkedAlpha === explicitArxivId(paper.arxivId));
    url.hash = "";
    if (!sameAlpha && (!source || url.href !== source.split("#")[0])) return null;
    // Existing cached overviews store the two quote anchors in a portable
    // Markdown link title. Ambiguous titles still navigate to the page.
    const anchors = title.split(QUOTE_ANCHOR_SEPARATOR);
    return { page: Number(pageValue), first: anchors.length === 2 ? anchors[0] : "", last: anchors.length === 2 ? anchors[1] : "" };
  } catch {
    return null;
  }
}

/**
 * The library paper a source link points into, and where: the first paper
 * whose own PDF the link names. Only papers Lattice can read are candidates,
 * so a link to any other work stays a web link.
 */
export function findPaperSource<Paper extends PaperIdentity & Pick<PaperSummary, "hasFullText" | "hasBlog">>(
  papers: readonly Paper[], href: string, title: string,
): { paper: Paper; citation: PaperSourceCitation } | null {
  // Every source link carries a page, so most links are rejected before any paper is compared.
  if (!/#(?:.*&)?page=/.test(href)) return null;
  for (const paper of papers) {
    if (!paper.hasFullText && !paper.hasBlog) continue;
    const citation = paperSourceCitation(paper, href, title);
    if (citation) return { paper, citation };
  }
  return null;
}

/** `paper`'s own PDF at `page`, the link the overview writes; null when the paper has no PDF. */
export function paperSourceHref(paper: PaperIdentity, page: number): string | null {
  const source = paperPdfUrl(paper);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a PDF open parameter
  return source ? `${source.split("#")[0]}#page=${page}` : null;
}

/** Word-by-word for spaced scripts, character-by-character for unspaced ones such as Chinese. */
function quoteUnits(quote: string): { units: string[]; joiner: string } {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  // Two or three long "words" are unspaced text, where a word is a whole clause.
  return words.length < 4 && quote.length > 24
    ? { units: Array.from(quote.trim().replace(/\s+/g, " ")), joiner: "" }
    : { units: words, joiner: " " };
}

/**
 * The first and last words of `quote` that name it: the fewest (from four
 * words, or ten characters of unspaced text) for which `unique` says the
 * pair finds exactly this passage, else the whole quote. Without `unique`,
 * the shortest pair. Null for an empty quote.
 */
export function sourceQuoteAnchors(
  quote: string, unique: (first: string, last: string) => boolean = () => true,
): { first: string; last: string } | null {
  const { units, joiner } = quoteUnits(quote);
  if (!units.length) return null;
  const pair = (count: number) => ({
    first: units.slice(0, count).join(joiner),
    last: units.slice(Math.max(0, units.length - count)).join(joiner),
  });
  const steps = joiner ? [4, 6, 9, 14] : [10, 16, 24, 40];
  for (const count of steps) {
    if (count * 2 >= units.length) break;
    const anchors = pair(count);
    if (unique(anchors.first, anchors.last)) return anchors;
  }
  // The whole quote as both anchors: findSourceQuote lets them overlap.
  return pair(units.length);
}

/** Backslash-escape what Markdown would read as syntax inside link text (or a heading or quote). */
export const markdownLinkText = (text: string) => text.replace(/[\\`*_~$[\]<>]/g, "\\$&");

/**
 * A source link as Markdown: `label` linking to `href`, with the quote's
 * anchors as its title (what `paperSourceCitation` reads back).
 */
export function sourceLinkMarkdown(label: string, href: string, anchors: { first: string; last: string }): string {
  const title = `${anchors.first}${QUOTE_ANCHOR_SEPARATOR}${anchors.last}`.replace(/["\\]/g, "\\$&");
  // A destination with spaces or parentheses needs CommonMark's angle brackets.
  const destination = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
  return `[${markdownLinkText(label)}](${destination} "${title}")`;
}

/** A quote for a Markdown note: one line, its syntax escaped, as a block quote ending with its source link. */
export function sourceQuoteMarkdown(quote: string, link: string): string {
  // A leading `#`, `-`, `+` or `1.` would make a heading or list item of the quote.
  const text = markdownLinkText(quote.trim().replace(/\s+/g, " "))
    .replace(/^[#+-]/, "\\$&").replace(/^(\d{1,9})([.)])/, "$1\\$2");
  return `> ${text} ${link}`;
}

export function isTitleQuery(input: string): boolean {
  const query = input.trim();
  return Boolean(query) && !explicitArxivId(query)
    && !/^(?:https?:\/\/|(?:doi:\s*)?10\.\d{4,9}\/|arxiv:|@)/i.test(query);
}

/** DOI metadata identifies a work, not a downloadable full-text page. */
export function canDownloadPaper(paper: PaperSummary): boolean {
  if (paper.arxivId) return true;
  const url = webUrl(paper.url);
  if (!url || /^(?:dx\.)?doi\.org$/i.test(url.hostname)) return false;
  return /\.pdf$/i.test(url.pathname) || !paper.doi;
}
