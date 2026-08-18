import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";

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

    let count = panel.querySelector<HTMLElement>(".cm-search-count");
    if (!count) {
      count = document.createElement("span");
      count.className = "cm-search-count";
      count.setAttribute("aria-live", "polite");
      panel.querySelector<HTMLInputElement>('input[name="search"]')?.insertAdjacentElement("afterend", count);
    }
    const query = getSearchQuery(view.state);
    if (!searchPanelOpen(view.state) || !query.valid) {
      count.textContent = "0/0";
      continue;
    }
    const matches: Array<{ from: number; to: number }> = [];
    const cursor = query.getCursor(view.state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push(next.value);
    if (!matches.length) {
      count.textContent = "0/0";
      continue;
    }
    const selection = view.state.selection.main;
    const exact = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
    const following = matches.findIndex((match) => match.from >= selection.head);
    const current = exact >= 0 ? exact + 1 : following >= 0 ? following + 1 : matches.length;
    count.textContent = `${current}/${matches.length}`;
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
