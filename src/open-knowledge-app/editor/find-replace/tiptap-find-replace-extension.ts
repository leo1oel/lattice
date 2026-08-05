import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  EMPTY_FIND_STATE,
  type FindMatchRange,
  type FindOptions,
  type FindReplacePluginState,
} from './find-types';
import { findLiteralMatchesInDoc } from './literal-matcher';

interface SetFindQueryMeta {
  type: 'setQuery';
  query: string;
  options?: Partial<FindOptions>;
  activeIndex?: number;
}

interface SetFindOptionsMeta {
  type: 'setOptions';
  options: Partial<FindOptions>;
  activeIndex?: number;
}

interface SetActiveIndexMeta {
  type: 'setActiveIndex';
  activeIndex: number;
}

interface ClearFindMatchesMeta {
  type: 'clear';
}

type FindReplaceMeta =
  | SetFindQueryMeta
  | SetFindOptionsMeta
  | SetActiveIndexMeta
  | ClearFindMatchesMeta;

export const findReplacePluginKey = new PluginKey<FindReplacePluginState>('findReplace');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    findReplace: {
      setFindQuery: (
        query: string,
        payload?: { options?: Partial<FindOptions>; activeIndex?: number },
      ) => ReturnType;
      setFindOptions: (options: Partial<FindOptions>, activeIndex?: number) => ReturnType;
      setActiveFindIndex: (activeIndex: number) => ReturnType;
      selectNextFindMatch: () => ReturnType;
      selectPreviousFindMatch: () => ReturnType;
      replaceCurrentFindMatch: (replacement: string) => ReturnType;
      replaceAllFindMatches: (replacement: string) => ReturnType;
      clearFindMatches: () => ReturnType;
    };
  }
}

function normalizeActiveIndex(activeIndex: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(activeIndex)) return 0;
  return Math.min(Math.max(Math.trunc(activeIndex), 0), total - 1);
}

function recomputeState(
  state: EditorState,
  query: string,
  options: FindOptions,
  activeIndex: number,
) {
  const matches = findLiteralMatchesInDoc(state.doc, query, options);
  return {
    query,
    options,
    activeIndex: normalizeActiveIndex(activeIndex, matches.length),
    matches,
  };
}

function nextIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (normalizeActiveIndex(current, total) + direction + total) % total;
}

export function findNextActiveIndexAfterReplacement(
  matches: readonly FindMatchRange[],
  replacedFrom: number,
  replacementLength: number,
): number {
  if (matches.length === 0) return 0;
  const replacementEnd = replacedFrom + replacementLength;
  const nextIndex = matches.findIndex((match) => match.from >= replacementEnd);
  return nextIndex === -1 ? 0 : nextIndex;
}

export function createReplaceAllFindMatchesTransaction(
  state: EditorState,
  pluginState: FindReplacePluginState,
  replacement: string,
): Transaction | null {
  if (pluginState.matches.length === 0) return null;

  const tr = state.tr;
  for (const match of [...pluginState.matches].reverse()) {
    tr.insertText(replacement, match.from, match.to);
  }
  const nextMatches = findLiteralMatchesInDoc(tr.doc, pluginState.query, pluginState.options);
  const activeIndex = normalizeActiveIndex(0, nextMatches.length);
  const nextMatch = nextMatches[activeIndex];
  tr.setMeta(findReplacePluginKey, {
    type: 'setActiveIndex',
    activeIndex,
  } satisfies FindReplaceMeta);
  if (nextMatch) {
    tr.setSelection(TextSelection.create(tr.doc, nextMatch.from, nextMatch.to));
  }
  return tr.scrollIntoView();
}

function selectMatchTransaction(state: EditorState, activeIndex: number): Transaction | null {
  const pluginState = findReplacePluginKey.getState(state);
  const match = pluginState?.matches[activeIndex];
  if (!match) return null;
  return state.tr
    .setMeta(findReplacePluginKey, {
      type: 'setActiveIndex',
      activeIndex,
    } satisfies FindReplaceMeta)
    .setSelection(TextSelection.create(state.doc, match.from, match.to))
    .scrollIntoView();
}

export function getFindReplaceState(state: EditorState) {
  return findReplacePluginKey.getState(state) ?? EMPTY_FIND_STATE;
}

