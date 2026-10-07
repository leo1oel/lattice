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
 * top and how far into it the view was, and the next view of the document
 * resumes from them. A parked state is inert data, unlike a hidden live view,
 * which would keep its plugins (lint, spellcheck, observers) running.
 *
 * The document is read again on the way back and may have changed meanwhile
 * (another program, an agent, a sync): the parked state takes the change in,
 * and its place and selection follow it. A fresh state would start at the
 * top, with the saved pixel offset put back only a frame later, on other lines.
 */
import { EditorState, StateEffect, Transaction, type Extension, type Text } from "@codemirror/state";
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
 * The state parked for `path` with `doc` as its text, configured with
 * `extensions`, and the scroll effect to build its view with
 * (`EditorViewConfig.scrollTo`), or nothing when none is parked.
 */
export function resumeParkedEditor(root: string, path: string, doc: string, extensions: Extension) {
  let entry = parked.get(keyOf(root, path));
  if (!entry) return null;
  // Compared as CodeMirror holds it: a file with CRLF (or CR) line breaks is
  // read with them, but its state joins its lines with "\n".
  const text = doc.includes("\r") ? doc.replace(/\r\n?/g, "\n") : doc;
  entry.text ??= entry.state.doc.toString();
  if (entry.text !== text) {
    const changes = entry.state.changes(difference(entry.text, text));
    // Taken in once, in place of the old state, for the tab's snapshot and
    // then its live editor alike. A parse context hands its skipped ranges to
    // the one a change makes from it, so a second change from the old state
    // mapped ranges the first one's parse had added, past the old end, and threw.
    entry = {
      root, path, text,
      // Not an undo step of the writer's: their own edits stay undoable, mapped through it.
      state: entry.state.update({ changes, annotations: Transaction.addToHistory.of(false) }).state,
      scroll: entry.scroll?.map(changes) ?? null,
    };
    parked.set(keyOf(root, path), entry);
  }
  return {
    state: entry.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state,
    scrollTo: entry.scroll ?? undefined,
  };
}

/** The one replacement turning `previous` into `next`: what they share at either end stays put. */
function difference(previous: string, next: string) {
  const shorter = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shorter && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let kept = 0;
  while (kept < shorter - from && previous.charCodeAt(previous.length - 1 - kept) === next.charCodeAt(next.length - 1 - kept)) kept += 1;
  return { from, to: previous.length - kept, insert: next.slice(from, next.length - kept) };
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
