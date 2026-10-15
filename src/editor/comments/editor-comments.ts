import { msg } from "@lingui/core/macro";
import { RangeSet, StateEffect, StateField, type Extension, type StateEffectType, type Text } from "@codemirror/state";
import {
  activateHover, closeHoverTooltip, Decoration, EditorView, gutter, GutterMarker, hoverTooltip, type DecorationSet,
} from "@codemirror/view";
import { peerColorForKey } from "../../components/ui/collab-colors";
import { i18n } from "../../i18n";
import { element } from "../dom-utils";
import { annotationStatus, resolveCommentAnchor, type EditorComment } from "./editor-comment-data";

export const setEditorCommentsEffect = StateEffect.define<EditorComment[]>();

export type EditorCommentDraft = Pick<EditorComment, "path" | "from" | "to" | "quote" | "prefix" | "suffix">;
export const setEditorCommentDraftEffect = StateEffect.define<EditorCommentDraft | null>();

export function commentMarkStyle(comment: EditorComment): string {
  const { color, colorLight } = comment.authorColor ?? peerColorForKey(comment.authorId || comment.authorName);
  const markStyle = `background-color: ${colorLight}; border-bottom: 2px solid ${color}; border-radius: 2px; `
    + "box-decoration-break: clone; -webkit-box-decoration-break: clone";
  return markStyle;
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

/**
 * A local annotation reads as an amber highlighter stroke, in the blue of a
 * proposal or the violet of a question while the agent's answer waits; an
 * Overleaf thread keeps its author's colour.
 */
export function buildCommentDecorations(source: string, path: string, comments: EditorComment[]): DecorationSet {
  return decorationsFor(anchoredComments(source, path, comments));
}

function decorationsFor(anchored: AnchoredComment[]): DecorationSet {
  const ranges = [...anchored].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    ranges.map(({ comment, from, to }) => Decoration.mark({
      class: comment.number ? "cm-editor-comment cm-annotation" : "cm-editor-comment",
      attributes: {
        "data-comment-id": comment.id,
        "data-author-id": comment.authorId,
        // Author + body are shown by the richer hover tooltip below. A native
        // `title` here would double up with it (and is unreliable in the
        // macOS webview), so we intentionally omit it.
        ...comment.number
          ? { "data-annotation-status": annotationStatus(comment) }
          : { style: commentMarkStyle(comment) },
      },
    }).range(from, to)),
    true,
  );
}

/**
 * An annotation's numbered pin in the gutter, on the line its passage starts.
 * Several on one line show the first, and the pin's label names them all.
 */
class AnnotationPinMarker extends GutterMarker {
  constructor(readonly comments: readonly EditorComment[], readonly label: string) {
    super();
  }

  eq(other: AnnotationPinMarker) {
    return other.label === this.label && other.comments.length === this.comments.length
      && other.comments.every((comment, index) => comment.number === this.comments[index]?.number
        && annotationStatus(comment) === annotationStatus(this.comments[index]!));
  }

  toDOM() {
    const first = this.comments[0]!;
    const pin = element("span", "cm-annotation-pin", String(first.number));
    pin.dataset.annotationStatus = annotationStatus(first);
    if (this.comments.length > 1) pin.dataset.more = "";
    pin.title = this.label;
    // A box one row tall at the line's top, so the pin sits on its first row however far it wraps.
    const row = element("span", "cm-annotation-pin-row");
    row.append(pin);
    return row;
  }
}

