/** Where a link clicked in the visual editor goes: an in-document anchor, a project file, or the web. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { baseArxivId } from "../../papers/arxiv-id";
import { drawnTarget } from "./engine/block-window";

const toSlashes = (path: string) => path.replace(/\\/g, "/");
const directoryParts = (path: string) => toSlashes(path).split("/").slice(0, -1).filter(Boolean);

function decodeProjectLinkSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  // An encoded octet is segment data, not new hierarchy. Refuse decodes that
  // would mint separators, traversal, or a NUL and keep the authored bytes.
  return decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded) ? segment : decoded;
}

function resolveProjectLink(activePath: string, href: string): string | null {
  const rawPath = href.split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  const decoded = toSlashes(rawPath).split("/").map(decodeProjectLinkSegment).join("/");
  const parts = decoded.startsWith("/") ? [] : directoryParts(activePath);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.pop()) return null;
  }
  return parts.join("/") || null;
}

/** A project path written relative to the Markdown file that links to it. */
export function projectAssetMarkdownHref(activePath: string, projectPath: string): string {
  const from = directoryParts(activePath);
  const to = toSlashes(projectPath).split("/").filter(Boolean);
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || ".";
}

function paperArxivIdFromPath(activePath: string): string | null {
  const match = toSlashes(activePath).match(/^\.research\/papers\/(.+)\/paper\.md$/);
  return match && !match[1]!.startsWith("web-") ? match[1]! : null;
}

const ARXIV_HTML_PATH = "/html/";

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The fragment when an arXiv URL points back into the paper already open. */
export function localPaperFragment(activePath: string, href: string): { id: string; fallbackUrl?: string } | null {
  const paperId = paperArxivIdFromPath(activePath);
  let fragment = href;
  let fallbackUrl = paperId ? `https://arxiv.org/html/${paperId}${href}` : undefined;
  if (!href.startsWith("#")) {
    const url = paperId ? attempt(() => new URL(href)) : null;
    if (!url || !/^(?:www\.)?arxiv\.org$/i.test(url.hostname) || !url.pathname.startsWith(ARXIV_HTML_PATH) || !url.hash) return null;
    const linkedId = attempt(() => decodeURIComponent(url.pathname.slice(ARXIV_HTML_PATH.length)));
    if (linkedId === null || baseArxivId(linkedId.toLocaleLowerCase()) !== baseArxivId(paperId!.toLocaleLowerCase())) return null;
    fragment = url.hash;
    fallbackUrl = href;
  }
  const id = fragment === "#" ? null : attempt(() => decodeURIComponent(fragment.slice(1)));
  return id === null ? null : { id, fallbackUrl };
}

function markdownAnchorTarget(editorElement: HTMLElement | undefined, id: string): HTMLElement | null {
  const elements = Array.from(editorElement?.querySelectorAll<HTMLElement>("[id]") ?? []);
  for (let candidate = id; candidate;) {
    const target = elements.find((element) => element.id === candidate);
    if (target) return target;
    // LaTeXML gives subfigures ids such as S7.F10.sf1 while arxiv2md keeps
    // only the parent figure anchor. The parent is the closest honest local
    // destination and avoids sending an otherwise readable paper to the web.
    const separator = candidate.lastIndexOf(".");
    candidate = separator > 0 ? candidate.slice(0, separator) : "";
  }
  return null;
}

export function openMarkdownLink(
  activePath: string,
  href: string,
  onOpenProjectPath?: (path: string) => void,
  editorElement?: HTMLElement,
) {
  const localFragment = localPaperFragment(activePath, href);
  if (localFragment) {
    const target = markdownAnchorTarget(editorElement, localFragment.id);
    if (target) drawnTarget(target).scrollIntoView({ block: "start" });
    else if (localFragment.fallbackUrl) void openUrl(localFragment.fallbackUrl).catch(() => undefined);
    return;
  }
  const path = resolveProjectLink(activePath, href);
  if (path) onOpenProjectPath?.(path);
  else if (/^(?:https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => undefined);
}
