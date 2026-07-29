/**
 * Other people's carets, drawn in the editor.
 *
 * This owns exactly one thing: turning `{name, hue, row, column}` into a thin
 * caret with an always-visible name tag, in the style of this app's own live
 * collaboration cursors. It knows nothing about Overleaf, sockets, or where
 * the list comes from — the caller (the presence hook, filtered to whichever
 * document is open) hands over a plain array, and a CodeMirror reconfigure
 * (which recreates StateFields from scratch) is survived the same way
 * `editor-comments.ts` survives one: an optional live getter re-read on every
 * transaction.
 */
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";

export type PresenceCursor = {
  name: string;
  hue: number;
  row: number;
  column: number;
};

const REMOTE_CARET_SELECTOR = ".cm-ySelectionCaret, .cm-overleaf-caret";
const REMOTE_LABEL_SELECTOR = ".cm-ySelectionInfo, .cm-overleaf-caret-label";

type CursorLabelPlacement = { caret: HTMLElement; below: boolean };

/** Measure without writing so CodeMirror can batch this with its own layout work. */
export function measureCursorLabelPlacements(view: EditorView): CursorLabelPlacement[] {
  const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
  return Array.from(view.dom.querySelectorAll<HTMLElement>(REMOTE_CARET_SELECTOR)).flatMap((caret) => {
    const label = caret.querySelector<HTMLElement>(REMOTE_LABEL_SELECTOR);
    if (!label) return [];
    const caretTop = caret.getBoundingClientRect().top;
    const labelHeight = label.getBoundingClientRect().height;
    return [{ caret, below: caretTop - labelHeight < scrollerTop + 2 }];
  });
}

class CursorLabelPlacementPlugin {
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
        for (const { caret, below } of placements) {
          caret.classList.toggle("cm-caret-label-below", below);
        }
      },
    });
  }
}

const cursorLabelPlacementExtension = ViewPlugin.fromClass(CursorLabelPlacementPlugin, {
  eventObservers: {
    scroll() {
      this.schedule();
    },
  },
});

/** Clamp a zero-based (row, column) to a real offset in `doc`. */
export function posForRowColumn(doc: Text, row: number, column: number): number {
  const lineNumber = Math.min(Math.max(row, 0) + 1, doc.lines);
  const line = doc.line(lineNumber);
  const col = Math.min(Math.max(column, 0), line.length);
  return line.from + col;
}

class PresenceCaretWidget extends WidgetType {
  constructor(private readonly name: string, private readonly color: string) {
    super();
  }

  eq(other: PresenceCaretWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-overleaf-caret";
    wrap.style.borderColor = this.color;
    const dot = document.createElement("span");
    dot.className = "cm-overleaf-caret-dot";
    dot.style.backgroundColor = this.color;
    const label = document.createElement("span");
    label.className = "cm-overleaf-caret-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name || "Anonymous";
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
  if (!cursors.length) return Decoration.none;
  return Decoration.set(
    cursors.map((cursor) => Decoration.widget({
      widget: new PresenceCaretWidget(cursor.name, `hsl(${cursor.hue}, 70%, 50%)`),
      side: 1,
    }).range(posForRowColumn(doc, cursor.row, cursor.column))),
    true,
  );
}

export const setOverleafCursorsEffect = StateEffect.define<PresenceCursor[]>();

type PresenceCursorState = { cursors: PresenceCursor[]; decorations: DecorationSet };

export type OverleafCursorsOptions = {
  /**
   * Optional live getter so decorations survive a CodeMirror reconfigure
   * (which recreates StateFields with empty create() state).
   */
  getCursors?: () => PresenceCursor[];
};

export function overleafCursorsExtension(options: OverleafCursorsOptions = {}): Extension {
  const { getCursors } = options;
  const field = StateField.define<PresenceCursorState>({
    create(state) {
      const cursors = getCursors?.() ?? [];
      return { cursors, decorations: buildPresenceCursorDecorations(state.doc, cursors) };
    },
    update(value, tr) {
      let cursors = value.cursors;
      let changed = false;
      for (const effect of tr.effects) {
        if (effect.is(setOverleafCursorsEffect)) {
          cursors = effect.value;
          changed = true;
        }
      }
      if (getCursors) {
        const latest = getCursors();
        if (latest !== cursors) {
          cursors = latest;
          changed = true;
        }
      }
      // Rebuild on a roster change and on every doc edit, so a widget never
      // lingers at an offset a local edit has already moved out from under it
      // (peers re-anchor once their own next position arrives).
      if (changed || tr.docChanged) {
        return { cursors, decorations: buildPresenceCursorDecorations(tr.state.doc, cursors) };
      }
      return value;
    },
    provide: (value) => EditorView.decorations.from(value, (state) => state.decorations),
  });

  return [
    field,
    cursorLabelPlacementExtension,
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
        font: "600 10px/1.2 var(--ui-font, sans-serif)",
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
