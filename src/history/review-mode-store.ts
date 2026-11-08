/**
 * Review mode for the project in this window: whether it is on, and the base
 * each LaTeX file is reviewed against.
 *
 * The bases live in `.research/review/` (src-tauri/src/project/review_mode.rs),
 * never in the writer's files: those hold the writer's edits, as a document
 * in Word does with Track Changes on. Turning review mode on copies every
 * file in; accepting a change rewrites that file's copy; turning it off
 * deletes the folder and leaves the files as they are.
 *
 * An open file's base is held by its editor (review-mode-extension.ts), so an
 * accept is one undo step there; the editor writes it back here, and this
 * writes it to disk. Files that are not open keep theirs only here.
 *
 * One window shows one project, so there is one store, read by the editor
 * extension without going through React.
 */
import { invoke } from "@tauri-apps/api/core";
import { msg } from "@lingui/core/macro";
import { confirmAction, hostErrorMessage } from "../app-utils";
import { showError } from "../app/notify";
import { i18n } from "../i18n";
import type { EditorView } from "@codemirror/view";

// The title bar reads this store from the first frame; the diffing (and the
// editor library under it) loads only once a sync has something to carry.
const loadDiff = () => import("./review-mode-diff");

export type ReviewModeState = Readonly<{
  /** The project these bases belong to. */
  root: string | null;
  active: boolean;
  /** The PDF panel shows the PDF with the changes marked instead of the paper's own; on when review mode is. */
  marked: boolean;
  /** Something the writer should know: a co-author's edit landed in text they had changed. */
  notice: string | null;
  /** Counts the bases written to disk, so the PDF with changes marked follows an accept. */
  revision: number;
}>;

type Loaded = { startedAt: string; bases: Record<string, string>; excluded?: string[] };

/** The files review mode tracks: the paper's LaTeX and its bibliography, eight folders deep as the host looks. */
const isReviewablePath = (path: string) => /\.(?:tex|bib)$/i.test(path) && path.split("/").length <= 8;

/** How long a base waits before it is written, so an accept-all or a run of accepts is one write. */
const SAVE_DELAY_MS = 400;
/** How long a co-author's text waits for the editor to take it; see `noteCoauthorText`. */
const COAUTHOR_WAIT_MS = 10_000;

/** The editor's text has `\n` line breaks whatever the file has; so must its base. */
const editorText = (text: string) => text.replace(/\r\n?/g, "\n");

export type ReviewModeStore = ReturnType<typeof createReviewModeStore>;

