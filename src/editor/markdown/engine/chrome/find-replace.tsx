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
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, isMacOS, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import type { ChromeHost } from "./chrome-host";

type Match = { from: number; to: number };
type FindState = { query: string; matches: Match[]; current: number; decorations: DecorationSet };

const findKey = new PluginKey<FindState>("latticeFind");
const EMPTY: FindState = { query: "", matches: [], current: 0, decorations: DecorationSet.empty };

/** Every case-insensitive occurrence of `query` in the text of the document's blocks. */
function findMatches(doc: PmNode, query: string): Match[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const matches: Match[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    // One string per text run, so a match never spans an atom or a line break node.
    let run = "";
    let runStart = -1;
    const flush = () => {
      if (!run) return;
      const haystack = run.toLocaleLowerCase();
      for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
        matches.push({ from: runStart + index, to: runStart + index + needle.length });
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
    return false;
  });
  return matches;
}

function decorate(doc: PmNode, matches: Match[], current: number): DecorationSet {
  return DecorationSet.create(doc, matches.map((match, index) => Decoration.inline(match.from, match.to, {
    class: index === current ? "lx-md-find-match is-current" : "lx-md-find-match",
  })));
}

function withQuery(doc: PmNode, query: string, near: number): FindState {
  const matches = findMatches(doc, query);
  const current = Math.max(0, matches.findIndex((match) => match.from >= near));
  return { query, matches, current, decorations: decorate(doc, matches, current) };
}

export const FindReplace = Extension.create({
  name: "latticeFindReplace",
  addProseMirrorPlugins: () => [new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => EMPTY,
      apply(transaction, state) {
        const meta = transaction.getMeta(findKey) as { query?: string; current?: number } | undefined;
        if (meta?.query !== undefined) return withQuery(transaction.doc, meta.query, transaction.selection.from);
        if (meta?.current !== undefined) return { ...state, current: meta.current, decorations: decorate(transaction.doc, state.matches, meta.current) };
        if (transaction.docChanged && state.query) {
          const matches = findMatches(transaction.doc, state.query);
          const current = Math.min(state.current, Math.max(matches.length - 1, 0));
          return { ...state, matches, current, decorations: decorate(transaction.doc, matches, current) };
        }
        return state;
      },
    },
    props: { decorations: (state) => findKey.getState(state)?.decorations },
  })],
});

const findState = (state: EditorState) => findKey.getState(state) ?? EMPTY;

function select(editor: Editor, index: number) {
  const state = findState(editor.state);
  const match = state.matches[index];
  const transaction = editor.state.tr.setMeta(findKey, { current: index });
  if (match) transaction.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView();
  editor.view.dispatch(transaction);
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
  const request = useSyncExternalStore(host.subscribe, () => host.request, () => host.request);
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [, rerender] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // A find request (Mod-F, Mod-Alt-F) opens the bar and hands it the seed.
  useLayoutEffect(() => {
    if (request?.kind !== "find") return;
    host.clear();
    setOpen(true);
    if (request.replace) setShowReplace(true);
    if (request.seed) setQuery(request.seed);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [host, request]);

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
    <div className="lx-md-find" role="search" aria-label={t`Find in document`}>
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
