import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { peerColorForKey } from "./collab-colors";

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

type CommentDecorationState = {
  comments: EditorComment[];
  decorations: DecorationSet;
};

export function emptyEditorCommentsFile(): EditorCommentsFile {
  return { schemaVersion: 1, comments: [] };
}

export function serializeEditorComments(comments: EditorComment[]): string {
  return `${JSON.stringify({ schemaVersion: 1, comments }, null, 2)}\n`;
}

/**
 * Parse a comments payload, returning `null` when the text is not valid JSON or
 * has no comments array. Callers that sync over Yjs use this to tell a genuinely
 * empty list apart from a corrupted payload (e.g. two peers rewrote the whole
 * JSON at once and the CRDT merged them into invalid text) so a corrupt merge
 * never wipes everyone's comments.
 */
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

/** Ensure `replies` is always a clean array (older files predate the field). */
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

export function parseEditorComments(raw: string): EditorComment[] {
  return tryParseEditorComments(raw) ?? [];
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

/** Resolve a comment span in the current document; falls back to quote/context search. */
export function resolveCommentRange(
  source: string,
  comment: EditorComment,
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
      const from = contextual + comment.prefix.length;
      return { from, to: from + comment.quote.length };
    }
  }

  const direct = source.indexOf(comment.quote);
  if (direct < 0) return null;
  return { from: direct, to: direct + comment.quote.length };
}

export const setEditorCommentsEffect = StateEffect.define<EditorComment[]>();

export function commentMarkStyle(comment: EditorComment): string {
  const colors = peerColorForKey(comment.authorId || comment.authorName);
  return [
    `background-color: ${colors.colorLight}`,
    `border-bottom: 2px solid ${colors.color}`,
    "border-radius: 2px",
    "box-decoration-break: clone",
    "-webkit-box-decoration-break: clone",
  ].join("; ");
}

export function buildCommentDecorations(
  source: string,
  path: string,
  comments: EditorComment[],
): DecorationSet {
  const ranges = comments
    .filter((comment) => comment.path === path && !comment.resolved)
    .map((comment) => {
      const range = resolveCommentRange(source, comment);
      if (!range) return null;
      return {
        comment,
        ...range,
      };
    })
    .filter((item): item is { comment: EditorComment; from: number; to: number } => Boolean(item))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  return Decoration.set(
    ranges.map(({ comment, from, to }) => Decoration.mark({
      class: "cm-editor-comment",
      attributes: {
        "data-comment-id": comment.id,
        "data-author-id": comment.authorId,
        // Author + body are shown by the richer hover tooltip below. A native
        // `title` here would double up with it (and is unreliable in the
        // macOS webview), so we intentionally omit it.
        style: commentMarkStyle(comment),
      },
    }).range(from, to)),
    true,
  );
}

/** Unresolved comments on `path` whose resolved span covers `pos` (inclusive). */
export function commentsAtPosition(
  source: string,
  path: string,
  comments: EditorComment[],
  pos: number,
): EditorComment[] {
  const hits: EditorComment[] = [];
  for (const comment of comments) {
    if (comment.path !== path || comment.resolved) continue;
    const range = resolveCommentRange(source, comment);
    if (!range) continue;
    // Marks span [from, to); match that so two comments meeting at a shared
    // boundary don't both fire the tooltip at the seam.
    if (pos >= range.from && pos < range.to) hits.push(comment);
  }
  return hits;
}

/** Short "3 min ago" style label; falls back to the raw date on parse failure. */
export function formatCommentTimestamp(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString();
}

export type CommentTooltipActions = {
  /** Local author id, so we can tell "your comment" from a collaborator's. */
  currentAuthorId: string;
  onResolve: (id: string) => void;
  onReply: (comment: EditorComment) => void;
};

/** One author/time/body row, reused for the comment head and each reply. */
function appendCommentLine(
  parent: HTMLElement,
  opts: { authorId: string; authorName: string; when: string; body: string; className: string; now: number },
): void {
  const colors = peerColorForKey(opts.authorId || opts.authorName);
  const line = document.createElement("div");
  line.className = opts.className;

  const head = document.createElement("div");
  head.className = "cm-editor-comment-tooltip-head";
  const dot = document.createElement("span");
  dot.className = "cm-editor-comment-tooltip-dot";
  dot.style.backgroundColor = colors.color;
  const author = document.createElement("span");
  author.className = "cm-editor-comment-tooltip-author";
  author.textContent = opts.authorName || "Anonymous";
  const when = document.createElement("span");
  when.className = "cm-editor-comment-tooltip-time";
  when.textContent = formatCommentTimestamp(opts.when, opts.now);
  head.append(dot, author, when);

  const body = document.createElement("div");
  body.className = "cm-editor-comment-tooltip-body";
  body.textContent = opts.body || "(no comment text)";

  line.append(head, body);
  parent.appendChild(line);
}

