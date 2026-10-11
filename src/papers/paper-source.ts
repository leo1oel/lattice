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
    const anchors = title.split(" … ");
    return { page: Number(pageValue), first: anchors.length === 2 ? anchors[0] : "", last: anchors.length === 2 ? anchors[1] : "" };
  } catch {
    return null;
  }
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
