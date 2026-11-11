/**
 * The source editor's switch into Visual mode for a .tex file. The editor
 * always carries the compartment, empty in Source; Visual fills it with the
 * extension from `./visual/`, which loads on first use so Source never pays
 * for it. Filling or emptying the compartment is a reconfigure of that slot
 * alone: the document, its undo history, the selection and every other
 * extension (the linters, Overleaf's layers, comments) stay as they were, and
 * the transaction carries no change, so nothing reaches a save or sync.
 */
import { Compartment, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { latexView, subscribeLatexView } from "./latex-view-choice";
import type { LatexEditorLiveData } from "./latex-editor";
import type { DefinitionTarget } from "./latex-text";

/** What Visual mode reads from the editor's host when it draws, never while it is built. */
export type LatexVisualHost = {
  /** The project data the LaTeX editor reads: macros, the last build, citations, paths. */
  data: () => LatexEditorLiveData;
  /** A figure's image as a data or asset URL (the reference-image loader), or null when it cannot be read. */
  loadImage: (path: string) => Promise<string | null>;
  /** Follow a link Visual mode draws (an `\input`'s file). */
  open: (target: DefinitionTarget) => void;
  /** A project file's text, for the entry file of an editable figure an `\input` names. */
  readFile?: (path: string) => Promise<string>;
  /** Open the drawing an editable figure's entry file was made from (docs/editable-figures.md). */
  openDrawing?: (entryPath: string) => void;
};

/** The project data Visual mode draws from changed (macros, the last build's numbers, citations): draw again. */
export const latexVisualDataChanged = StateEffect.define<null>();

const compartment = new Compartment();

/**
 * The slot the source editor of a .tex file carries, empty until Visual fills
 * it, and the plugin that keeps it on the writer's choice: applied when the
 * view is built (a document that opens in Visual is drawn in the first
 * microtask, before paint) and again whenever the choice changes. Dispatches
 * wait for a microtask, as none may run inside an update.
 */
export function latexVisualSlot(host: LatexVisualHost): Extension {
  return [compartment.of([]), ViewPlugin.define((view) => {
    let destroyed = false;
    const wantsVisual = () => latexView() === "visual";
    const apply = () => queueMicrotask(() => {
      if (!destroyed) setLatexVisual(view, wantsVisual(), host, () => !destroyed && wantsVisual());
    });
    const unsubscribe = subscribeLatexView(apply);
    apply();
    return {
      destroy() {
        destroyed = true;
        unsubscribe();
      },
    };
  })];
}

// eslint-disable-next-line lingui/no-unlocalized-strings -- module specifier
type VisualModule = typeof import("./visual/latex-visual");
let loaded: VisualModule | null = null;
let loading: Promise<VisualModule> | null = null;
const loadVisual = () => (loading ??= import("./visual/latex-visual").then((module) => (loaded = module)));

/** Whether `state` draws in Visual mode. */
export function isLatexVisual(state: EditorState): boolean {
  const content = compartment.get(state);
  return Array.isArray(content) ? content.length > 0 : content != null;
}

/**
 * Put `view` in Visual mode or back in Source. The first switch to Visual
 * waits for its module; a switch made meanwhile (back to Source, or the view
 * closing) wins, as `current` decides at arrival.
 */
function setLatexVisual(view: EditorView, visual: boolean, host: LatexVisualHost, current: () => boolean): void {
  if (!visual) {
    if (isLatexVisual(view.state)) view.dispatch({ effects: compartment.reconfigure([]) });
    return;
  }
  if (isLatexVisual(view.state)) return;
  const apply = (module: VisualModule) => {
    if (!current() || isLatexVisual(view.state)) return;
    view.dispatch({ effects: compartment.reconfigure(module.latexVisual(host)) });
  };
  if (loaded) apply(loaded);
  else void loadVisual().then(apply, () => {});
}
