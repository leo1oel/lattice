import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";

/**
 * Where an annotation's proposal is reviewed: the annotated span, mapped
 * through every edit, and the element the host renders the review card into.
 * Like the proofread card, it is a block widget under the span's last line,
 * so it pushes the text below it down instead of covering it.
 */
export type AnnotationReviewAnchor = { id: string; from: number; to: number; host: HTMLElement };

export const setAnnotationReviewEffect = StateEffect.define<AnnotationReviewAnchor | null>();

class ReviewCardWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }

  eq(other: ReviewCardWidget) {
    return other.host === this.host;
  }

  // The host outlives widget DOM, so the card's React state survives the
  // widget scrolling out of the viewport and back.
  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-annotation-review-block";
    wrapper.append(this.host);
    return wrapper;
  }

  get estimatedHeight() {
    return this.host.offsetHeight || 160;
  }

  ignoreEvent() {
    return true;
  }
}

function decorations(state: EditorState, anchor: AnnotationReviewAnchor): DecorationSet {
  const lastLine = state.doc.lineAt(anchor.to > anchor.from ? anchor.to - 1 : anchor.to);
  const ranges = [Decoration.widget({ widget: new ReviewCardWidget(anchor.host), block: true, side: 1 }).range(lastLine.to)];
  if (anchor.to > anchor.from) ranges.unshift(Decoration.mark({ class: "cm-annotation-review-source" }).range(anchor.from, anchor.to));
  return Decoration.set(ranges, true);
}

const reviewField = StateField.define<{ anchor: AnnotationReviewAnchor | null; decorations: DecorationSet }>({
  create: () => ({ anchor: null, decorations: Decoration.none }),
  update(value, tr) {
    let anchor = value.anchor;
    if (anchor && tr.docChanged) {
      const from = tr.changes.mapPos(anchor.from, 1);
      anchor = { ...anchor, from, to: Math.max(from, tr.changes.mapPos(anchor.to, -1)) };
    }
    for (const effect of tr.effects) if (effect.is(setAnnotationReviewEffect)) anchor = effect.value;
    if (anchor === value.anchor) return value;
    return { anchor, decorations: anchor ? decorations(tr.state, anchor) : Decoration.none };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The proposal under review in `state`, or null. */
export function annotationReviewAnchor(state: EditorState): AnnotationReviewAnchor | null {
  return state.field(reviewField, false)?.anchor ?? null;
}

/** The host's answers to the editor's keys while a card is open; each says whether it handled one. */
export type AnnotationReviewKeys = { accept: () => boolean; dismiss: () => boolean };

export function annotationReviewExtension(keys: AnnotationReviewKeys): Extension {
  const open = (run: () => boolean) => (view: EditorView) => annotationReviewAnchor(view.state) !== null && run();
  return [
    reviewField,
    // ⌘↵ and Escape only while a card is open; otherwise they fall through.
    Prec.high(keymap.of([
      { key: "Mod-Enter", run: open(keys.accept) },
      { key: "Escape", run: open(keys.dismiss) },
    ])),
  ];
}
