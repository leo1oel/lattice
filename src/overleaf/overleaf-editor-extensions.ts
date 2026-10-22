/**
 * Overleaf collaboration drawn into CodeMirror: other people's carets, and
 * suggestions ("track changes") the way Overleaf's own editor draws them — an
 * insertion underlined, a deletion struck through, both in the author's hue.
 *
 * Each draws a caller-owned list and knows nothing about sockets or where the
 * list came from. A CodeMirror reconfigure recreates StateFields from scratch,
 * so each field re-reads a live getter on every transaction (the pattern
 * `editor-comments.ts` uses) rather than trusting its create() state. Every
 * visual rule is inlined through `EditorView.baseTheme` so the extensions work
 * wherever they are dropped in.
 */
import { StateEffect, StateField, type Extension, type StateEffectType, type Text } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { formatCommentTimestamp } from "../editor/comments/editor-comments";
import { element } from "../editor/dom-utils";
import { i18n } from "../i18n";
import type { TrackedChange } from "./use-overleaf-realtime";
import { hueColor } from "../components/ui/collab-colors";

/**
 * A decoration field over a caller-owned list: replaced by `effect`, re-read
 * from `getItems` on every transaction, and rebuilt on a list change or any
 * document edit — positions are plain offsets, not mapped ranges, so a local
 * edit before one would otherwise leave it decorating the wrong text.
 */
function listDecorationField<T>(
  build: (doc: Text, items: T[]) => DecorationSet,
  getItems?: () => T[],
  effect?: StateEffectType<T[]>,
) {
  return StateField.define<{ items: T[]; decorations: DecorationSet }>({
    create(state) {
      const items = getItems?.() ?? [];
      return { items, decorations: build(state.doc, items) };
    },
    update(value, tr) {
      let items = value.items;
      for (const next of tr.effects) if (effect && next.is(effect)) items = next.value;
      if (getItems) items = getItems();
      return items !== value.items || tr.docChanged ? { items, decorations: build(tr.state.doc, items) } : value;
    },
    provide: (field) => EditorView.decorations.from(field, (state) => state.decorations),
  });
}

// ---- other people's carets --------------------------------------------------

export type PresenceCursor = {
  name: string;
  hue: number;
  /** Exact collaborator color when the provider supplies one; hue is the fallback. */
  color?: string;
  row: number;
  column: number;
};

export function presenceCursorColor(cursor: Pick<PresenceCursor, "color" | "hue">): string {
  return cursor.color && /^#[0-9a-f]{6}$/i.test(cursor.color) ? cursor.color : hueColor(cursor.hue);
}

const REMOTE_CARET_SELECTOR = ".cm-overleaf-caret";
const REMOTE_LABEL_SELECTOR = ".cm-overleaf-caret-label";

/**
 * Which remote carets sit too close to the top edge for their name tag to fit
 * above them. Measures without writing, so CodeMirror can batch it with its
 * own layout work.
 */
export function measureCursorLabelPlacements(view: EditorView): { caret: HTMLElement; below: boolean }[] {
  const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
  return Array.from(view.dom.querySelectorAll<HTMLElement>(REMOTE_CARET_SELECTOR)).flatMap((caret) => {
    const label = caret.querySelector<HTMLElement>(REMOTE_LABEL_SELECTOR);
    if (!label) return [];
    return [{ caret, below: caret.getBoundingClientRect().top - label.getBoundingClientRect().height < scrollerTop + 2 }];
  });
}

const cursorLabelPlacement = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {
    this.schedule();
  }

  docViewUpdate() {
    this.schedule();
  }

  schedule() {
    this.view.requestMeasure({
      key: this,
      read: measureCursorLabelPlacements,
      write: (placements) => {
        for (const { caret, below } of placements) caret.classList.toggle("cm-caret-label-below", below);
      },
    });
  }
}, {
  eventObservers: {
    scroll() {
      this.schedule();
    },
  },
});

/** Clamp a zero-based (row, column) to a real offset in `doc`. */
export function posForRowColumn(doc: Text, row: number, column: number): number {
  const line = doc.line(Math.min(Math.max(row, 0) + 1, doc.lines));
  return line.from + Math.min(Math.max(column, 0), line.length);
}

class PresenceCaretWidget extends WidgetType {
  constructor(private readonly name: string, private readonly color: string) {
    super();
  }

