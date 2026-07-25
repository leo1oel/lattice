/**
 * Overleaf's suggestions ("track changes"), drawn inline the way Overleaf's
 * own editor draws them: an insertion underlined, a deletion struck through,
 * both tinted with the author's colour. A suggested deletion's text is still
 * in the document at `position` — that is what lets both kinds decorate as
 * ordinary mark ranges, the same trick `editor-comments.ts` uses for a
 * comment's span, rather than one of them needing a widget for text that
 * isn't really there.
 *
 * This module owns exactly that slice — turning a flat `TrackedChange[]`
 * into decorations and a hover card — and deliberately nothing else. It does
 * not know how a suggestion got here, what accepting one does to the
 * document, or who is allowed to accept it; those are
 * `use-overleaf-track-changes.ts`'s job, reached from here only through the
 * `onAccept` / `onReject` callbacks a caller supplies, exactly the way
 * `editor-comments.ts` reaches its own resolve/reply handlers.
 *
 * Every visual rule here is inlined through `EditorView.baseTheme`, not a
 * companion stylesheet — this extension has to work wherever it's dropped
 * in, without depending on a shared CSS file another module already owns.
 */
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { formatCommentTimestamp } from "./editor-comments";
import type { TrackedChange } from "./use-overleaf-realtime";

type ChangeDecorationState = { changes: TrackedChange[]; decorations: DecorationSet };

/** `hsl(hue, 70%, 50%)`, matching how presence carets colour the same hue. */
function hueColor(hue: number): string {
  return `hsl(${hue}, 70%, 50%)`;
}

/** The same hue, softened for a background tint (modern `hsl()` alpha form). */
function hueTint(hue: number, alpha: number): string {
  return `hsl(${hue} 70% 50% / ${alpha})`;
}

/**
 * Clamp a suggestion's `[position, position + text.length)` span into `doc`.
 * `null` when the document has since become shorter than the suggestion
 * expects (stale until the next `reload()`) or the suggested text is empty.
 */
export function trackedChangeRange(doc: Text, change: TrackedChange): { from: number; to: number } | null {
  const from = Math.max(0, Math.min(change.position, doc.length));
  const to = Math.max(from, Math.min(from + change.text.length, doc.length));
  return to > from ? { from, to } : null;
}

/** Context around a suggestion, for a panel to quote — mirrors an editor comment's prefix/quote/suffix. */
export function trackedChangeContext(
  source: string,
  change: TrackedChange,
  context = 32,
): { prefix: string; quote: string; suffix: string } {
  const from = Math.max(0, Math.min(change.position, source.length));
  const to = Math.max(from, Math.min(from + change.text.length, source.length));
  return {
    prefix: source.slice(Math.max(0, from - context), from),
    quote: source.slice(from, to),
    suffix: source.slice(to, Math.min(source.length, to + context)),
  };
}

function changeMarkStyle(change: TrackedChange): string {
  const color = hueColor(change.hue);
  if (change.deletion) {
    return [
      `text-decoration-line: line-through`,
      `text-decoration-color: ${color}`,
      `text-decoration-thickness: 2px`,
      `background-color: ${hueTint(change.hue, 0.1)}`,
    ].join("; ");
  }
  return [
    `border-bottom: 2px solid ${color}`,
    `background-color: ${hueTint(change.hue, 0.14)}`,
  ].join("; ");
}

export function buildTrackedChangeDecorations(doc: Text, changes: TrackedChange[]): DecorationSet {
  const ranges = changes
    .map((change) => {
      const range = trackedChangeRange(doc, change);
      return range && { change, ...range };
    })
    .filter((item): item is { change: TrackedChange; from: number; to: number } => Boolean(item))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  return Decoration.set(
    ranges.map(({ change, from, to }) => Decoration.mark({
      class: change.deletion ? "cm-tracked-change-delete" : "cm-tracked-change-insert",
      attributes: {
        "data-change-id": change.id,
        style: changeMarkStyle(change),
      },
    }).range(from, to)),
    true,
  );
}

/** Suggestions whose span covers `pos` (inclusive start, exclusive end — matches `commentsAtPosition`). */
export function trackedChangesAtPosition(doc: Text, changes: TrackedChange[], pos: number): TrackedChange[] {
  const hits: TrackedChange[] = [];
  for (const change of changes) {
    const range = trackedChangeRange(doc, change);
    if (range && pos >= range.from && pos < range.to) hits.push(change);
  }
  return hits;
}

export type TrackedChangeTooltipActions = {
  /** Display name for a suggestion's author, else "Unknown" — the caller resolves this, not us. */
  authorName: (userId: string | null) => string;
  /**
   * False for a read-only or suggest-only account: Overleaf itself refuses
   * both calls for them. A function, not a plain boolean, so a permission
   * change is picked up even if the extension itself was built once and the
   * host never reconfigures CodeMirror for it — the same reason `getChanges`
   * below is a getter rather than a snapshot.
   */
  canAct: () => boolean;
  onAccept: (change: TrackedChange) => void;
  onReject: (change: TrackedChange) => void;
};

