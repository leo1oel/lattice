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
import { Decoration, EditorView, hoverTooltip, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { formatCommentTimestamp } from "../editor/comments/editor-comments";
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

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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

/** PresenceCursor speaks HSL hues; collab peers carry hex colors. */
export function hueFromColorHex(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 210;
  const value = parseInt(match[1]!, 16);
  const [r, g, b] = [16, 8, 0].map((shift) => ((value >> shift) & 255) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (!delta) return 0;
  const hue = 60 * (max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4);
  return hue < 0 ? hue + 360 : hue;
}

const REMOTE_CARET_SELECTOR = ".cm-ySelectionCaret, .cm-overleaf-caret";
const REMOTE_LABEL_SELECTOR = ".cm-ySelectionInfo, .cm-overleaf-caret-label";

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
    const label = element("span", "cm-overleaf-caret-label", this.name || "Anonymous");
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

/** A suggestion's `[position, position + text.length)` span, clamped into a document of `length`. */
function clampedSpan(change: TrackedChange, length: number) {
  const from = Math.max(0, Math.min(change.position, length));
  return { from, to: Math.max(from, Math.min(from + change.text.length, length)) };
}

/**
 * A suggestion's span in `doc`, or null when the document has since become
 * shorter than the suggestion expects (stale until the next `reload()`) or the
 * suggested text is empty. A suggested deletion's text is still in the
 * document, which is what lets both kinds decorate as ordinary mark ranges.
 */
export function trackedChangeRange(doc: Text, change: TrackedChange): { from: number; to: number } | null {
  const range = clampedSpan(change, doc.length);
  return range.to > range.from ? range : null;
}

/** Context around a suggestion, for a panel to quote — mirrors an editor comment's prefix/quote/suffix. */
export function trackedChangeContext(source: string, change: TrackedChange, context = 32) {
  const { from, to } = clampedSpan(change, source.length);
  return {
    prefix: source.slice(Math.max(0, from - context), from),
    quote: source.slice(from, to),
    suffix: source.slice(to, Math.min(source.length, to + context)),
  };
}

export function buildTrackedChangeDecorations(doc: Text, changes: TrackedChange[]): DecorationSet {
  const ranges = changes
    .flatMap((change) => {
      const range = trackedChangeRange(doc, change);
      return range ? [{ change, ...range }] : [];
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges.map(({ change, from, to }) => Decoration.mark({
    class: change.deletion ? "cm-tracked-change-delete" : "cm-tracked-change-insert",
    attributes: {
      "data-change-id": change.id,
      style: change.deletion
        ? `text-decoration-line: line-through; text-decoration-color: ${hueColor(change.hue)}; text-decoration-thickness: 2px; background-color: ${hueColor(change.hue, 0.1)}`
        : `border-bottom: 2px solid ${hueColor(change.hue)}; background-color: ${hueColor(change.hue, 0.14)}`,
    },
  }).range(from, to)), true);
}

/** Suggestions whose span covers `pos` (inclusive start, exclusive end — matches `commentsAtPosition`). */
export function trackedChangesAtPosition(doc: Text, changes: TrackedChange[], pos: number): TrackedChange[] {
  return changes.filter((change) => {
    const range = trackedChangeRange(doc, change);
    return range && pos >= range.from && pos < range.to;
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
    const body = element("div", "cm-tracked-change-tooltip-body", change.deletion
      ? `Suggests removing "${change.text}"`
      : `Suggests inserting "${change.text}"`);
    const row = element("div", "cm-tracked-change-tooltip-actions");
    for (const [label, act] of [["Accept", actions.onAccept], ["Reject", actions.onReject]] as const) {
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
        font: "var(--type-label-size)/1.4 var(--ui-font, sans-serif)",
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
