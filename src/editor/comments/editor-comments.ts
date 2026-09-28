import { StateEffect, StateField, type Extension, type StateEffectType, type Text } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { peerColorForKey } from "../../components/ui/collab-colors";
import { element } from "../dom-utils";
import {
  editorCommentAuthorDisplayName,
  resolveCommentAnchor,
  type EditorComment,
  type EditorCommentReply,
} from "./editor-comment-data";

export const setEditorCommentsEffect = StateEffect.define<EditorComment[]>();

export type EditorCommentDraft = Pick<EditorComment, "path" | "from" | "to" | "quote" | "prefix" | "suffix">;
export const setEditorCommentDraftEffect = StateEffect.define<EditorCommentDraft | null>();

export function commentMarkStyle(comment: EditorComment): string {
  const { color, colorLight } = peerColorForKey(comment.authorId || comment.authorName);
  return `background-color: ${colorLight}; border-bottom: 2px solid ${color}; border-radius: 2px; `
    + "box-decoration-break: clone; -webkit-box-decoration-break: clone";
}

type AnchoredComment = { comment: EditorComment; from: number; to: number };

/** Unresolved comments on `path` that still anchor in `source`, with their spans. */
function anchoredComments(source: string, path: string, comments: EditorComment[]): AnchoredComment[] {
  return comments.flatMap((comment) => {
    if (comment.path !== path || comment.resolved) return [];
    const range = resolveCommentAnchor(source, comment);
    return range ? [{ comment, ...range }] : [];
  });
}

export function buildCommentDecorations(source: string, path: string, comments: EditorComment[]): DecorationSet {
  const ranges = anchoredComments(source, path, comments).sort((a, b) => a.from - b.from || a.to - b.to);
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

/**
 * Anchored comments on `path` whose span covers `pos`. Marks span [from, to);
 * match that so two comments meeting at a shared boundary don't both fire the
 * tooltip at the seam.
 */
export function commentsAtPosition(
  source: string,
  path: string,
  comments: EditorComment[],
  pos: number,
): AnchoredComment[] {
  return anchoredComments(source, path, comments).filter(({ from, to }) => pos >= from && pos < to);
}

const RELATIVE_STEPS: Array<[unit: Intl.RelativeTimeFormatUnit, divisor: number, limit: number]> = [
  ["minute", 60, 60],
  ["hour", 60, 24],
  ["day", 24, 7],
];

/** Short "3 min ago" style label; falls back to the raw date on parse failure. */
export function formatCommentTimestamp(iso: string, now = Date.now(), locale = "en"): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let elapsed = Math.round((now - then) / 1000);
  if (elapsed < 45) return relative.format(0, "second");
  for (const [unit, divisor, limit] of RELATIVE_STEPS) {
    elapsed = Math.round(elapsed / divisor);
    if (elapsed < limit) return relative.format(-elapsed, unit);
  }
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

type CommentTooltipActions = {
  onResolve: (id: string) => void;
  onReply: (comment: EditorComment) => void;
};

/** One author/time/body row, shared by the comment head and each reply. */
function commentLine(
  entry: Pick<EditorCommentReply, "authorId" | "authorName" | "body">,
  when: string,
  className: string,
  now: number,
  localization: EditorCommentLocalization,
): HTMLElement {
  const dot = element("span", "cm-editor-comment-tooltip-dot");
  dot.style.backgroundColor = peerColorForKey(entry.authorId || entry.authorName).color;
  const head = element("div", "cm-editor-comment-tooltip-head");
  head.append(
    dot,
    element("span", "cm-editor-comment-tooltip-author", editorCommentAuthorDisplayName(entry.authorName, localization.anonymous)),
    element("span", "cm-editor-comment-tooltip-time", formatCommentTimestamp(when, now, localization.locale)),
  );
  const line = element("div", className);
  line.append(head, element("div", "cm-editor-comment-tooltip-body", entry.body || localization.noCommentText));
  return line;
}

/** Build the hover-card DOM shown when the pointer rests on a comment mark. */
export function buildCommentTooltipDom(
  comments: EditorComment[],
  actions?: CommentTooltipActions,
  now = Date.now(),
  localization = DEFAULT_COMMENT_LOCALIZATION,
): HTMLElement {
  const dom = element("div", "cm-editor-comment-tooltip");
  for (const comment of comments) {
    const item = element("div", "cm-editor-comment-tooltip-item");
    item.append(
      commentLine(comment, comment.updatedAt || comment.createdAt, "cm-editor-comment-tooltip-main", now, localization),
      ...(comment.replies ?? []).map((reply) =>
        commentLine(reply, reply.createdAt, "cm-editor-comment-tooltip-reply", now, localization)),
    );
    if (actions) {
      const row = element("div", "cm-editor-comment-tooltip-actions");
      const buttons: Array<[string, () => void]> = [
        [comment.resolved ? localization.reopen : localization.resolve, () => actions.onResolve(comment.id)],
        // Matches the drawer's own Reply button; an ellipsis would promise a menu.
        [localization.reply, () => actions.onReply(comment)],
      ];
      for (const [label, run] of buttons) {
        const button = element("button", "", label);
        button.type = "button";
        // Keep the hover tooltip alive: a mousedown outside the range would
        // otherwise dismiss it before the click lands.
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          run();
        });
        row.append(button);
      }
      item.append(row);
    }
    dom.append(item);
  }
  return dom;
}