/** One suggestion's row in the hover card: who, what, and the two buttons. */
function appendChangeLine(
  parent: HTMLElement,
  change: TrackedChange,
  actions: TrackedChangeTooltipActions,
  now: number,
): void {
  const item = document.createElement("div");
  item.className = "cm-tracked-change-tooltip-item";

  const head = document.createElement("div");
  head.className = "cm-tracked-change-tooltip-head";
  const dot = document.createElement("span");
  dot.className = "cm-tracked-change-tooltip-dot";
  dot.style.backgroundColor = hueColor(change.hue);
  const author = document.createElement("span");
  author.className = "cm-tracked-change-tooltip-author";
  author.textContent = actions.authorName(change.userId);
  head.append(dot, author);
  if (change.timestamp) {
    const when = document.createElement("span");
    when.className = "cm-tracked-change-tooltip-time";
    when.textContent = formatCommentTimestamp(change.timestamp, now);
    head.appendChild(when);
  }

  const body = document.createElement("div");
  body.className = "cm-tracked-change-tooltip-body";
  body.textContent = change.deletion
    ? `Suggests removing "${change.text}"`
    : `Suggests inserting "${change.text}"`;

  const canAct = actions.canAct();
  const row = document.createElement("div");
  row.className = "cm-tracked-change-tooltip-actions";
  const acceptBtn = document.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.textContent = "Accept";
  acceptBtn.disabled = !canAct;
  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.textContent = "Reject";
  rejectBtn.disabled = !canAct;
  // Keep the hover tooltip alive: a mousedown outside the range would
  // otherwise dismiss it before the click lands (same fix as editor-comments.ts).
  for (const btn of [acceptBtn, rejectBtn]) {
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  acceptBtn.addEventListener("click", (event) => {
    event.preventDefault();
    actions.onAccept(change);
  });
  rejectBtn.addEventListener("click", (event) => {
    event.preventDefault();
    actions.onReject(change);
  });
  row.append(acceptBtn, rejectBtn);

  item.append(head, body, row);
  parent.appendChild(item);
}

export function buildTrackedChangeTooltipDom(
  changes: TrackedChange[],
  actions: TrackedChangeTooltipActions,
  now = Date.now(),
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-tracked-change-tooltip";
  for (const change of changes) appendChangeLine(dom, change, actions, now);
  return dom;
}

export const setTrackedChangesEffect = StateEffect.define<TrackedChange[]>();

export type TrackedChangesExtensionOptions = TrackedChangeTooltipActions & {
  /**
   * Optional live getter so decorations survive a CodeMirror reconfigure
   * (which recreates StateFields with empty create() state) — same pattern
   * as `editor-comments.ts` and `overleaf-cursors.ts`.
   */
  getChanges?: () => TrackedChange[];
};

export function overleafTrackChangesExtension(options: TrackedChangesExtensionOptions): Extension {
  const { getChanges, ...actions } = options;
  const field = StateField.define<ChangeDecorationState>({
    create(state) {
      const changes = getChanges?.() ?? [];
      return { changes, decorations: buildTrackedChangeDecorations(state.doc, changes) };
    },
    update(value, tr) {
      let changes = value.changes;
      let changed = false;
      for (const effect of tr.effects) {
        if (effect.is(setTrackedChangesEffect)) {
          changes = effect.value;
          changed = true;
        }
      }
      if (getChanges) {
        const latest = getChanges();
        if (latest !== changes) {
          changes = latest;
          changed = true;
        }
      }
      // Rebuild on a list change and on every doc edit: positions are plain
      // offsets, not mapped ranges, so a local edit before a suggestion's
      // span leaves it decorating the wrong text until this recomputes it
      // against the new document (accept/reject go further and call the
      // caller's `reload()`, since only the server knows the true new spans).
      if (changed || tr.docChanged) {
        return { changes, decorations: buildTrackedChangeDecorations(tr.state.doc, changes) };
      }
      return value;
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });

  const changeHover = hoverTooltip((view, pos) => {
    const changes = view.state.field(field).changes;
    const hits = trackedChangesAtPosition(view.state.doc, changes, pos);
    if (!hits.length) return null;
    let from = pos;
    let to = pos;
    for (const change of hits) {
      const range = trackedChangeRange(view.state.doc, change);
      if (!range) continue;
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
      create: () => ({
        dom: buildTrackedChangeTooltipDom(hits, actions),
        resize: false,
      }),
    };
  });

  return [
    field,
    changeHover,
    EditorView.baseTheme({
      ".cm-tracked-change-insert, .cm-tracked-change-delete": {
        borderRadius: "2px",
      },
      ".cm-tracked-change-tooltip": {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "320px",
        font: "12px/1.4 var(--ui-font, sans-serif)",
      },
      ".cm-tracked-change-tooltip-item": { display: "flex", flexDirection: "column", gap: "4px" },
      ".cm-tracked-change-tooltip-item + .cm-tracked-change-tooltip-item": {
        paddingTop: "8px",
        borderTop: "1px solid rgba(128, 128, 128, .25)",
      },
      ".cm-tracked-change-tooltip-head": { display: "flex", alignItems: "center", gap: "6px" },
      ".cm-tracked-change-tooltip-dot": {
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        flex: "0 0 auto",
      },
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
