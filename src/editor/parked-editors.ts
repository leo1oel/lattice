/**
 * Source editors parked while their tab is in the background, so switching
 * back finds the document exactly as it was left.
 *
 * The canvas has one live CodeMirror view and rebuilds it for every document
 * it shows, and a background tab's read-only snapshot is a view of its own.
 * Built from text, a view comes back wrong three ways: a pixel `scrollTop`
 * lands on other lines, because the heights above the viewport are now
 * estimates (wrapped paragraphs most of all), not the measured ones the pixel
 * was taken against; the selection is gone; and the syntax is parsed only to
 * the first few thousand characters, so text further down shows uncoloured
 * until CodeMirror's idle parse runs (WKWebView has no `requestIdleCallback`,
 * so that waits out a 500 ms timer).
 *
 * So a view about to be destroyed parks its whole `EditorState` (selection,
 * undo history, parse tree) with a scroll snapshot that names the line at the
 * top and how far into it the view was, and the next view of the same text
 * resumes from them. A parked state is inert data, unlike a hidden live view,
 * which would keep its plugins (lint, spellcheck, observers) running.
 */
import { EditorState, StateEffect, type Extension, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type Parked = {
  root: string;
  path: string;
  state: EditorState;
  /** Where the view was scrolled (`EditorView.scrollSnapshot`), if it was ever laid out. */
  scroll: StateEffect<unknown> | null;
  /** The parked document as a string, made once and only when first compared. */
  text?: string;
};

const parked = new Map<string, Parked>();
const keyOf = (root: string, path: string) => `${root}\n${path}`;

/** Keep `state`, scrolled as `scroll` says, for the next view of `path` in the project at `root`. */
export function parkEditor(root: string, path: string, state: EditorState, scroll: StateEffect<unknown> | null) {
  parked.set(keyOf(root, path), { root, path, state, scroll });
}

/**
 * The state parked for `path`, configured with `extensions`, and the scroll
 * effect to build its view with (`EditorViewConfig.scrollTo`) — or nothing
 * when none is parked or the text has changed since (a reload, an agent or
 * collaborator edit), where a fresh state is the honest start.
 */
export function resumeParkedEditor(root: string, path: string, doc: string, extensions: Extension) {
  const entry = parked.get(keyOf(root, path));
  // Compared as CodeMirror holds it: a file with CRLF (or CR) line breaks is
  // read with them, but its state joins its lines with "\n". Taken as changed,
  // such a file never resumed and came back by the saved pixel offset instead.
  const text = doc.includes("\r") ? doc.replace(/\r\n?/g, "\n") : doc;
  if (!entry || entry.state.doc.length !== text.length) return null;
  entry.text ??= entry.state.doc.toString();
  if (entry.text !== text) return null;
  return {
    state: entry.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state,
    scrollTo: entry.scroll ?? undefined,
  };
}

/** Views built from a parked state, with the document they resumed. */
const resumedViews = new WeakMap<EditorView, Text>();

/** `view` was built from a parked state (see `resumeParkedEditor`). */
export function noteResumed(view: EditorView) {
  resumedViews.set(view, view.state.doc);
}

/**
 * Whether `view` came back from a parked state, already where it was left,
 * and its text is untouched since — answered once: after that (or after a
 * reload or remote edit) a saved view is worth restoring again.
 */
export function takeResumed(view: EditorView) {
  const doc = resumedViews.get(view);
  resumedViews.delete(view);
  return doc !== undefined && doc === view.state.doc;
}

/** Drop what was parked for anything but the open `paths` of the project at `root`. */
export function retainParkedEditors(root: string | null, paths: readonly string[]) {
  const open = new Set(paths);
  for (const [key, entry] of parked) {
    if (entry.root !== root || !open.has(entry.path)) parked.delete(key);
  }
}
