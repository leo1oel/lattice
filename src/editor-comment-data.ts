export const EDITOR_COMMENTS_PATH = ".research/editor-comments.json";
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

export type EditorCommentsFile = {
  schemaVersion: number;
  comments: EditorComment[];
};

export function emptyEditorCommentsFile(): EditorCommentsFile {
  return { schemaVersion: 1, comments: [] };
}

export function serializeEditorComments(comments: EditorComment[]): string {
  return `${JSON.stringify({ schemaVersion: 1, comments }, null, 2)}\n`;
}

/** Merge independently saved comment files without dropping either author. */
export function mergeEditorComments(
  first: EditorComment[],
  second: EditorComment[],
): EditorComment[] {
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
    merged.set(comment.id, {
      ...latest,
      replies: [...replies.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    });
  }
  return [...merged.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function tryParseEditorComments(raw: string): EditorComment[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const comments = (parsed as Partial<EditorCommentsFile>).comments;
  if (!Array.isArray(comments)) return null;
  return comments.filter(isEditorComment).map(normalizeComment);
}

export function parseEditorComments(raw: string): EditorComment[] {
  return tryParseEditorComments(raw) ?? [];
}

function normalizeComment(comment: EditorComment): EditorComment {
  const replies = Array.isArray(comment.replies)
    ? comment.replies.filter(isEditorCommentReply)
    : [];
  return replies === comment.replies ? comment : { ...comment, replies };
}

function isEditorCommentReply(value: unknown): value is EditorCommentReply {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EditorCommentReply>;
  return Boolean(
    typeof item.id === "string"
    && typeof item.authorId === "string"
    && typeof item.authorName === "string"
    && typeof item.body === "string"
    && typeof item.createdAt === "string",
  );
}

function isEditorComment(value: unknown): value is EditorComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EditorComment>;
  return Boolean(
    typeof item.id === "string"
    && typeof item.path === "string"
    && typeof item.from === "number"
    && typeof item.to === "number"
    && typeof item.quote === "string"
    && typeof item.body === "string"
    && typeof item.authorId === "string"
    && typeof item.authorName === "string"
    && typeof item.resolved === "boolean"
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string",
  );
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

export function editorCommentAuthorDisplayName(
  authorName: string,
  anonymousLabel: string,
): string {
  const trimmed = authorName.trim();
  return !trimmed || trimmed === "Anonymous" ? anonymousLabel : trimmed;
}

export function createEditorComment(options: {
  path: string;
  source: string;
  from: number;
  to: number;
  body: string;
  authorId: string;
  authorName: string;
}): EditorComment | null {
  const from = Math.max(0, Math.min(options.from, options.to));
  const to = Math.min(options.source.length, Math.max(options.from, options.to));
  if (to <= from) return null;
  const quote = options.source.slice(from, to);
  if (!quote.trim()) return null;
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    path: options.path.replace(/\\/g, "/"),
    from,
    to,
    quote,
    prefix: options.source.slice(Math.max(0, from - 32), from),
    suffix: options.source.slice(to, Math.min(options.source.length, to + 32)),
    body: options.body.trim(),
    authorId: options.authorId,
    authorName: options.authorName.trim() || "Anonymous",
    resolved: false,
    replies: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createEditorCommentReply(options: {
  body: string;
  authorId: string;
  authorName: string;
}): EditorCommentReply | null {
  const body = options.body.trim();
  if (!body) return null;
  return {
    id: crypto.randomUUID(),
    authorId: options.authorId,
    authorName: options.authorName.trim() || "Anonymous",
    body,
    createdAt: new Date().toISOString(),
  };
}

export function resolveCommentRange(
  source: string,
  comment: EditorComment,
): { from: number; to: number } | null {
  return resolveCommentAnchor(source, comment);
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
