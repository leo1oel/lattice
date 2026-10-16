/**
 * Find and replace in the visual engine (spec R-CHR-3). Mod-F opens a local
 * "Find in document" bar; Mod-Shift-F is left to project search. Matching is
 * case-insensitive over the text of each block, with every match highlighted
 * and the current one marked; Enter moves to the next. Mod-Alt-F opens the
 * bar with Replace showing and seeds the query from a short selection.
 * Escape closes the bar, clears the highlights and returns to the editor.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the find plugin and its bar belong together */
import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, isMacOS, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import { popupMotionClassName } from "../../../../components/ui/popup-motion";
import { drawnRanges, revealPosition } from "../block-window";
import { changedBlockRanges } from "../changed-ranges";
import type { ChromeHost } from "./chrome-host";

type Match = { from: number; to: number };
/**
 * The match index: every match in document order, apart from what is drawn.
 * A one-letter query in a long document has a match for every few characters
 * (170,000 in 2 MB), which is cheap to find and to count, but far too many
 * to build decorations for on every keystroke and every step to the next one.
 */
type FindState = { query: string; matches: readonly Match[]; current: number };

const findKey = new PluginKey<FindState>("latticeFind");
const EMPTY: FindState = { query: "", matches: [], current: 0 };
/** An edit of more steps than this (Replace All) searches the document again rather than mapping every match through each step. */
const MAX_MAPPED_STEPS = 8;

const needleFor = (query: string) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");

/** Every match of `needle` in one textblock at `position`, appended to `matches`. */
function matchTextblock(node: PmNode, position: number, needle: RegExp, matches: Match[]) {
  // One string per text run, so a match never spans an atom or a line break node.
  let run = "";
  let runStart = -1;
  const flush = () => {
    if (!run) return;
    for (const match of run.matchAll(needle)) {
      matches.push({ from: runStart + match.index, to: runStart + match.index + match[0].length });
    }
    run = "";
  };
  node.forEach((child, offset) => {
    if (child.isText) {
      if (!run) runStart = position + 1 + offset;
      run += child.text;
    } else {
      flush();
    }
  });
  flush();
}

/** Every case-insensitive occurrence of `query` in the text of the document's blocks, or of those in `from`…`to`. */
function findMatches(doc: PmNode, query: string, from = 0, to = doc.content.size, matches: Match[] = []): Match[] {
  if (!query) return matches;
  const needle = needleFor(query);
  doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return true;
    matchTextblock(node, position, needle, matches);
    return false;
  });
  return matches;
}

/** The index of the first match ending after `pos`. */
function firstAfter(matches: readonly Match[], pos: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (matches[middle]!.to <= pos) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The matches after an edit: those in blocks it did not touch, moved with
 * the edit, and the touched blocks searched again. A keystroke in a long
 * document with Find open searches one block, not the whole document.
 */
function remapMatches(transaction: Transaction, state: FindState): Match[] {
  const { doc, mapping } = transaction;
  if (transaction.steps.length > MAX_MAPPED_STEPS) return findMatches(doc, state.query);
  const changed = changedBlockRanges(transaction).sort((a, b) => a.from - b.from);
  const matches: Match[] = [];
  let index = 0;
  const moved = state.matches.flatMap((match) => {
    const from = mapping.map(match.from, 1);
    const to = mapping.map(match.to, -1);
    // A match whose text was deleted collapses to a point.
    if (to <= from) return [];
    return from === match.from && to === match.to ? [match] : [{ from, to }];
  });
  let searched = 0;
  for (const range of changed) {
    const from = Math.max(range.from, searched);
    if (range.to <= from) continue;
    while (index < moved.length && moved[index]!.to <= from) matches.push(moved[index++]!);
    // Every match inside a touched block is found again.
    while (index < moved.length && moved[index]!.from < range.to) index += 1;
    findMatches(doc, state.query, from, range.to, matches);
    searched = range.to;
  }
  while (index < moved.length) matches.push(moved[index++]!);
  return matches;
}

/** The highlights for the matches in `ranges` (the drawn blocks), or for all of them while every block is drawn. */
function decorate(doc: PmNode, matches: readonly Match[], current: number, ranges: readonly { from: number; to: number }[] | null): DecorationSet {
  const decorations: Decoration[] = [];
  const add = (from: number, to: number) => {
    for (let index = firstAfter(matches, from); index < matches.length && matches[index]!.from < to; index += 1) {
      const match = matches[index]!;
      decorations.push(Decoration.inline(match.from, match.to, {
        class: index === current ? "lx-md-find-match is-current" : "lx-md-find-match",
      }));
    }
  };
  if (ranges) for (const range of ranges) add(range.from, range.to);
  else add(0, doc.content.size);
  return DecorationSet.create(doc, decorations);
}

function withQuery(doc: PmNode, query: string, near: number): FindState {
  const matches = findMatches(doc, query);
  return { query, matches, current: Math.max(0, matches.findIndex((match) => match.from >= near)) };
}

export const FindReplace = Extension.create({
  name: "latticeFindReplace",
  addProseMirrorPlugins: () => {
    // The highlights last drawn, rebuilt only when the matches, the current
    // one or the drawn blocks change.
    let drawn: { find: FindState; ranges: ReturnType<typeof drawnRanges>; decorations: DecorationSet } | null = null;
    return [new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => EMPTY,
        apply(transaction, state) {
          const meta = transaction.getMeta(findKey) as { query?: string; current?: number } | undefined;
          if (meta?.query !== undefined) return withQuery(transaction.doc, meta.query, transaction.selection.from);
          if (meta?.current !== undefined) return { ...state, current: meta.current };
          if (transaction.docChanged && state.query) {
            const matches = remapMatches(transaction, state);
            // The current match stays the one it was, or the next after where it was.
            const was = state.matches[state.current];
            const near = was ? firstAfter(matches, transaction.mapping.map(was.from, -1)) : state.current;
            return { ...state, matches, current: Math.min(near, Math.max(matches.length - 1, 0)) };
          }
          return state;
        },
      },
      props: {
        decorations(editorState) {
          const find = findKey.getState(editorState) ?? EMPTY;
          if (!find.matches.length) return DecorationSet.empty;
          const ranges = drawnRanges(editorState);
          if (drawn?.find !== find || drawn.ranges !== ranges) {
            drawn = { find, ranges, decorations: decorate(editorState.doc, find.matches, find.current, ranges) };
          }
          return drawn.decorations;
        },
      },
    })];
  },
});