export function createReviewModeStore(call: typeof invoke = invoke) {
  let state: ReviewModeState = { root: null, active: false, marked: false, notice: null, revision: 0 };
  let bases = new Map<string, string>();
  /** Files the host left out when review mode was turned on (too big, or not text): never tracked. */
  let excluded = new Set<string>();
  /** When this review mode was turned on, naming it apart from an earlier one; null while it is off. */
  let session: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const views = new Map<string, Set<EditorView>>();
  const pushers = new Map<EditorView, (base: string | null) => void>();
  const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
  const coauthor = new Map<string, { text: string; at: number }>();

  /** A host call that failed, told to the writer: their tracked changes depend on it. */
  const report = (reason: unknown) => showError(hostErrorMessage(reason), i18n._(msg`Track changes`));

  const set = (patch: Partial<ReviewModeState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /** Tell every open editor of `path` (or of every file) its base now. */
  const push = (path?: string) => {
    for (const [viewPath, open] of views) {
      if (path !== undefined && viewPath !== path) continue;
      for (const view of open) pushers.get(view)?.(store.baseFor(viewPath));
    }
  };

  const flushSave = async (path: string) => {
    const timer = pendingSaves.get(path);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingSaves.delete(path);
    const root = state.root;
    const base = bases.get(path);
    if (!root || !state.active || base === undefined) return;
    try {
      await call("review_mode_save_base", { projectRoot: root, path, base });
    } catch (reason) {
      report(reason);
      return;
    }
    if (state.root === root && state.active) set({ revision: state.revision + 1 });
  };

  const adopt = (root: string | null, loaded: Loaded | null) => {
    for (const path of [...pendingSaves.keys()]) void flushSave(path);
    bases = new Map(Object.entries(loaded?.bases ?? {}).map(([path, base]) => [path, editorText(base)]));
    excluded = new Set(loaded?.excluded ?? []);
    session = loaded?.startedAt ?? null;
    coauthor.clear();
    const same = state.active && state.root === root;
    set({ root, active: loaded !== null, marked: loaded !== null && (!same || state.marked), notice: null });
    push();
  };

  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => state,

    /** Read whether `root` is in review mode; a later load or switch wins. */
    async load(root: string | null) {
      const current = ++generation;
      const loaded = root ? await call<Loaded | null>("review_mode_load", { projectRoot: root }).catch(() => null) : null;
      if (current === generation) adopt(root, loaded);
    },

    /**
     * Turn review mode on: every file's text now becomes its base. `open` is
     * the file in the editor, whose unsaved text is what the writer sees.
     */
    async start(open?: { path: string; text: string }) {
      const root = state.root;
      if (!root || state.active) return;
      const current = ++generation;
      let loaded: Loaded;
      try {
        loaded = await call<Loaded>("review_mode_start", { projectRoot: root });
      } catch (reason) {
        if (current === generation) report(reason);
        return;
      }
      if (current !== generation) return;
      adopt(root, loaded);
      if (open && store.baseFor(open.path) !== null) {
        store.setBase(open.path, open.text);
        push(open.path);
      }
    },

    /**
     * Turn review mode off: the files stay as they are and the bases are
     * deleted. When they could not be, review mode is read back as the disk has it.
     */
    async stop() {
      const root = state.root;
      if (!root || !state.active) return;
      const current = ++generation;
      for (const timer of pendingSaves.values()) clearTimeout(timer);
      pendingSaves.clear();
      bases = new Map();
      excluded = new Set();
      session = null;
      coauthor.clear();
      set({ active: false, marked: false, notice: null });
      push();
      try {
        await call("review_mode_stop", { projectRoot: root });
      } catch (reason) {
        report(reason);
        if (current === generation) await store.load(root);
      }
    },

    /** Turn review mode off once the writer agrees: the changes waiting stop being marked. */
    async confirmStop() {
      const agreed = await confirmAction({
        title: i18n._(msg`Stop tracking changes?`),
        message: i18n._(msg`Your edits stay in the files. The changes waiting for review are no longer marked.`),
        confirmLabel: i18n._(msg`Stop tracking`),
      });
      if (agreed) await store.stop();
    },

    setMarked: (marked: boolean) => set({ marked: marked && state.active }),
    /** The review mode now on, named by when it was turned on; null while it is off. */
    session: () => (state.active ? session : null),
    setNotice: (notice: string | null) => set({ notice }),

    /** `path`'s base, or null when review mode is off or does not track it. A file made since has an empty base. */
    baseFor(path: string): string | null {
      if (!state.active || !isReviewablePath(path) || excluded.has(path)) return null;
      return bases.get(path) ?? "";
    },

    /** The editor's base for `path` changed: an accept, an undo of one, or a co-author's edit. */
    setBase(path: string, base: string) {
      if (store.baseFor(path) === null || bases.get(path) === base) return;
      bases.set(path, base);
      const timer = pendingSaves.get(path);
      if (timer !== undefined) clearTimeout(timer);
      pendingSaves.set(path, setTimeout(() => void flushSave(path), SAVE_DELAY_MS));
    },

    /** Write every waiting base now, before something reads them from disk (the PDF with changes marked). */
    async flush() {
      await Promise.all([...pendingSaves.keys()].map(flushSave));
    },

    /** An editor of `path` opened; `apply` hands it a base the store changed. Returns the unregister. */
    register(path: string, view: EditorView, apply: (base: string | null) => void) {
      let open = views.get(path);
      if (!open) views.set(path, open = new Set());
      open.add(view);
      pushers.set(view, apply);
      return () => {
        open.delete(view);
        if (!open.size && views.get(path) === open) views.delete(path);
        pushers.delete(view);
      };
    },

    /**
     * The open file `path` is about to read `text` because of a co-author's
     * edit (Overleaf). The editor that takes it moves its base forward with
     * the edit instead of tracking it as the writer's; see `takeCoauthorText`.
     */
    noteCoauthorText(path: string, text: string) {
      if (store.baseFor(path) !== null) coauthor.set(path, { text: editorText(text), at: Date.now() });
    },

    /** Whether `path`'s new text is the co-author's text noted for it; a match takes it. */
    takeCoauthorText(path: string, matches: (text: string) => boolean): boolean {
      const noted = coauthor.get(path);
      if (!noted) return false;
      if (Date.now() - noted.at > COAUTHOR_WAIT_MS) {
        coauthor.delete(path);
        return false;
      }
      if (!matches(noted.text)) return false;
      coauthor.delete(path);
      return true;
    },

    /**
     * A sync wrote a co-author's edits into `path`, which went from `before`
     * to `after` on disk. An open file hears of it as its editor takes the
     * new text; one that is not open moves its base here.
     */
    async advance(path: string, before: string, after: string) {
      if (store.baseFor(path) === null || before === after) return;
      if (views.has(path)) {
        store.noteCoauthorText(path, after);
        return;
      }
      const root = state.root;
      const { baseAfterSync } = await loadDiff();
      if (state.root !== root || !state.active) return;
      store.setBase(path, baseAfterSync(bases.get(path) ?? "", editorText(before), editorText(after)));
    },

    /**
     * Before an Overleaf sync: every reviewable file's text on disk, made
     * since review mode was turned on or not, for `afterSync` to tell what it brought.
     */
    async beforeSync(): Promise<Map<string, string> | null> {
      const root = state.root;
      if (!root || !state.active) return null;
      const files = await call<Record<string, string>>("review_mode_files", { projectRoot: root }).catch(() => null);
      return files ? new Map(Object.entries(files)) : null;
    },

    /**
     * After it: move the base of every file the sync pulled or merged forward
     * with what came from Overleaf. A file that was not here before is the
     * co-author's whole: it comes in as its base.
     */
    async afterSync(before: Map<string, string> | null, paths: readonly string[]) {
      const root = state.root;
      if (!before || !root || !state.active) return;
      for (const path of paths) {
        if (store.baseFor(path) === null) continue;
        const was = before.get(path) ?? "";
        const now = await call<string>("read_project_file", { path, projectRoot: root }).catch(() => null);
        if (now !== null && state.root === root) await store.advance(path, was, now);
      }
    },
  };
  return store;
}

/** This window's review mode. */
export const reviewMode = createReviewModeStore();