function annotationPins(doc: Text, anchored: AnchoredComment[], label: (numbers: number[]) => string): RangeSet<GutterMarker> {
  const byLine = new Map<number, AnchoredComment[]>();
  for (const hit of anchored) {
    if (!hit.comment.number) continue;
    const line = doc.lineAt(hit.from).from;
    byLine.set(line, [...byLine.get(line) ?? [], hit]);
  }
  return RangeSet.of([...byLine].sort(([a], [b]) => a - b).map(([line, hits]) => {
    const comments = hits.map((hit) => hit.comment).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    return new AnnotationPinMarker(comments, label(comments.map((comment) => comment.number ?? 0))).range(line);
  }));
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

/**
 * "3 minutes ago" style label, or "3 min. ago" with the short `style`; falls
 * back to the raw date on parse failure.
 */
export function formatCommentTimestamp(iso: string, now = Date.now(), locale = "en", style: Intl.RelativeTimeFormatStyle = "long"): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
  let elapsed = Math.round((now - then) / 1000);
  if (elapsed < 45) return relative.format(0, "second");
  for (const [unit, divisor, limit] of RELATIVE_STEPS) {
    elapsed = Math.round(elapsed / divisor);
    if (elapsed < limit) return relative.format(-elapsed, unit);
  }
  return new Date(then).toLocaleDateString(locale);
}

/** A gutter pin's label, naming the annotations on its line. */
function defaultPinLabel(numbers: number[]): string {
  const list = numbers.join(", ");
  return numbers.length === 1 ? i18n._(msg`Annotation ${list}`) : i18n._(msg`Annotations ${list}`);
}

/**
 * The comment card one editor shows over a comment's passage, which React
 * draws into `host` (canvas/editor-comment-cards.tsx): CodeMirror places,
 * flips and sizes the hover tooltip, and the card inside it is the shared
 * `CommentCard`.
 */
export type CommentCardMount = {
  key: number;
  host: HTMLElement;
  comments: EditorComment[];
  /**
   * The card stays when the pointer leaves, until a click outside it, Esc or
   * `close`: a reply is being written in it.
   */
  pinned: boolean;
  /** The thread whose reply field the card opens with. */
  replyingTo: string | null;
  /** Keep the card while a reply to `id` is written; it is drawn again, pinned. */
  pin: (id: string) => void;
  close: () => void;
  /** Fade the passage of the comment `id` as it resolves. */
  fade: (id: string) => void;
  focusEditor: () => void;
};

/** The comment cards on screen, one per editor at most, for React to draw. */
export class CommentCardHosts {
  private mounts: readonly CommentCardMount[] = [];
  private listeners = new Set<() => void>();
  private nextKey = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.mounts;

  add(mount: Omit<CommentCardMount, "key">) {
    this.publish([...this.mounts, { ...mount, key: ++this.nextKey }]);
  }

  remove(host: HTMLElement) {
    if (this.mounts.some((mount) => mount.host === host)) this.publish(this.mounts.filter((mount) => mount.host !== host));
  }

  private publish(mounts: readonly CommentCardMount[]) {
    this.mounts = mounts;
    for (const listener of this.listeners) listener();
  }
}

export type EditorCommentsExtensionOptions = {
  /**
   * Optional live getter so decorations survive CodeMirror reconfigure (which
   * recreates StateFields with empty create() state).
   */
  getComments?: () => EditorComment[];
  getDraft?: () => EditorCommentDraft | null;
  /** Where the comment card over a hovered passage is drawn; without it a passage shows no card. */
  cards?: CommentCardHosts;
  /** A gutter pin was clicked: show its annotation. */
  onOpenAnnotation?: (comment: EditorComment) => void;
  /** A gutter pin's label, naming the annotations on its line; English when absent. */
  pinLabel?: (numbers: number[]) => string;
};

/** The value of the last `type` effect in a transaction; undefined when there is none. */
function lastEffectValue<T>(effects: readonly StateEffect<unknown>[], type: StateEffectType<T>): T | undefined {
  let value: T | undefined;
  for (const effect of effects) if (effect.is(type)) value = effect.value;
  return value;
}

