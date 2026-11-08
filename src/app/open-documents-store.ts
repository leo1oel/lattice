import type { SetStateAction } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AssetPreview, CanvasMode, NavigationEntry, PaperSummary } from "../app-types";
import type { PaperView } from "./paper-documents";
import { diffToOps, rebaseOnto } from "../overleaf/ot";

const NAVIGATION_HISTORY_LIMIT = 80;

/** The "Opening …" overlay of the open under way; `generation` is the intent that showed it. */
type Opening = { generation: number; label: string };

/** What a project window has open, as plain data. */
export type OpenDocumentsState = {
  /** The text file loaded underneath (`""`: none), its live buffer and the text on disk. */
  file: string;
  text: string;
  savedText: string;
  /**
   * The file's text as it last came from outside the writer's own editing: a
   * disk read (an agent, another app, a reload), an Overleaf collaborator, a
   * save that merged edits made outside. The source editor takes that text
   * without an undo step, so ⌘Z never takes back someone else's edit.
   */
  outsideText: string | null;
  /** An asset preview in front of the file. */
  asset: AssetPreview | null;
  /** A Paper in front of the file, and which of its reading files is shown. */
  paper: PaperSummary | null;
  paperView: PaperView;
  paperMarkdown: string;
  savedPaperMarkdown: string;
  /** The alphaXiv overview ("blog"); null when the Paper has no report. */
  paperBlog: string | null;
  savedPaperBlog: string | null;
  /**
   * Tab keys in strip order, saved with the layout; a full panel closes some
   * (trellis-tab-policy.ts). Each explicit open counts `revealRequest` up, so
   * Trellis shows the opened document even when it was already the active one
   * and only a navigator (Papers, say) covered it in its panel. Routine
   * reloads keep the panels' selection.
   */
  tabs: string[];
  revealRequest: number;
  mode: CanvasMode;
  opening: Opening | null;
  /** Back/forward history: commands read it when asked, nothing renders it. */
  navStack: NavigationEntry[];
  navIndex: number;
  /**
   * Layout persistence starts once the project's restore finished; Trellis
   * reconciles panels as soon as the tabs settle (restored, or superseded by
   * a file the writer opened during the restore).
   */
  persistenceReadyRoot: string | null;
  tabsSettledRoot: string | null;
};

type Setters = { [K in keyof OpenDocumentsState as `set${Capitalize<K>}`]: (next: SetStateAction<OpenDocumentsState[K]>) => void };

type OpenDocumentsActions = Setters & {
  /** Replace the file's buffer with durable content from outside (live and saved agree). */
  commitFileText: (content: string) => void;
  /** Replace the file's buffer with text that merged in edits from outside; it stays unsaved. */
  takeOutsideText: (content: string) => void;
  /**
   * The editor's typing turned `base`, the buffer as the editor last saw it,
   * into `content`. When the buffer moved on meanwhile — text from outside
   * landed while the editor had yet to take it in — the typing is carried
   * onto that text rather than replacing it.
   */
  typeFileText: (content: string, base: string) => void;
  /** Load `content` as `path`'s durable text. */
  showFileText: (path: string, content: string) => void;
  /** Both of the open Paper's reading buffers, as read from disk. */
  setPaperBuffers: (markdown: string, blog: string | null) => void;
  /** Leave Paper reading: the primary buffer belongs to a file again. */
  closePaper: () => void;
  addTab: (path: string) => void;
  /** An explicit open: the document gets its tab, and its panel shows it. */
  showTab: (path: string) => void;
  /** Record a jump, dropping the forward history; a repeat of the current entry only moves onto it. */
  pushNavigation: (path: string, line: number) => void;
};

export type OpenDocumentsStore = StoreApi<OpenDocumentsState & OpenDocumentsActions>;

const initialState = (): OpenDocumentsState => ({
  file: "", text: "", savedText: "", outsideText: null, asset: null,
  paper: null, paperView: "fulltext", paperMarkdown: "", savedPaperMarkdown: "", paperBlog: null, savedPaperBlog: null,
  tabs: [], revealRequest: 0, mode: "split", opening: null, navStack: [], navIndex: -1,
  persistenceReadyRoot: null, tabsSettledRoot: null,
});

/**
 * One window's open documents. Writes land at once, so async work reads the
 * latest buffers with `getState()`; components subscribe to the slices they
 * render. The commands that decide what to open live in useOpenDocuments.
 */
export function createOpenDocumentsStore(): OpenDocumentsStore {
  return createStore<OpenDocumentsState & OpenDocumentsActions>()((set, get) => {
    // A React-style setter per field, updater functions included (no field holds a function).
    const setters = Object.fromEntries(Object.keys(initialState()).map((key) => [
      `set${key[0].toUpperCase()}${key.slice(1)}`,
      (next: unknown) => set((state) => ({
        [key]: typeof next === "function" ? next(state[key as keyof OpenDocumentsState]) : next,
      })),
    ])) as Setters;
    return {
      ...initialState(),
      ...setters,
      commitFileText: (content) => set({ text: content, savedText: content, outsideText: content }),
      takeOutsideText: (content) => set({ text: content, outsideText: content }),
      typeFileText: (content, base) => set(({ text }) => {
        if (text === base) return { text: content };
        const merged = rebaseOnto(base, content, diffToOps(base, text), text);
        return merged === null ? {} : { text: merged, outsideText: merged };
      }),
      showFileText: (path, content) => set({ file: path, text: content, savedText: content, outsideText: content }),
      setPaperBuffers: (markdown, blog) => set({
        paperMarkdown: markdown, savedPaperMarkdown: markdown, paperBlog: blog, savedPaperBlog: blog,
      }),
      closePaper: () => {
        set({ paper: null });
        get().setPaperBuffers("", null);
      },
      addTab: (path) => set(({ tabs }) => (tabs.includes(path) ? {} : { tabs: [...tabs, path] })),
      showTab: (path) => {
        get().addTab(path);
        set(({ revealRequest }) => ({ revealRequest: revealRequest + 1 }));
      },
      pushNavigation: (path, line) => set(({ navStack, navIndex }) => {
        const trimmed = navStack.slice(0, Math.max(0, navIndex + 1));
        const last = trimmed.at(-1);
        if (last && last.path === path && last.line === line) return { navStack: trimmed, navIndex: trimmed.length - 1 };
        const next = [...trimmed, { path, line }].slice(-NAVIGATION_HISTORY_LIMIT);
        return { navStack: next, navIndex: next.length - 1 };
      }),
    };
  });
}