export type EditorCommentsExtensionOptions = {
  /**
   * Optional live getter so decorations survive CodeMirror reconfigure (which
   * recreates StateFields with empty create() state).
   */
  getComments?: () => EditorComment[];
  getDraft?: () => EditorCommentDraft | null;
  onResolve?: (id: string) => void;
  onReply?: (comment: EditorComment) => void;
  getLocalization?: () => EditorCommentLocalization;
};

/** The value of the last `type` effect in a transaction; undefined when there is none. */
function lastEffectValue<T>(effects: readonly StateEffect<unknown>[], type: StateEffectType<T>): T | undefined {
  let value: T | undefined;
  for (const effect of effects) if (effect.is(type)) value = effect.value;
  return value;
}

export function editorCommentsExtension(path: string, options: EditorCommentsExtensionOptions = {}): Extension {
  const { getComments, onResolve, onReply } = options;
  const tooltipActions = onResolve && onReply ? { onResolve, onReply } : undefined;
  // Drafts decorate the document without becoming interactive, persisted comments.
  const draftDecorations = (doc: Text, draft: EditorCommentDraft | null) => {
    const range = draft?.path === path ? resolveCommentAnchor(doc.toString(), draft) : null;
    return range
      ? Decoration.set([Decoration.mark({ class: "editor-comment-draft" }).range(range.from, range.to)])
      : Decoration.none;
  };
  const draftField = StateField.define<{ draft: EditorCommentDraft | null; decorations: DecorationSet }>({
    create(state) {
      const draft = options.getDraft?.() ?? null;
      return { draft, decorations: draftDecorations(state.doc, draft) };
    },
    update(value, tr) {
      const pushed = lastEffectValue(tr.effects, setEditorCommentDraftEffect);
      const draft = pushed === undefined ? value.draft : pushed;
      if (draft === value.draft && !tr.docChanged) return value;
      return { draft, decorations: draftDecorations(tr.state.doc, draft) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
  const field = StateField.define<{ comments: EditorComment[]; decorations: DecorationSet }>({
    create(state) {
      const comments = getComments?.() ?? [];
      // Serializing the whole doc is O(document); skip it when there is
      // nothing to anchor (the common case for most files).
      return {
        comments,
        decorations: comments.length ? buildCommentDecorations(state.doc.toString(), path, comments) : Decoration.none,
      };
    },
    update(value, tr) {
      const pushed = lastEffectValue(tr.effects, setEditorCommentsEffect);
      // Re-reading the getter on every transaction lets a reconfigure that
      // wiped the field restore marks on the next click or keystroke.
      const comments = getComments?.() ?? pushed ?? value.comments;
      // Rebuild on comment updates and on every doc change so Yjs edits
      // re-anchor marks instead of leaving mapped-empty decorations.
      if (comments === value.comments && pushed === undefined && !tr.docChanged) return value;
      // No comments means no decorations regardless of content — return
      // before paying doc.toString() on every keystroke of large files.
      if (!comments.length) {
        return value.comments.length || value.decorations.size ? { comments, decorations: Decoration.none } : value;
      }
      return { comments, decorations: buildCommentDecorations(tr.state.doc.toString(), path, comments) };
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });

  const commentHover = hoverTooltip((view, pos) => {
    const hits = commentsAtPosition(view.state.doc.toString(), path, view.state.field(field).comments, pos);
    if (!hits.length) return null;
    const from = Math.min(pos, ...hits.map((hit) => hit.from));
    const to = Math.max(pos, ...hits.map((hit) => hit.to));
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
          hits.map((hit) => hit.comment),
          tooltipActions,
          Date.now(),
          options.getLocalization?.() ?? DEFAULT_COMMENT_LOCALIZATION,
        ),
        // Constrain long threads to the available space on the chosen side
        // of the line; the card scrolls without hiding its actions off-screen.
        resize: true,
      }),
    };
  });

  return [field, draftField, commentHover];
}
