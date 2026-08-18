import type { PaperSummary } from "../app-types";

/**
 * Project-root-relative path of the markdown a paper opens with. Mirrors the
 * view choice in the Papers list and the agent paper library: full text when
 * cached, otherwise the alphaXiv overview.
 */
export function paperReadingPath(
  paper: Pick<PaperSummary, "arxivId" | "hasFullText">,
): string {
  return `.research/papers/${paper.arxivId}/${paper.hasFullText ? "paper" : "blog"}.md`;
}

/**
 * Href for a paper link authored inside `activePath`. Relative to the note's
 * directory (not root-absolute) so the link stays a plain markdown link any
 * other tool can resolve; `resolveProjectLink` normalizes it back to a
 * project-root path on click.
 */
export function paperLinkHref(
  activePath: string,
  paper: Pick<PaperSummary, "arxivId" | "hasFullText">,
): string {
  const depth = activePath.replace(/\\/g, "/").split("/").filter(Boolean).length - 1;
  return "../".repeat(Math.max(0, depth)) + paperReadingPath(paper);
}

/**
 * Cached paper bundles under `.research/papers/`. These stay local: shares
 * send the bibliography, and each collaborator fetches full text on demand.
 * A root-level `paper.md` is an ordinary project file, not a library path.
 */
export function isPaperLibraryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".research/papers" || normalized.startsWith(".research/papers/");
}

/**
 * Recognize a resolved project path that points into a paper's cached
 * markdown, so link clicks can route to the Papers reading view instead of a
 * plain editor tab. Papers live under `.research`, which the file tree
 * excludes — treating these paths as ordinary files loses the reader.
 */
export function parsePaperLinkPath(
  path: string,
): { arxivId: string; view: "fulltext" | "blog" } | null {
  const match = /^\.research\/papers\/([^/]+)\/(paper|blog)\.md$/.exec(path);
  if (!match) return null;
  return { arxivId: match[1], view: match[2] === "paper" ? "fulltext" : "blog" };
}