  eq(other: PresenceCaretWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  toDOM(): HTMLElement {
    const wrap = element("span", "cm-overleaf-caret");
    wrap.style.borderColor = this.color;
    const dot = element("span", "cm-overleaf-caret-dot");
    const label = element("span", "cm-overleaf-caret-label", this.name || i18n._(msg`Anonymous`));
    dot.style.backgroundColor = label.style.backgroundColor = this.color;
    wrap.append(dot, label);
    return wrap;
  }

  // Never a native caret to blink or a click target to steal — this is a
  // read-only projection of someone else's position, not a selection.
  ignoreEvent(): boolean {
    return true;
  }

  get estimatedHeight(): number {
    return -1;
  }
}

export function buildPresenceCursorDecorations(doc: Text, cursors: PresenceCursor[]): DecorationSet {
  return Decoration.set(
    cursors.map((cursor) => Decoration.widget({
      widget: new PresenceCaretWidget(cursor.name, presenceCursorColor(cursor)),
      side: 1,
    }).range(posForRowColumn(doc, cursor.row, cursor.column))),
    true,
  );
}

export const setOverleafCursorsEffect = StateEffect.define<PresenceCursor[]>();

/** Remote carets with always-visible name tags; peers re-anchor once their next position arrives. */
export function overleafCursorsExtension(options: { getCursors?: () => PresenceCursor[] } = {}): Extension {
  return [
    listDecorationField(buildPresenceCursorDecorations, options.getCursors, setOverleafCursorsEffect),
    cursorLabelPlacement,
    EditorView.baseTheme({
      ".cm-overleaf-caret": {
        position: "relative",
        display: "inline",
        borderLeft: "2px solid",
        marginLeft: "-1px",
        pointerEvents: "none",
      },
      ".cm-overleaf-caret-dot": {
        position: "absolute",
        width: "6px",
        height: "6px",
        top: "-3px",
        left: "-4px",
        borderRadius: "50%",
      },
      ".cm-overleaf-caret-label": {
        position: "absolute",
        top: "-1.35em",
        left: "-1px",
        padding: "1px 5px",
        borderRadius: "4px 4px 4px 0",
        font: "600 var(--type-micro-size)/1.2 var(--ui-font, sans-serif)",
        color: "#fff",
        whiteSpace: "nowrap",
        zIndex: "6",
        pointerEvents: "none",
      },
      ".cm-overleaf-caret.cm-caret-label-below .cm-overleaf-caret-label": {
        top: "calc(100% + 2px)",
        borderRadius: "0 4px 4px 4px",
      },
    }),
  ];
}

// ---- suggestions -------------------------------------------------------------

/**
 * A suggestion's span in a document of `length`, clamped into it. A suggested
 * deletion's text is no longer in the document, so its span is the empty one
 * at the point the text was removed from.
 */
function clampedSpan(change: TrackedChange, length: number) {
  const from = Math.max(0, Math.min(change.position, length));
  return { from, to: change.deletion ? from : Math.max(from, Math.min(from + change.text.length, length)) };
}

/**
 * A suggestion's span in `doc`, or null when there is nothing to show: the
 * suggested text is empty, or the document has since become shorter than the
 * suggestion expects (stale until the next `reload()`). Empty for a deletion.
 */
export function trackedChangeRange(doc: Text, change: TrackedChange): { from: number; to: number } | null {
  if (!change.text || change.position > doc.length) return null;
  const range = clampedSpan(change, doc.length);
  return change.deletion || range.to > range.from ? range : null;
}

/**
 * Context around a suggestion, for a panel to quote — mirrors an editor
 * comment's prefix/quote/suffix. A deletion quotes the text it removed, which
 * the source no longer holds; the context is what now surrounds that point.
 */
export function trackedChangeContext(source: string, change: TrackedChange, context = 32) {
  const { from, to } = clampedSpan(change, source.length);
  return {
    prefix: source.slice(Math.max(0, from - context), from),
    quote: change.deletion ? change.text : source.slice(from, to),
    suffix: source.slice(to, Math.min(source.length, to + context)),
  };
}

const deletionStyle = (hue: number) =>
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS declaration
  `text-decoration-line: line-through; text-decoration-color: ${hueColor(hue)}; text-decoration-thickness: 2px; background-color: ${hueColor(hue, 0.1)}`;

/** The removed text, struck through and drawn at the point it was removed from; never part of the document. */
class DeletedTextWidget extends WidgetType {
  constructor(readonly change: TrackedChange) {
    super();
  }

  eq(other: DeletedTextWidget) {
    return other.change.id === this.change.id && other.change.text === this.change.text && other.change.hue === this.change.hue;
  }