const findState = (state: EditorState) => findKey.getState(state) ?? EMPTY;

function select(editor: Editor, index: number) {
  const state = findState(editor.state);
  const match = state.matches[index];
  const transaction = editor.state.tr.setMeta(findKey, { current: index });
  if (match) transaction.setSelection(TextSelection.create(editor.state.doc, match.from, match.to));
  editor.view.dispatch(transaction);
  // Centered, like every other jump; without layout the plain reveal stands in.
  if (match && !revealPosition(editor.view, match.from)) editor.view.dispatch(editor.state.tr.scrollIntoView());
}

/**
 * Mod-F and Mod-Alt-F in the editor, read-only documents included (so not a
 * keymap, which ProseMirror skips while read-only); the host's Mod-Shift-F
 * passes through.
 */
export function findShortcuts(host: ChromeHost) {
  return Extension.create({
    name: "latticeFindShortcuts",
    addProseMirrorPlugins: () => [
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown: (view, event) => {
              const mod = isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
              if (!mod || event.shiftKey || (event.code !== "KeyF" && event.key.toLowerCase() !== "f")) return false;
              event.preventDefault();
              if (!event.altKey) {
                host.ask({ kind: "find", replace: false, seed: "" });
                return true;
              }
              const { from, to } = view.state.selection;
              const selected = view.state.doc.textBetween(from, to, " ");
              host.ask({ kind: "find", replace: true, seed: selected.length <= 80 && !selected.includes("\n") ? selected : "" });
              return true;
            },
          },
        },
      }),
    ],
  });
}

export function FindBar({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [, rerender] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // A find request (Mod-F, Mod-Alt-F) opens the bar and hands it the seed.
  useEffect(() => host.subscribe(() => {
    const request = host.request;
    if (request?.kind !== "find") return;
    host.clear();
    setOpen(true);
    if (request.replace) setShowReplace(true);
    if (request.seed) setQuery(request.seed);
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    });
  }), [host]);

  useEffect(() => {
    if (!open) return;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query }));
  }, [editor, open, query]);

  useEffect(() => {
    const update = () => rerender((value) => value + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!open) return null;
  const state = findState(editor.state);
  const total = state.matches.length;
  const current = total ? state.current + 1 : 0;
  const count = total;
  const step = (direction: 1 | -1) => {
    if (!total) return;
    select(editor, (state.current + direction + total) % total);
  };
  const close = () => {
    setOpen(false);
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: "" }));
    editor.view.focus();
  };
  const replaceCurrent = () => {
    const match = state.matches[state.current];
    if (!match || !editor.isEditable) return;
    const transaction: Transaction = editor.state.tr.insertText(replacement, match.from, match.to);
    editor.view.dispatch(transaction);
  };
  const replaceAll = () => {
    if (!total || !editor.isEditable) return;
    const transaction = editor.state.tr;
    for (const match of [...state.matches].reverse()) transaction.insertText(replacement, match.from, match.to);
    editor.view.dispatch(transaction);
  };
  return (
    <div className={`lx-md-find ${popupMotionClassName}`} role="search" aria-label={t`Find in document`}>
      <div className="lx-md-find-row">
        <IconButton size="compact" tooltip={false} label={t`Show replace`} aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>
          <ChevronDown aria-hidden="true" className={showReplace ? "is-open" : undefined} />
        </IconButton>
        <input
          ref={input}
          type="search"
          className="lx-md-find-input"
          aria-label={t`Find`}
          placeholder={t`Find`}
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <span className="lx-md-find-status" role="status">{query ? (total ? t`${current} of ${count}` : t`No matches`) : ""}</span>
        <IconButton size="compact" tooltip={false} label={t`Previous match`} disabled={!total} onClick={() => step(-1)}>
          <ChevronUp aria-hidden="true" />
        </IconButton>
        <IconButton size="compact" tooltip={false} label={t`Next match`} disabled={!total} onClick={() => step(1)}>
          <ChevronDown aria-hidden="true" />
        </IconButton>
        <IconButton size="compact" tooltip={false} label={t`Close find`} onClick={close}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
      {showReplace && (
        <div className="lx-md-find-row">
          <span className="lx-md-find-spacer" aria-hidden="true" />
          <input
            type="text"
            className="lx-md-find-input"
            aria-label={t`Replace with`}
            placeholder={t`Replace`}
            value={replacement}
            spellCheck={false}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                replaceCurrent();
              }
            }}
          />
          <IconButton size="compact" tooltip={false} label={t`Replace current match`} disabled={!total || !editor.isEditable} onClick={replaceCurrent}>
            <Replace aria-hidden="true" />
          </IconButton>
          <IconButton size="compact" tooltip={false} label={t`Replace all matches`} disabled={!total || !editor.isEditable} onClick={replaceAll}>
            <ReplaceAll aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
