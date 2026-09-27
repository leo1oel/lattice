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

/** Bibliography fields are untrusted; only open web URLs, never local/OS schemes. */
export function citationSourceUrl(citation?: { url?: string; doi?: string; arxivId?: string }): string | null {
  if (!citation) return null;
  const url = webUrl(citation.url);
  if (url && !hasCredentials(url)) return url.href;
  // Otherwise fall back to the DOI or arXiv identity.
  if (citation.doi && /^10\.\d{4,9}\/\S+$/i.test(citation.doi)) {
    return `https://doi.org/${citation.doi.split("/").map(encodeURIComponent).join("/")}`;
  }
  return paperPdfUrl({ arxivId: citation.arxivId ?? "" });
}

function alphaxivId(url: URL): string | null {
  if (!/^https?:$/.test(url.protocol) || !/^(www\.)?alphaxiv\.org$/i.test(url.hostname)) return null;
  return /^\/(?:abs|pdf|overview)\/([\w.-]+(?:\/\d+(?:v\d+)?)?)(?:\/)?$/.exec(url.pathname)?.[1]
    ?.replace(/\.(?:pdf|md)$/i, "") ?? null;
}

/** A source PDF is independent of the URL used to cite the work. */
export function paperPdfUrl(paper: PaperIdentity): string | null {
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(paper.arxivId)) {
    return `https://arxiv.org/pdf/${paper.arxivId.split("/").map(encodeURIComponent).join("/")}`;
  }
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
