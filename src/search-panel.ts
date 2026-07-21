import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

/**
 * CodeMirror's search panel spells every control out — "next", "previous",
 * "all", "match case", "regexp", "by word", "replace", "replace all" — which in
 * a narrow editor pushes the query field down to nothing. Swap the words for
 * the symbols editors conventionally use, through the phrase facet the panel
 * already reads.
 */
const SEARCH_PHRASES: Record<string, string> = {
  next: "↓",
  previous: "↑",
  all: "All",
  "match case": "Aa",
  regexp: ".*",
  "by word": "W",
  replace: "Replace",
  "replace all": "All",
};

/** What each control does, now that its label no longer says so. */
const SEARCH_TITLES: Record<string, string> = {
  next: "Next match",
  prev: "Previous match",
  select: "Select all matches",
  replace: "Replace this match",
  replaceAll: "Replace all matches",
  close: "Close search",
  case: "Match case",
  re: "Regular expression",
  word: "Whole word",
};

/**
 * A symbol with no tooltip is a worse label than a word, so put the meaning
 * back as `title`/`aria-label` on every control the panel builds.
 */
function describeSearchControls(view: EditorView): void {
  for (const panel of view.dom.querySelectorAll(".cm-panel.cm-search")) {
    for (const control of panel.querySelectorAll<HTMLElement>("button[name], input[name]")) {
      const description = SEARCH_TITLES[control.getAttribute("name") ?? ""];
      if (!description || control.title === description) continue;
      control.title = description;
      if (!control.getAttribute("aria-label")) control.setAttribute("aria-label", description);
    }
  }
}

const describeSearchPanel = ViewPlugin.fromClass(
  class implements PluginValue {
    constructor(private readonly view: EditorView) {
      describeSearchControls(view);
    }

    update(update: ViewUpdate) {
      // The panel is created and destroyed as search opens and closes, so this
      // cannot run once at startup.
      if (update.docChanged || update.selectionSet || update.transactions.length) {
        describeSearchControls(this.view);
      }
    }
  },
);

export const compactSearchPanel = [
  EditorState.phrases.of(SEARCH_PHRASES),
  describeSearchPanel,
];
