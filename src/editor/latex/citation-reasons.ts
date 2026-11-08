/**
 * Citation reasons in a file: every citation key's occurrence (each key of
 * each `\cite`), and which occurrence each reason belongs to.
 *
 * A reason is a local annotation whose quote is one key (editor-comment-data.ts
 * `CitationReason`). The same key usually appears more than once, so its
 * quote alone never says which occurrence it means; its context does. Each
 * reason scores every occurrence of its key by how much of the stored text
 * before and after still surrounds it, and the reasons of one key share the
 * occurrences out best match first, so two reasons never land on one cite
 * and a reason whose cite was deleted is left without one (orphaned) rather
 * than moving onto a sibling cite of the same paper.
 */
import {
  createEditorComment, resolveCommentAnchor, type CitationReason, type CitationRole, type EditorComment,
} from "../comments/editor-comment-data";
import { argumentsOf, CITATION, citationNotePage, keySpans } from "./latex-symbols";
import { blankIgnored } from "./latex-visible-source";

/** One key of one citation command: its span, its line and the page its note names (`\cite[p.~5]{key}`). */
export type CitationSite = { key: string; from: number; to: number; line: number; page?: number };

/** How much text a reason keeps on either side of its key, as every annotation does. */
const CONTEXT = 32;

/**
 * The least context, in characters matched on both sides together, that
 * still places a reason. A citation command's own scaffolding (`~\cite{`
 * and `}.`) matches at any occurrence, so a reason must keep more than that:
 * a whole side survives an edit on the other side, and a moved paragraph
 * carries both.
 */
const MIN_SCORE = 16;

/**
 * Every citation key in `source` that TeX reads, in reading order: a cite in
 * a comment or a verbatim-like environment is text, as the manuscript scan
 * (`list_citation_usages`) reads it too.
 */
export function citationSites(source: string): CitationSite[] {
  const sites: CitationSite[] = [];
  const visible = blankIgnored(source);
  let line = 1;
  let counted = 0;
  for (const command of argumentsOf(visible, CITATION)) {
    const options = [...visible.slice(command.start, command.from - 1).matchAll(/\[([^\]]*)\]/g)];
    const page = options.length ? citationNotePage(options.at(-1)![1]) : undefined;
    for (const span of keySpans(command.content, command.from)) {
      for (let at = source.indexOf("\n", counted); at >= 0 && at < span.from; at = source.indexOf("\n", at + 1)) line += 1;
      counted = span.from;
      sites.push({ ...span, line, ...page ? { page } : {} });
    }
  }
  return sites;
}

const sameKey = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

type Anchor = Pick<EditorComment, "from" | "to" | "prefix" | "suffix">;

/**
 * How well `site` matches what `reason` remembers around its key; a site
 * at the reason's own offsets with its own context scores highest.
 */
function score(source: string, site: CitationSite, reason: Anchor): number {
  const prefix = commonSuffix(reason.prefix, source.slice(Math.max(0, site.from - CONTEXT), site.from));
  const suffix = commonPrefix(reason.suffix, source.slice(site.to, site.to + CONTEXT));
  return prefix + suffix + (site.from === reason.from ? 1 : 0);
}

/**
 * The occurrence each of `reasons` on `path` belongs to in `source`, by id;
 * a reason missing from the map is orphaned. `hints` are spans the editor
 * mapped through its own edits: a reason whose hint still covers its key
 * keeps that occurrence before any context is weighed.
 */