  toDOM() {
    const removed = element("span", "cm-tracked-change-delete", this.change.text);
    removed.dataset.changeId = this.change.id;
    removed.setAttribute("style", deletionStyle(this.change.hue));
    return removed;
  }
}

export function buildTrackedChangeDecorations(doc: Text, changes: TrackedChange[]): DecorationSet {
  return Decoration.set(changes.flatMap((change) => {
    const range = trackedChangeRange(doc, change);
    if (!range) return [];
    // Before the caret at that point, so typing there reads as a replacement.
    if (change.deletion) return [Decoration.widget({ widget: new DeletedTextWidget(change), side: -1 }).range(range.from)];
    return [Decoration.mark({
      class: "cm-tracked-change-insert",
      attributes: {
        "data-change-id": change.id,
        style: `border-bottom: 2px solid ${hueColor(change.hue)}; background-color: ${hueColor(change.hue, 0.14)}`,
      },
    }).range(range.from, range.to)];
  }), true);
}

/**
 * Suggestions at `pos`: an insertion whose span covers it (inclusive start,
 * exclusive end — matches `commentsAtPosition`), or a deletion drawn there.
 */
export function trackedChangesAtPosition(doc: Text, changes: TrackedChange[], pos: number): TrackedChange[] {
  return changes.filter((change) => {
    const range = trackedChangeRange(doc, change);
    if (!range) return false;
    return change.deletion ? pos === range.from : pos >= range.from && pos < range.to;
  });
}

export type TrackedChangeTooltipActions = {
  /** Display name for a suggestion's author, else "Unknown" — the caller resolves this, not us. */
  authorName: (userId: string | null) => string;
  /**
   * False for a read-only or suggest-only account: Overleaf itself refuses
   * both calls for them. A function, so a permission change is picked up even
   * though the extension is built once.
   */
  canAct: () => boolean;
  onAccept: (change: TrackedChange) => void;
  onReject: (change: TrackedChange) => void;
};

/** The hover card: for each suggestion, who and what, and Accept/Reject for that one alone. */
export function buildTrackedChangeTooltipDom(changes: TrackedChange[], actions: TrackedChangeTooltipActions, now = Date.now()): HTMLElement {
  const dom = element("div", "cm-tracked-change-tooltip");
  for (const change of changes) {
    const head = element("div", "cm-tracked-change-tooltip-head");
    const dot = element("span", "cm-tracked-change-tooltip-dot");
    dot.style.backgroundColor = hueColor(change.hue);
    head.append(dot, element("span", "cm-tracked-change-tooltip-author", actions.authorName(change.userId)));
    if (change.timestamp) {
      head.append(element("span", "cm-tracked-change-tooltip-time", formatCommentTimestamp(change.timestamp, now)));
    }
    const text = change.text;
    const body = element("div", "cm-tracked-change-tooltip-body", change.deletion
      ? i18n._(msg`Suggests removing "${text}"`)
      : i18n._(msg`Suggests inserting "${text}"`));
    const row = element("div", "cm-tracked-change-tooltip-actions");
    for (const [label, act] of [[i18n._(msg`Accept`), actions.onAccept], [i18n._(msg`Reject`), actions.onReject]] as const) {
      const button = element("button", "", label);
      button.type = "button";
      button.disabled = !actions.canAct();
      // Keep the hover tooltip alive: a mousedown outside the range would
      // otherwise dismiss it before the click lands (same fix as editor-comments.ts).
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        act(change);
      });
      row.append(button);
    }
    const item = element("div", "cm-tracked-change-tooltip-item");
    item.append(head, body, row);
    dom.append(item);
  }
  return dom;
}