export function editorCommentsExtension(path: string, options: EditorCommentsExtensionOptions = {}): Extension {
  const { getComments, cards } = options;
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
  const pinLabel = (numbers: number[]) => (options.pinLabel ?? defaultPinLabel)(numbers);
  type Anchored = { comments: EditorComment[]; decorations: DecorationSet; pins: RangeSet<GutterMarker> };
  const anchor = (doc: Text, comments: EditorComment[]): Anchored => {
    const anchored = anchoredComments(doc.toString(), path, comments);
    return { comments, decorations: decorationsFor(anchored), pins: annotationPins(doc, anchored, pinLabel) };
  };
  const field = StateField.define<Anchored>({
    create(state) {
      const comments = getComments?.() ?? [];
      // Serializing the whole doc is O(document); skip it when there is
      // nothing to anchor (the common case for most files).
      return comments.length ? anchor(state.doc, comments) : { comments, decorations: Decoration.none, pins: RangeSet.empty };
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
        return value.comments.length || value.decorations.size
          ? { comments, decorations: Decoration.none, pins: RangeSet.empty }
          : value;
      }
      return anchor(tr.state.doc, comments);
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });
  // Zero-width beside the text: the pin overlays the quiet fold column (editor-workspace.css).
  const pinGutter = gutter({
    class: "cm-annotation-gutter",
    markers: (view) => view.state.field(field).pins,
    domEventHandlers: {
      mousedown: (view, line, event) => {
        const pin = event.target instanceof Element ? event.target.closest(".cm-annotation-pin") : null;
        if (!pin || !options.onOpenAnnotation) return false;
        let hit: EditorComment | undefined;
        view.state.field(field).pins.between(line.from, line.from, (_from, _to, marker) => {
          hit = (marker as AnnotationPinMarker).comments[0];
        });
        if (!hit) return false;
        event.preventDefault();
        options.onOpenAnnotation(hit);
        return true;
      },
    },
  });

  /** Where the card was last asked for, so a reply can pin it there. */
  let hovered = { pos: 0, side: 1 as -1 | 1 };
  /** The reply that the next card opens with, pinned; set just before it is drawn again. */
  let pinFor: string | null = null;
  const commentHover = hoverTooltip((view, pos, side) => {
    if (!cards) return null;
    const hits = commentsAtPosition(view.state.doc.toString(), path, view.state.field(field).comments, pos);
    if (!hits.length) return null;
    hovered = { pos, side };
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
      create: () => {
        const host = element("div", "cm-editor-comment-card-host");
        // The card handles its own clicks; the editor and the canvas around it must not take them as theirs.
        host.addEventListener("mousedown", (event) => event.stopPropagation());
        // The panel around the editor clips what crosses its edge: the card takes the editor's width at most.
        host.style.setProperty("--comment-card-room", `${Math.max(0, view.dom.clientWidth - 16)}px`);
        const replyingTo = pinFor;
        pinFor = null;
        cards.add({
          host,
          comments: hits.map((hit) => hit.comment),
          pinned: replyingTo !== null,
          replyingTo,
          // A hover card closes once the pointer leaves it, which would lose a
          // reply being typed. Opened again through activateHover, the same
          // card stays (CodeMirror locks a tooltip opened that way) until it
          // is closed.
          pin: (id) => {
            pinFor = id;
            activateHover(view, hovered.pos, hovered.side, { tooltip: commentHover });
          },
          close: () => view.dispatch({ effects: closeHoverTooltip(commentHover) }),
          fade: (id) => {
            for (const mark of view.contentDOM.querySelectorAll(`[data-comment-id="${CSS.escape(id)}"]`)) {
              mark.classList.add("cm-editor-comment-resolving");
            }
          },
          focusEditor: () => view.focus(),
        });
        // Constrain long threads to the available space on the chosen side
        // of the line; the card scrolls without hiding its actions off-screen.
        return { dom: host, resize: true, destroy: () => cards.remove(host) };
      },
    };
  });

  // A pin of three digits or more is wider than the fold column it lies over;
  // the gutter beside the text widens by the difference (editor-workspace.css).
  const pinDigits = EditorView.editorAttributes.compute([field], (state) => {
    let digits = 0;
    state.field(field).pins.between(0, state.doc.length, (_from, _to, marker) => {
      digits = Math.max(digits, String((marker as AnnotationPinMarker).comments[0]?.number ?? 0).length);
    });
    const attributes: Record<string, string> = digits >= 3 ? { "data-annotation-digits": String(Math.min(digits, 5)) } : {};
    return attributes;
  });
  return [field, draftField, commentHover, pinGutter, pinDigits];
}