/** Build the hover-card DOM shown when the pointer rests on a comment mark. */
export function buildCommentTooltipDom(
  comments: EditorComment[],
  actions?: CommentTooltipActions,
  now = Date.now(),
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-editor-comment-tooltip";
  for (const comment of comments) {
    const item = document.createElement("div");
    item.className = "cm-editor-comment-tooltip-item";

    appendCommentLine(item, {
      authorId: comment.authorId,
      authorName: comment.authorName,
      when: comment.updatedAt || comment.createdAt,
      body: comment.body,
      className: "cm-editor-comment-tooltip-main",
      now,
    });

    for (const reply of comment.replies ?? []) {
      appendCommentLine(item, {
        authorId: reply.authorId,
        authorName: reply.authorName,
        when: reply.createdAt,
        body: reply.body,
        className: "cm-editor-comment-tooltip-reply",
        now,
      });
    }

    if (actions) {
      const row = document.createElement("div");
      row.className = "cm-editor-comment-tooltip-actions";

      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.textContent = comment.resolved ? "Reopen" : "Resolve";
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      // Matches the drawer's own Reply button; the ellipsis promised a menu.
      replyBtn.textContent = "Reply";

      // Keep the hover tooltip alive: a mousedown outside the range would
      // otherwise dismiss it before the click lands.
      for (const btn of [resolveBtn, replyBtn]) {
        btn.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
      }
      resolveBtn.addEventListener("click", (event) => {
        event.preventDefault();
        actions.onResolve(comment.id);
      });
      replyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        actions.onReply(comment);
      });

      row.append(resolveBtn, replyBtn);
      item.appendChild(row);
    }

    dom.appendChild(item);
  }
  return dom;
}

export type EditorCommentsExtensionOptions = {
  /**
   * Optional live getter so decorations survive CodeMirror reconfigure (which
   * recreates StateFields with empty create() state).
   */
  getComments?: () => EditorComment[];
  currentAuthorId?: string;
  onResolve?: (id: string) => void;
  onReply?: (comment: EditorComment) => void;
};

export function editorCommentsExtension(
  path: string,
  options: EditorCommentsExtensionOptions = {},
): Extension {
  const { getComments } = options;
  const tooltipActions: CommentTooltipActions | undefined = (options.onResolve && options.onReply)
    ? { currentAuthorId: options.currentAuthorId ?? "", onResolve: options.onResolve, onReply: options.onReply }
    : undefined;
  const field = StateField.define<CommentDecorationState>({
    create(state) {
      const comments = getComments?.() ?? [];
      return {
        comments,
        decorations: buildCommentDecorations(state.doc.toString(), path, comments),
      };
    },
    update(value, tr) {
      let comments = value.comments;
      let commentsChanged = false;
      for (const effect of tr.effects) {
        if (effect.is(setEditorCommentsEffect)) {
          comments = effect.value;
          commentsChanged = true;
        }
      }
      if (getComments) {
        const latest = getComments();
        if (latest !== comments) {
          comments = latest;
          commentsChanged = true;
        }
      }
      // Rebuild on comment updates and on every doc change so Yjs edits
      // re-anchor marks instead of leaving mapped-empty decorations.
      // Also rebuild when a getter is present so a reconfigure that wiped the
      // field still restores marks on the next transaction (click/type).
      if (commentsChanged || tr.docChanged) {
        return {
          comments,
          decorations: buildCommentDecorations(tr.state.doc.toString(), path, comments),
        };
      }
      return value;
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });

  const commentHover = hoverTooltip((view, pos) => {
    const comments = view.state.field(field).comments;
    const hits = commentsAtPosition(view.state.doc.toString(), path, comments, pos);
    if (!hits.length) return null;
    let from = pos;
    let to = pos;
    const source = view.state.doc.toString();
    for (const comment of hits) {
      const range = resolveCommentRange(source, comment);
      if (!range) continue;
      from = Math.min(from, range.from);
      to = Math.max(to, range.to);
    }
    // Anchor to the hovered line, not to the start of the whole span.
    //
    // CodeMirror hides a hover tooltip once the pointer maps to a document
    // offset outside the anchored range. On a comment covering several lines,
    // anchoring to the span start puts the card above the *first* line while
    // the pointer is on a later one — and moving up to reach it crosses
    // offsets before the span start, so the card vanished mid-approach and its
    // buttons could not be clicked. Per-line anchoring puts the card directly
    // above the pointer, one short hop away.
    const line = view.state.doc.lineAt(pos);
    return {
      pos: Math.max(from, line.from),
      end: Math.min(to, line.to),
      above: true,
      // The arrow counts as part of the tooltip for hit-testing, bridging the
      // gap between the card and the text.
      arrow: true,
      create: () => ({
        dom: buildCommentTooltipDom(hits, tooltipActions),
        // Let a long comment grow; otherwise CodeMirror clamps the height to
        // the space above the line and the body becomes a scroll box.
        resize: false,
      }),
    };
  });

  return [
    field,
    commentHover,
    EditorView.baseTheme({
      ".cm-editor-comment": {
        borderRadius: "2px",
      },
    }),
  ];
}
