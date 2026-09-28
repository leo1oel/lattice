import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../../i18n";
import { element } from "../dom-utils";

/**
 * CodeMirror's search panel spells every control out — "next", "previous",
 * "all", "match case", "regexp", "by word", "replace", "replace all" — which in
 * a narrow editor pushes the query field down to nothing. Swap the words for
 * the symbols editors conventionally use, through the phrase facet the panel
 * already reads. The same facet carries the translation of the words that stay
 * (placeholders, the go-to-line dialog, screen-reader announcements).
 */
// eslint-disable-next-line lingui/no-unlocalized-strings -- symbols editors use in every locale
const SEARCH_SYMBOLS: Record<string, string> = { next: "↓", previous: "↑", "match case": "Aa", regexp: ".*", "by word": "W" };
const SEARCH_WORDS: Record<string, MessageDescriptor> = {
  all: msg`All`,
  replace: msg`Replace`,
  "replace all": msg`All`,
  Find: msg`Find`,
  Replace: msg`Replace`,
  close: msg`Close search`,
  "current match": msg`current match`,
  "on line": msg`on line`,
  // CodeMirror substitutes the number for `$`.
  "replaced match on line $": msg`replaced match on line $`,
  "replaced $ matches": msg`replaced $ matches`,
  "Go to line": msg`Go to line`,
  go: msg`go`,
};

/** What each control does, now that its label no longer says so. */
const SEARCH_TITLES: Record<string, MessageDescriptor> = {
  next: msg`Next match`, prev: msg`Previous match`, select: msg`Select all matches`, replace: msg`Replace this match`,
  replaceAll: msg`Replace all matches`, close: msg`Close search`, case: msg`Match case`, re: msg`Regular expression`,
  word: msg`Whole word`,
};

/**
 * A symbol with no tooltip is a worse label than a word, so put the meaning
 * back as `title`/`aria-label` on every control the panel builds.
 */
function describeSearchControls(view: EditorView): void {
  for (const panel of view.dom.querySelectorAll(".cm-panel.cm-search")) {
    for (const control of panel.querySelectorAll<HTMLElement>("button[name], input[name]")) {
      const title = SEARCH_TITLES[control.getAttribute("name") ?? ""];
      const description = title && i18n._(title);
      if (!description || control.title === description) continue;
      control.title = description;
      if (!control.getAttribute("aria-label")) control.setAttribute("aria-label", description);
    }

    let count = panel.querySelector<HTMLElement>(".cm-search-count");
    if (!count) {
      count = element("span", "cm-search-count");
      count.setAttribute("aria-live", "polite");
      panel.querySelector<HTMLInputElement>('input[name="search"]')?.insertAdjacentElement("afterend", count);
    }
    const query = getSearchQuery(view.state);
    const matches: Array<{ from: number; to: number }> = [];
    if (searchPanelOpen(view.state) && query.valid) {
      const cursor = query.getCursor(view.state);
      for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push(next.value);
    }
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

const describeSearchPanel = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {
    describeSearchControls(view);
  }

  update(update: ViewUpdate) {
    // The panel is created and destroyed as search opens and closes, so this
    // cannot run once at startup.
    if (update.transactions.length) describeSearchControls(this.view);
  }
});

/** Phrases resolve against the active catalog, so build this per editor rather than at module load. */
export function compactSearchPanel() {
  const words = Object.fromEntries(Object.entries(SEARCH_WORDS).map(([phrase, message]) => [phrase, i18n._(message)]));
  return [
    EditorState.phrases.of({ ...words, ...SEARCH_SYMBOLS }),
    describeSearchPanel,
  ];
}
