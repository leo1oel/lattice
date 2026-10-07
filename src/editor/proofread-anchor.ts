import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import { LATEX_SHORTCUTS } from "./latex/latex-shortcuts";

/**
 * Where an inline proofread sits: the source span it would replace, mapped
 * through every edit, and the element the host renders the card into. The
 * card is a block widget under the span's last line, so it pushes the text
 * below it down instead of floating over it.
 */
export type ProofreadAnchor = { from: number; to: number; host: HTMLElement };

export const setProofreadAnchorEffect = StateEffect.define<ProofreadAnchor | null>();

/** The host's actions; each answers whether it handled the key. */
export type ProofreadKeyHandlers = {
  /** ⌘⌥P: proofread the selection. */
  request: (view: EditorView) => boolean;
  /** ⌘↵ while a suggestion is shown. */
  accept: (view: EditorView) => boolean;
  /** Escape while a proofread is open. */
  dismiss: (view: EditorView) => boolean;
};

class ProofreadCardWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }

  eq(other: ProofreadCardWidget) {
    return other.host === this.host;
  }

  // The host element outlives widget DOM: CodeMirror redraws a block widget
  // that scrolls out of and back into the viewport, and the React portal
  // inside must keep its state across that.
  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-proofread-block";
    wrapper.append(this.host);
    return wrapper;
  }

  get estimatedHeight() {
    return this.host.offsetHeight || 96;
  }

  // Buttons, the diff and its text selection belong to the card, not the editor.
  ignoreEvent() {
    return true;
  }
}

function decorations(state: EditorState, anchor: ProofreadAnchor): DecorationSet {
  // A selection ending in a line break ends at the next line's start; the card
  // still belongs under the last line that holds selected text.
  const lastLine = state.doc.lineAt(anchor.to > anchor.from ? anchor.to - 1 : anchor.to);
  const ranges = [Decoration.widget({ widget: new ProofreadCardWidget(anchor.host), block: true, side: 1 }).range(lastLine.to)];
  if (anchor.to > anchor.from) ranges.unshift(Decoration.mark({ class: "cm-proofread-source" }).range(anchor.from, anchor.to));
  return Decoration.set(ranges, true);
}

const proofreadField = StateField.define<{ anchor: ProofreadAnchor | null; decorations: DecorationSet }>({
  create: () => ({ anchor: null, decorations: Decoration.none }),
  update(value, tr) {
    let anchor = value.anchor;
    if (anchor && tr.docChanged) {
      // Text typed at either edge stays outside the span the card replaces.
      const from = tr.changes.mapPos(anchor.from, 1);
      anchor = { ...anchor, from, to: Math.max(from, tr.changes.mapPos(anchor.to, -1)) };
    }
    for (const effect of tr.effects) if (effect.is(setProofreadAnchorEffect)) anchor = effect.value;
    if (anchor === value.anchor) return value;
    return { anchor, decorations: anchor ? decorations(tr.state, anchor) : Decoration.none };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The open proofread's current span in `state`, or null. */
export function proofreadAnchor(state: EditorState): ProofreadAnchor | null {
  return state.field(proofreadField, false)?.anchor ?? null;
}

export function proofreadExtension(handlers: ProofreadKeyHandlers): Extension {
  const open = (run: (view: EditorView) => boolean) => (view: EditorView) => proofreadAnchor(view.state) !== null && run(view);
  return [
    proofreadField,
    // Above the editor's own Escape (closing completion, the search panel) and
    // ⌘↵ only while a card is open; otherwise they fall through untouched.
    Prec.high(keymap.of([
      { key: LATEX_SHORTCUTS.proofread.key, run: (view) => handlers.request(view) },
      { key: "Mod-Enter", run: open(handlers.accept) },
      { key: "Escape", run: open(handlers.dismiss) },
    ])),
  ];
}
