import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { peerColorForKey } from "./collab-colors";
import {
  editorCommentAuthorDisplayName,
  resolveCommentRange,
  type EditorComment,
} from "./editor-comment-data";
export {
  createEditorComment,
  createEditorCommentReply,
  editorCommentAuthorDisplayName,
  EDITOR_COMMENTS_PATH,
  emptyEditorCommentsFile,
  loadEditorCommentAuthorId,
  mergeEditorComments,
  parseEditorComments,
  resolveCommentAnchor,
  resolveCommentRange,
  serializeEditorComments,
  tryParseEditorComments,
} from "./editor-comment-data";
export type { EditorComment, EditorCommentReply, EditorCommentsFile } from "./editor-comment-data";

type CommentDecorationState = {
  comments: EditorComment[];
  decorations: DecorationSet;
};

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
export function formatCommentTimestamp(
  iso: string,
  now = Date.now(),
  locale = "en",
): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now - then) / 1000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 45) return relative.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return relative.format(-days, "day");
  return new Date(then).toLocaleDateString(locale);
}

export type EditorCommentLocalization = {
  locale: string;
  anonymous: string;
  noCommentText: string;
  reopen: string;
  resolve: string;
  reply: string;
};

const DEFAULT_COMMENT_LOCALIZATION: EditorCommentLocalization = {
  locale: "en",
  anonymous: "Anonymous",
  noCommentText: "(no comment text)",
  reopen: "Reopen",
  resolve: "Resolve",
  reply: "Reply",
};

export type CommentTooltipActions = {
  /** Local author id, so we can tell "your comment" from a collaborator's. */
  currentAuthorId: string;
  onResolve: (id: string) => void;
  onReply: (comment: EditorComment) => void;
};

/** One author/time/body row, reused for the comment head and each reply. */
function appendCommentLine(
  parent: HTMLElement,
  opts: {
    authorId: string;
    authorName: string;
    when: string;
    body: string;
    className: string;
    now: number;
    localization: EditorCommentLocalization;
  },
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
  author.textContent = editorCommentAuthorDisplayName(
    opts.authorName,
    opts.localization.anonymous,
  );
  const when = document.createElement("span");
  when.className = "cm-editor-comment-tooltip-time";
  when.textContent = formatCommentTimestamp(opts.when, opts.now, opts.localization.locale);
  head.append(dot, author, when);

  const body = document.createElement("div");
  body.className = "cm-editor-comment-tooltip-body";
  body.textContent = opts.body || opts.localization.noCommentText;

  line.append(head, body);
  parent.appendChild(line);
}

/** Build the hover-card DOM shown when the pointer rests on a comment mark. */
export function buildCommentTooltipDom(
  comments: EditorComment[],
  actions?: CommentTooltipActions,
  now = Date.now(),
  localization = DEFAULT_COMMENT_LOCALIZATION,
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
      localization,
    });

    for (const reply of comment.replies ?? []) {
      appendCommentLine(item, {
        authorId: reply.authorId,
        authorName: reply.authorName,
        when: reply.createdAt,
        body: reply.body,
        className: "cm-editor-comment-tooltip-reply",
        now,
        localization,
      });
    }

    if (actions) {
      const row = document.createElement("div");
      row.className = "cm-editor-comment-tooltip-actions";

      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.textContent = comment.resolved ? localization.reopen : localization.resolve;
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      // Matches the drawer's own Reply button; the ellipsis promised a menu.
      replyBtn.textContent = localization.reply;

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
  getLocalization?: () => EditorCommentLocalization;
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
        // Serializing the whole doc is O(document); skip it when there is
        // nothing to anchor (the common case for most files).
        decorations: comments.length
          ? buildCommentDecorations(state.doc.toString(), path, comments)
          : Decoration.none,
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
        // No comments means no decorations regardless of content — return
        // before paying doc.toString() on every keystroke of large files.
        if (!comments.length) {
          return value.comments.length || value.decorations.size ? { comments, decorations: Decoration.none } : value;
        }
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
        dom: buildCommentTooltipDom(
          hits,
          tooltipActions,
          Date.now(),
          options.getLocalization?.() ?? DEFAULT_COMMENT_LOCALIZATION,
        ),
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
