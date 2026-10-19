/**
 * One terminal's screen: xterm.js 6 (the version the embedded Synara panel
 * pins) in an element of its own, which the panel moves into place and back
 * out again without the screen losing its scrollback.
 *
 * Drawing is on the GPU (the WebGL addon) for the terminal on screen only:
 * each WebGL context holds a glyph atlas, and WebKit allows a window only a
 * few contexts, so a tab in the background draws nothing until it is shown
 * again. Without WebGL (it failed to start, or its context was lost) the
 * screen falls back to xterm.js's DOM renderer and stays usable.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import type { TerminalScreen } from "./terminal-sessions";
import { TERMINAL_TOGGLE_KEY } from "./terminal-layout";

/* eslint-disable lingui/no-unlocalized-strings -- xterm.js options and escape sequences */

const SCROLLBACK_LINES = 5000;

export type XtermScreen = TerminalScreen & {
  /** Put the screen in `container`, starting xterm.js the first time. */
  attach: (container: HTMLElement) => void;
  /** Fit the grid to the element's size; nothing while it has none (hidden). */
  fit: () => void;
  focus: () => void;
  /** Draw on the GPU while shown, and release the context while not. */
  setShown: (shown: boolean) => void;
  setAppearance: (appearance: { theme: ITheme; fontFamily: string; fontSize: number }) => void;
  /** Highlight `query`; `incremental` keeps the match in front while it still matches (typing). */
  find: (query: string, direction: "next" | "previous", options: { incremental: boolean }) => void;
  clearFind: () => void;
  /** The one listener for the find field's count, or none. */
  onFindResults: (listener: ((results: { index: number; count: number }) => void) | null) => void;
  /** ⌘F in the terminal: the panel opens its find field. */
  onFindRequest: (listener: () => void) => void;
  clear: () => void;
};

/** The terminal's own keys stay out of xterm.js, so the window sees them. */
function isWindowKey(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && event.key === TERMINAL_TOGGLE_KEY.key;
}

export function createXtermScreen(): XtermScreen {
  const element = document.createElement("div");
  element.className = "terminal-screen";
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: SCROLLBACK_LINES,
    // ANSI colours a program picks are lifted to 4.5:1 on the ground, so a
    // yellow warning stays readable on the light theme.
    minimumContrastRatio: 4.5,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true,
    fontSize: 12,
    lineHeight: 1.2,
  });
  const fitAddon = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 1000 });
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  // Wide characters (CJK, emoji) take the two cells today's shells give them.
  term.unicode.activeVersion = "11";
  // ⌘-click opens a link, as in Terminal and iTerm: a plain click selects.
  term.loadAddon(new WebLinksAddon((event, uri) => {
    if (event.metaKey) void openUrl(uri).catch(() => {});
  }));
  let opened = false;
  let webgl: WebglAddon | null = null;
  let webglFailed = false;
  let findRequest = () => {};
  let findResults: ((results: { index: number; count: number }) => void) | null = null;
  search.onDidChangeResults(({ resultIndex, resultCount }) => findResults?.({ index: resultIndex, count: resultCount }));
  let theme: ITheme = {};
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return !isWindowKey(event);
    if (isWindowKey(event)) return false;
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = event.key.toLocaleLowerCase();
      if (key === "f") {
        event.preventDefault();
        findRequest();
        return false;
      }
      if (key === "a") {
        event.preventDefault();
        term.selectAll();
        return false;
      }
    }
    return true;
  });
  const decorations = () => ({
    matchBackground: theme.selectionInactiveBackground,
    activeMatchBackground: theme.selectionBackground,
    matchOverviewRuler: theme.selectionInactiveBackground ?? "",
    activeMatchColorOverviewRuler: theme.cursor ?? "",
  });
  const findOptions = (): ISearchOptions => ({ caseSensitive: false, decorations: decorations() });
  // Which renderer draws now, for checking the GPU path in the real window.
  const releaseGpu = () => {
    webgl?.dispose();
    webgl = null;
    element.dataset.renderer = "dom";
  };
  return {
    element,
    cols: () => term.cols,
    rows: () => term.rows,
    write: (data, done) => term.write(data, done),
    note: (text) => term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`),
    onInput: (listener) => {
      term.onData(listener);
      // Mouse reports some programs ask for arrive as binary; the shell gets the same bytes.
      term.onBinary(listener);
    },
    onResize: (listener) => { term.onResize(({ cols, rows }) => listener(cols, rows)); },
    attach: (container) => {
      if (element.parentElement !== container) container.appendChild(element);
      if (opened) return;
      opened = true;
      term.open(element);
    },
    fit: () => {
      if (!opened || !element.clientWidth || !element.clientHeight) return;
      fitAddon.fit();
    },
    focus: () => term.focus(),
    setShown: (shown) => {
      if (!shown) {
        releaseGpu();
        return;
      }
      if (!opened || webgl || webglFailed) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // The DOM renderer takes over; a context lost once is not retried.
          webglFailed = true;
          releaseGpu();
        });
        term.loadAddon(addon);
        webgl = addon;
        element.dataset.renderer = "webgl";
      } catch {
        webglFailed = true;
      }
    },
    setAppearance: (appearance) => {
      theme = appearance.theme;
      term.options.theme = appearance.theme;
      term.options.fontFamily = appearance.fontFamily;
      term.options.fontSize = appearance.fontSize;
      // The atlas holds glyphs in the old colours.
      webgl?.clearTextureAtlas();
    },
    find: (query, direction, { incremental }) => {
      if (!query) {
        search.clearDecorations();
        findResults?.({ index: -1, count: 0 });
        return;
      }
      if (direction === "next") search.findNext(query, { ...findOptions(), incremental });
      else search.findPrevious(query, findOptions());
    },
    clearFind: () => search.clearDecorations(),
    onFindResults: (listener) => { findResults = listener; },
    onFindRequest: (listener) => { findRequest = listener; },
    clear: () => term.clear(),
    dispose: () => {
      releaseGpu();
      term.dispose();
      element.remove();
    },
  };
}
