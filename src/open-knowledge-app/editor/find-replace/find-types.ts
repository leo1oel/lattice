export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface FindMatchRange {
  from: number;
  to: number;
  text: string;
}

export interface FindReplacePluginState {
  query: string;
  options: FindOptions;
  activeIndex: number;
  matches: readonly FindMatchRange[];
}

const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
};

export const EMPTY_FIND_STATE: FindReplacePluginState = {
  query: '',
  options: DEFAULT_FIND_OPTIONS,
  activeIndex: 0,
  matches: [],
};