export function findReplacePlugin(): Plugin {
  return new Plugin({
    key: findReplacePluginKey,
    state: {
      init: () => EMPTY_FIND_STATE,
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(findReplacePluginKey) as FindReplaceMeta | undefined;
        if (meta?.type === 'clear') return EMPTY_FIND_STATE;

        let query = previous.query;
        let options = previous.options;
        let activeIndex = previous.activeIndex;

        if (meta?.type === 'setQuery') {
          query = meta.query;
          options = { ...options, ...meta.options };
          activeIndex = meta.activeIndex ?? 0;
        } else if (meta?.type === 'setOptions') {
          options = { ...options, ...meta.options };
          activeIndex = meta.activeIndex ?? activeIndex;
        } else if (meta?.type === 'setActiveIndex') {
          activeIndex = meta.activeIndex;
        } else if (!tr.docChanged) {
          return previous;
        }

        if (query.length === 0) {
          return {
            query,
            options,
            activeIndex: 0,
            matches: [],
          };
        }

        return recomputeState(newState, query, options, activeIndex);
      },
    },
    props: {
      decorations(state) {
        const pluginState = findReplacePluginKey.getState(state);
        if (!pluginState || pluginState.matches.length === 0) return null;

        return DecorationSet.create(
          state.doc,
          pluginState.matches.map((match, index) =>
            Decoration.inline(match.from, match.to, {
              class:
                index === pluginState.activeIndex
                  ? 'ok-find-match ok-find-match-active'
                  : 'ok-find-match',
            }),
          ),
        );
      },
    },
  });
}

export const TiptapFindReplace = Extension.create({
  name: 'findReplace',

  addCommands() {
    return {
      setFindQuery:
        (query, payload) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(
            state.tr.setMeta(findReplacePluginKey, {
              type: 'setQuery',
              query,
              options: payload?.options,
              activeIndex: payload?.activeIndex,
            } satisfies FindReplaceMeta),
          );
          return true;
        },

      setFindOptions:
        (options, activeIndex) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(
            state.tr.setMeta(findReplacePluginKey, {
              type: 'setOptions',
              options,
              activeIndex,
            } satisfies FindReplaceMeta),
          );
          return true;
        },

      setActiveFindIndex:
        (activeIndex) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(
            state.tr.setMeta(findReplacePluginKey, {
              type: 'setActiveIndex',
              activeIndex,
            } satisfies FindReplaceMeta),
          );
          return true;
        },

      selectNextFindMatch:
        () =>
        ({ state, dispatch }) => {
          const pluginState = getFindReplaceState(state);
          const activeIndex = nextIndex(pluginState.activeIndex, pluginState.matches.length, 1);
          const tr = selectMatchTransaction(state, activeIndex);
          if (!tr) return false;
          dispatch?.(tr);
          return true;
        },

      selectPreviousFindMatch:
        () =>
        ({ state, dispatch }) => {
          const pluginState = getFindReplaceState(state);
          const activeIndex = nextIndex(pluginState.activeIndex, pluginState.matches.length, -1);
          const tr = selectMatchTransaction(state, activeIndex);
          if (!tr) return false;
          dispatch?.(tr);
          return true;
        },

      replaceCurrentFindMatch:
        (replacement) =>
        ({ state, dispatch }) => {
          const pluginState = getFindReplaceState(state);
          const match = pluginState.matches[pluginState.activeIndex];
          if (!match || !dispatch) return false;

          const tr = state.tr.insertText(replacement, match.from, match.to);
          const nextMatches = findLiteralMatchesInDoc(
            tr.doc,
            pluginState.query,
            pluginState.options,
          );
          const activeIndex = findNextActiveIndexAfterReplacement(
            nextMatches,
            match.from,
            replacement.length,
          );
          const nextMatch = nextMatches[activeIndex];
          tr.setMeta(findReplacePluginKey, {
            type: 'setActiveIndex',
            activeIndex,
          } satisfies FindReplaceMeta);
          if (nextMatch) {
            tr.setSelection(TextSelection.create(tr.doc, nextMatch.from, nextMatch.to));
          }
          tr.scrollIntoView();
          dispatch(tr);
          return true;
        },

      replaceAllFindMatches:
        (replacement) =>
        ({ state, dispatch }) => {
          const pluginState = getFindReplaceState(state);
          if (!dispatch) return false;
          const tr = createReplaceAllFindMatchesTransaction(state, pluginState, replacement);
          if (!tr) return false;
          dispatch(tr);
          return true;
        },

      clearFindMatches:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(
            state.tr.setMeta(findReplacePluginKey, {
              type: 'clear',
            } satisfies FindReplaceMeta),
          );
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [findReplacePlugin()];
  },
});