/** Accept/reject go further and call the caller's `reload()`, since only the server knows the true new spans. */
export function overleafTrackChangesExtension(options: TrackedChangeTooltipActions & { getChanges: () => TrackedChange[] }): Extension {
  const { getChanges, ...actions } = options;
  const field = listDecorationField(buildTrackedChangeDecorations, getChanges);
  const changeHover = hoverTooltip((view, pos) => {
    const hits = trackedChangesAtPosition(view.state.doc, view.state.field(field).items, pos);
    if (!hits.length) return null;
    let from = pos;
    let to = pos;
    for (const change of hits) {
      const range = trackedChangeRange(view.state.doc, change)!;
      from = Math.min(from, range.from);
      to = Math.max(to, range.to);
    }
    // Anchor to the hovered line rather than the whole span's start — see
    // editor-comments.ts's hover tooltip for why a multi-line span needs this.
    const line = view.state.doc.lineAt(pos);
    return {
      pos: Math.max(from, line.from),
      end: Math.min(to, line.to),
      above: true,
      arrow: true,
      create: () => ({ dom: buildTrackedChangeTooltipDom(hits, actions), resize: false }),
    };
  });

  return [
    field,
    changeHover,
    EditorView.baseTheme({
      ".cm-tracked-change-insert, .cm-tracked-change-delete": { borderRadius: "2px" },
      ".cm-tracked-change-tooltip": {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "320px",
        font: "var(--type-body-compact-size)/1.4 var(--ui-font, sans-serif)",
      },
      ".cm-tracked-change-tooltip-item": { display: "flex", flexDirection: "column", gap: "4px" },
      ".cm-tracked-change-tooltip-item + .cm-tracked-change-tooltip-item": {
        paddingTop: "8px",
        borderTop: "1px solid rgba(128, 128, 128, .25)",
      },
      ".cm-tracked-change-tooltip-head": { display: "flex", alignItems: "center", gap: "6px" },
      ".cm-tracked-change-tooltip-dot": { width: "8px", height: "8px", borderRadius: "50%", flex: "0 0 auto" },
      ".cm-tracked-change-tooltip-author": { fontWeight: "600" },
      ".cm-tracked-change-tooltip-time": { marginLeft: "auto", opacity: "0.6", fontSize: "11px" },
      ".cm-tracked-change-tooltip-body": { whiteSpace: "pre-wrap", wordBreak: "break-word" },
      ".cm-tracked-change-tooltip-actions": { display: "flex", gap: "6px" },
      ".cm-tracked-change-tooltip-actions button": {
        flex: "0 0 auto",
        padding: "3px 10px",
        borderRadius: "6px",
        border: "1px solid rgba(128, 128, 128, .3)",
        background: "transparent",
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
      },
      ".cm-tracked-change-tooltip-actions button:disabled": { opacity: "0.45", cursor: "default" },
    }),
  ];
}

// ---- margin review -------------------------------------------------------------

/** The span whose card is pointed at or focused in margin review, and its author's colour. */
export type MarginLinkedSpan = { from: number; to: number; color: string };

export const setMarginLinkedEffect = StateEffect.define<MarginLinkedSpan | null>();

/** The span's lines tinted in its author's colour, and the span itself a shade deeper. */
function marginLinkedDecorations(doc: Text, span: MarginLinkedSpan): DecorationSet {
  const from = Math.max(0, Math.min(span.from, doc.length));
  const to = Math.max(from, Math.min(span.to, doc.length));
  const style = `--margin-linked: ${span.color}`;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const ranges = [];
  for (let number = first; number <= last; number += 1) {
    ranges.push(Decoration.line({ class: "cm-margin-linked", attributes: { style } }).range(doc.line(number).from));
  }
  if (to > from) ranges.push(Decoration.mark({ class: "cm-margin-linked-span", attributes: { style } }).range(from, to));
  return Decoration.set(ranges, true);
}

const marginLinkedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMarginLinkedEffect)) next = effect.value ? marginLinkedDecorations(tr.state.doc, effect.value) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The margin layer of each editor, told whenever its lines may have moved. */
const marginGeometryListeners = new WeakMap<EditorView, () => void>();

/** Call `listener` when `view`'s lines may have moved (an edit, a resize, a new viewport); returns the unsubscribe. */
export function onMarginGeometry(view: EditorView, listener: () => void): () => void {
  marginGeometryListeners.set(view, listener);
  return () => {
    if (marginGeometryListeners.get(view) === listener) marginGeometryListeners.delete(view);
  };
}

const marginGeometry = ViewPlugin.define(() => ({
  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged || update.viewportChanged || update.heightChanged) {
      marginGeometryListeners.get(update.view)?.();
    }
  },
}));

/**
 * What margin review (overleaf-margin-review.tsx) needs from the editor: the
 * tint on a card's lines, and word when the lines move. Part of every source
 * editor, so a reconfigured editor keeps it; the layer itself loads only with
 * a linked Overleaf project.
 */
export function marginReviewExtension(): Extension {
  return [
    marginLinkedField,
    marginGeometry,
    EditorView.baseTheme({
      ".cm-margin-linked": { backgroundColor: "color-mix(in srgb, var(--margin-linked) 7%, transparent)" },
      ".cm-margin-linked-span": { backgroundColor: "color-mix(in srgb, var(--margin-linked) 16%, transparent)", borderRadius: "2px" },
    }),
  ];
}
