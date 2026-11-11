/**
 * How .tex documents draw in their editor, Source or Visual: one choice for
 * every .tex file, as Overleaf keeps it, shared by every window and apart
 * from Markdown's views (a Markdown note shown as its preview never turns a
 * .tex file Visual). Source until the writer picks Visual.
 *
 * Only the panel header's switch, its menu and the source editor read it,
 * all of which load after startup, so the choice costs the startup bundle
 * nothing.
 */
import { useSyncExternalStore } from "react";
import { loadChoice } from "../../settings/app-settings";
import { sharedSetting } from "../../settings/shared-setting";

export type LatexView = "source" | "visual";

/** A LaTeX document, which has a Visual form beside its source (packages and classes are code). */
export const isLatexDocumentPath = (path: string) => /\.tex$/i.test(path);

export const LATEX_VIEW_KEY = "lattice.latex-view.v1";

const choice = sharedSetting<LatexView>(
  LATEX_VIEW_KEY,
  () => loadChoice<LatexView>(LATEX_VIEW_KEY, ["source", "visual"], "source"),
  { serialize: (view) => view },
);

/** The writer's choice for .tex documents. */
export const latexView = (): LatexView => choice.get();

/** Choose how .tex documents draw; every open one follows, in every window, and the choice is remembered. */
export const chooseLatexView = (view: LatexView): void => choice.set(view);

/** Calls `listener` whenever the choice changes; returns the unsubscribe. */
export const subscribeLatexView = (listener: () => void): (() => void) => choice.subscribe(listener);

/** The choice, kept current in a component. */
export function useLatexView(): LatexView {
  return useSyncExternalStore(choice.subscribe, choice.get);
}