export function anchorCitationReasons(
  source: string,
  path: string,
  reasons: readonly EditorComment[],
  hints?: ReadonlyMap<string, { from: number; to: number }>,
): Map<string, CitationSite> {
  const placed = new Map<string, CitationSite>();
  const mine = reasons.filter((reason) => reason.citation && reason.path === path);
  if (!mine.length) return placed;
  const sites = citationSites(source);
  const taken = new Set<CitationSite>();
  const candidates: Array<{ reason: EditorComment; site: CitationSite; score: number }> = [];
  for (const reason of mine) {
    const key = reason.citation!.key;
    const hint = hints?.get(reason.id);
    const held = hint && sites.find((site) => !taken.has(site) && site.from === hint.from && site.to === hint.to && sameKey(site.key, key));
    if (held) {
      placed.set(reason.id, held);
      taken.add(held);
      continue;
    }
    for (const site of sites) {
      if (!sameKey(site.key, key)) continue;
      const value = score(source, site, reason);
      if (value >= MIN_SCORE) candidates.push({ reason, site, score: value });
    }
  }
  // Best match first; an equal score goes to the reason made first, so the
  // outcome never depends on the order the store lists them in.
  candidates.sort((a, b) => b.score - a.score || a.reason.createdAt.localeCompare(b.reason.createdAt));
  for (const { reason, site } of candidates) {
    if (placed.has(reason.id) || taken.has(site)) continue;
    placed.set(reason.id, site);
    taken.add(site);
  }
  return placed;
}

/** The reason's stored anchor moved to `site`, or null when it already says exactly that. */
export function reanchoredReason(source: string, reason: EditorComment, site: CitationSite): Anchor & { quote: string } | null {
  const next = {
    from: site.from,
    to: site.to,
    quote: source.slice(site.from, site.to),
    prefix: source.slice(Math.max(0, site.from - CONTEXT), site.from),
    suffix: source.slice(site.to, site.to + CONTEXT),
  };
  const same = next.from === reason.from && next.to === reason.to && next.quote === reason.quote
    && next.prefix === reason.prefix && next.suffix === reason.suffix;
  return same ? null : next;
}

/** A new reason for the occurrence `site` of `path`. */
export function createCitationReason(options: {
  path: string;
  source: string;
  site: Pick<CitationSite, "from" | "to" | "key">;
  role: CitationRole;
  body: string;
  authorId: string;
  authorName: string;
}): EditorComment | null {
  const comment = createEditorComment({
    path: options.path,
    source: options.source,
    from: options.site.from,
    to: options.site.to,
    body: options.body,
    authorId: options.authorId,
    authorName: options.authorName,
  });
  const citation: CitationReason = { key: options.site.key, role: options.role };
  return comment && { ...comment, citation };
}

/**
 * Where an annotation sits in `source` as the Annotations panel places it:
 * any other annotation by its quote and context, a citation reason nowhere,
 * since the panel lists only the reasons whose cite is gone (or that were
 * resolved there), and its stale context could name some other cite.
 */
export function annotationAnchor(source: string, comment: EditorComment): { from: number; to: number } | null {
  return comment.citation ? null : resolveCommentAnchor(source, comment);
}

/** What the source editor and its citation card need to show and file citation reasons. */
export type CitationReasonData = {
  /** The project's citation reasons, on every file. */
  citationReasons?: readonly EditorComment[];
  /** Who files a new reason. */
  citationReasonAuthor?: { id: string; name: string };
  /** Add a reason, or replace the one with its id. */
  onSaveCitationReason?: (reason: EditorComment) => void;
  onDeleteCitationReason?: (id: string) => void;
  /** Save where reasons now sit, by id, as the editor found them after an edit. */
  onReanchorCitationReasons?: (moves: ReadonlyMap<string, Pick<EditorComment, "from" | "to" | "quote" | "prefix" | "suffix">>) => void;
  /** Open another file at a line, where a citation card's row cites the paper. */
  onOpenCitationUse?: (path: string, line: number) => void;
};

/**
 * The citation reasons the Annotations panel lists: those whose cite is
 * gone from their file (orphaned), and those resolved there. An anchored
 * reason belongs to its citation card, not the panel. `sourceFor` gives a
 * file's text, null for a file that is gone, and undefined while unread.
 */
export function panelCitationReasons(
  reasons: readonly EditorComment[],
  sourceFor: (path: string) => string | null | undefined,
): EditorComment[] {
  const placed = new Map<string, Map<string, CitationSite>>();
  return reasons.filter((reason) => {
    if (reason.resolved) return true;
    const source = sourceFor(reason.path);
    if (source === undefined) return false;
    if (source === null) return true;
    let sites = placed.get(reason.path);
    if (!sites) {
      sites = anchorCitationReasons(source, reason.path, reasons.filter((item) => !item.resolved));
      placed.set(reason.path, sites);
    }
    return !sites.has(reason.id);
  });
}
