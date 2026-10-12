const AUTHOR_ID_KEY = "lattice.editor-comment-author-id.v1";

export type EditorCommentReply = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

/**
 * What the writer asks of the agent, when they say: rewrite, shorten,
 * clarify, add a citation, or fix. Stored as these words.
 */
export const ANNOTATION_INTENTS = ["rewrite", "shorten", "clarify", "cite", "fix"] as const;
export type AnnotationIntent = (typeof ANNOTATION_INTENTS)[number];

/** A box on a PDF page, as fractions of the page's width and height from its top left. */
export type PdfRect = { x: number; y: number; width: number; height: number };

/** Where on the compiled PDF an annotation was made, and the text selected there. */
export type PdfAnchor = { page: number; rects: PdfRect[]; text: string };

/**
 * The agent's answer to an annotation in revision round `round`. `proposed`:
 * replace `original` (the quote it was asked about) with `text`, for
 * `reason`; the writer then accepts or rejects it. `asked`: it needs the
 * writer's answer to `question` first; `answer` is kept for the next round.
 * `failed`: the agent could not answer (`error`).
 */
export type AnnotationRevision = {
  round: number;
  state: "proposed" | "accepted" | "rejected" | "asked" | "failed";
  original?: string;
  text?: string;
  reason?: string;
  question?: string;
  answer?: string;
  error?: string;
};

/**
 * A note anchored in the source: a local annotation (`.research/annotations.json`)
 * or, in a project linked to Overleaf, one of its comment threads. Only local
 * annotations carry a number, an intent, a PDF anchor and the agent's revision.
 */
export type EditorComment = {
  id: string;
  /** The annotation's pin, kept for its life; absent (or 0) for an Overleaf thread. */
  number?: number;
  path: string;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  intent?: AnnotationIntent;
  pdf?: PdfAnchor;
  revision?: AnnotationRevision;
  authorId: string;
  authorName: string;
  resolved: boolean;
  replies: EditorCommentReply[];
  createdAt: string;
  updatedAt: string;
};

/**
 * One revision round: when it started and settled, what became of each
 * annotation it asked about (by id, as `AnnotationRevision["state"]`), and
 * its entry in the project history once settled.
 */
export type AnnotationRound = {
  number: number;
  startedAt: string;
  settledAt?: string;
  outcomes: Record<string, AnnotationRevision["state"]>;
  historyId?: string;
};

/**
 * Where an annotation stands, as its card and pin show it: `asked` is the
 * agent waiting on the writer, `rejected` a proposal turned down (the note
 * stays open), `accepted` and `resolved` are done.
 */
export type AnnotationStatus = "open" | "proposed" | "asked" | "accepted" | "rejected" | "failed" | "resolved";

export function annotationStatus(annotation: Pick<EditorComment, "resolved" | "revision">): AnnotationStatus {
  const state = annotation.revision?.state;
  if (state === "accepted") return "accepted";
  if (annotation.resolved) return "resolved";
  return state ?? "open";
}

/** The number the next annotation's pin takes. */
export function nextAnnotationNumber(annotations: readonly Pick<EditorComment, "number">[]): number {
  return annotations.reduce((highest, annotation) => Math.max(highest, annotation.number ?? 0), 0) + 1;
}

export function loadEditorCommentAuthorId(): string {
  try {
    const existing = localStorage.getItem(AUTHOR_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(AUTHOR_ID_KEY, id);
    return id;
  } catch {
    return "anonymous";
  }
}

const [AUTHOR_NAME_KEY, SHARES_AUTHOR_NAME_KEY] = ["lattice.author-name.v1", "lattice.collab.name"];

/**
 * The "Your name" setting. A name typed into the retired Lattice Shares
 * dialog is read until the setting is first saved, so it keeps signing.
 */
export function loadAuthorNameSetting(): string {
  try {
    return localStorage.getItem(AUTHOR_NAME_KEY) ?? localStorage.getItem(SHARES_AUTHOR_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistAuthorNameSetting(name: string): void {
  try {
    localStorage.setItem(AUTHOR_NAME_KEY, name.trim());
  } catch {
    // Storage can be unavailable; the name then lasts for this session.
  }
}

/**
 * The name comments are signed with: the writer's Git
 * `user.name`, else their Overleaf account name, else the "Your name"
 * setting. Empty when none is known (the comment code shows "Anonymous").
 */
export function resolveAuthorName(sources: { git?: string | null; overleaf?: string | null; setting?: string | null }): string {
  return [sources.git, sources.overleaf, sources.setting].map((name) => name?.trim() ?? "").find(Boolean) ?? "";
}

export function editorCommentAuthorDisplayName(authorName: string, anonymousLabel: string): string {
  const trimmed = authorName.trim();
  return !trimmed || trimmed === "Anonymous" ? anonymousLabel : trimmed;
}

type Authored = { body: string; authorId: string; authorName: string };

export function createEditorComment(options: Authored & {
  path: string;
  source: string;
  from: number;
  to: number;
  /** The pin's number; the annotation store gives a new one the next free number. */
  number?: number;
  intent?: AnnotationIntent;
  pdf?: PdfAnchor;
}): EditorComment | null {
  const from = Math.max(0, Math.min(options.from, options.to));
  const to = Math.min(options.source.length, Math.max(options.from, options.to));
  const quote = options.source.slice(from, to);
  if (to <= from || !quote.trim()) return null;
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ...options.number ? { number: options.number } : {},
    path: options.path.replace(/\\/g, "/"),
    from,
    to,
    quote,
    prefix: options.source.slice(Math.max(0, from - 32), from),
    suffix: options.source.slice(to, to + 32),
    body: options.body.trim(),
    ...options.intent ? { intent: options.intent } : {},
    ...options.pdf ? { pdf: options.pdf } : {},
    authorId: options.authorId,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName localizes it
    authorName: options.authorName.trim() || "Anonymous",
    resolved: false,
    replies: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createEditorCommentReply(options: Authored): EditorCommentReply | null {
  const body = options.body.trim();
  if (!body) return null;
  return {
    id: crypto.randomUUID(),
    authorId: options.authorId,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName localizes it
    authorName: options.authorName.trim() || "Anonymous",
    body,
    createdAt: new Date().toISOString(),
  };
}

export function resolveCommentAnchor(
  source: string,
  comment: Pick<EditorComment, "from" | "to" | "quote" | "prefix" | "suffix">,
): { from: number; to: number } | null {
  if (
    comment.from >= 0
    && comment.to <= source.length
    && comment.to > comment.from
    && source.slice(comment.from, comment.to) === comment.quote
  ) {
    return { from: comment.from, to: comment.to };
  }
  if (!comment.quote) return null;

  const needle = `${comment.prefix}${comment.quote}${comment.suffix}`;
  if (comment.prefix || comment.suffix) {
    const contextual = source.indexOf(needle);
    if (contextual >= 0) {
      if (source.indexOf(needle, contextual + 1) >= 0) return null;
      const from = contextual + comment.prefix.length;
      return { from, to: from + comment.quote.length };
    }
  }

  const direct = source.indexOf(comment.quote);
  if (direct < 0) return null;
  // Without matching context, a repeated quote cannot be anchored safely.
  // Guessing the first occurrence could attach a newly submitted comment to
  // unrelated text after the document changed while its composer was open.
  if (source.indexOf(comment.quote, direct + 1) >= 0) return null;
  return { from: direct, to: direct + comment.quote.length };
}
