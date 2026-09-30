const AUTHOR_ID_KEY = "lattice.editor-comment-author-id.v1";

export type EditorCommentReply = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type EditorComment = {
  id: string;
  path: string;
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  authorId: string;
  authorName: string;
  resolved: boolean;
  replies: EditorCommentReply[];
  createdAt: string;
  updatedAt: string;
};

type FieldTypes = Record<string, "string" | "number" | "boolean">;
const REPLY_FIELDS: FieldTypes = { id: "string", authorId: "string", authorName: "string", body: "string", createdAt: "string" };
const COMMENT_FIELDS: FieldTypes = {
  ...REPLY_FIELDS,
  path: "string",
  from: "number",
  to: "number",
  quote: "string",
  resolved: "boolean",
  updatedAt: "string",
};

function hasFields<T>(fields: FieldTypes) {
  return (value: unknown): value is T => Boolean(value) && typeof value === "object"
    && Object.entries(fields).every(([key, type]) => typeof (value as Record<string, unknown>)[key] === type);
}
const isEditorComment = hasFields<EditorComment>(COMMENT_FIELDS);
const isEditorCommentReply = hasFields<EditorCommentReply>(REPLY_FIELDS);

const byCreation = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function serializeEditorComments(comments: EditorComment[]): string {
  return `${JSON.stringify({ schemaVersion: 1, comments }, null, 2)}\n`;
}

/** Merge independently saved comment files without dropping either author. */
export function mergeEditorComments(first: EditorComment[], second: EditorComment[]): EditorComment[] {
  const merged = new Map<string, EditorComment>();
  for (const comment of [...first, ...second]) {
    const previous = merged.get(comment.id);
    if (!previous) {
      merged.set(comment.id, comment);
      continue;
    }
    const latest = comment.updatedAt >= previous.updatedAt ? comment : previous;
    const replies = new Map(previous.replies.map((reply) => [reply.id, reply]));
    for (const reply of comment.replies) replies.set(reply.id, reply);
    merged.set(comment.id, { ...latest, replies: [...replies.values()].sort(byCreation) });
  }
  return [...merged.values()].sort(byCreation);
}

/** Null distinguishes a corrupt payload from a legitimately empty list. */
export function tryParseEditorComments(raw: string): EditorComment[] | null {
  let comments: unknown;
  try {
    comments = (JSON.parse(raw) as { comments?: unknown } | null)?.comments;
  } catch {
    return null;
  }
  if (!Array.isArray(comments)) return null;
  return comments.filter(isEditorComment).map((comment) => {
    const replies = Array.isArray(comment.replies) ? comment.replies.filter(isEditorCommentReply) : [];
    return replies === comment.replies ? comment : { ...comment, replies };
  });
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
}): EditorComment | null {
  const from = Math.max(0, Math.min(options.from, options.to));
  const to = Math.min(options.source.length, Math.max(options.from, options.to));
  const quote = options.source.slice(from, to);
  if (to <= from || !quote.trim()) return null;
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    path: options.path.replace(/\\/g, "/"),
    from,
    to,
    quote,
    prefix: options.source.slice(Math.max(0, from - 32), from),
    suffix: options.source.slice(to, to + 32),
    body: options.body.trim(),
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
