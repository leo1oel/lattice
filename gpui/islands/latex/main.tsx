/**
 * The LaTeX island: a `.tex` file's Visual view, which in the Tauri app is
 * its source editor drawn as a page (`src/editor/latex/visual/latex-visual.ts`
 * filling the slot `latex-visual-switch.ts` keeps in the CodeMirror editor
 * `src/canvas/source-session.ts` builds), laid in the canvas's source pane
 * (`.source-workspace`, `.source-editor`) as `document-canvas.tsx` lays it,
 * with its overlay scrollbar. The owner in the GPUI app
 * (`gpui/crates/lattice-gpui/src/structured/latex_visual.rs`) shows it in
 * place of the source while Visual is chosen.
 *
 * The owner holds the file's text in its editor buffer, as every document's;
 * this page is the editor in front of it, as the Markdown island is
 * (`../markdown/main.tsx`), and speaks the visual editors' protocol:
 *
 * - an edit goes out as the whole file and the text it was made against
 *   (`md:change`); the owner applies it as the minimal change from `base`, or
 *   refuses it and sends the buffer's text, which the editor then takes;
 * - undo and redo are the buffer's (`md:undo`, `md:redo`), so Source and
 *   Visual step through one history; the editor's own history never fills;
 * - the owner's text reaches the editor as `CodeMirrorHost` takes any value
 *   from outside, only what changed, waiting out typing.
 *
 * What the Tauri app's canvas gave the editor as its live data
 * (`LatexEditorLiveData`) is built here from what the owner sends: the
 * project's tree (its paths), its TeX sources (their macros, KaTeX's macros
 * and their `\graphicspath`), its citations and labels (the labels of the
 * open file read from its own text, as `mergeReferences` has them), the
 * manuscript's root document and the last build, whose `.aux` the editor
 * reads through `read_project_file` to number what it draws.
 *
 * Host to page, beside the document protocol's `doc:open` (with
 * `projectRoot`, `files`, `texSources`, `index`, `rootDocument`, `build`),
 * `doc:source`, `doc:active`, `doc:flush` and `doc:locale`:
 *   md:reveal         { id, line }      land on a 1-based line of the file
 *   md:assets-changed                   project files changed: figures load again
 *   md:project        { files, texSources }   the project's tree and TeX sources changed
 *   tex:index         { citations, references, pending }   the project's index was read again
 *   tex:root          { path }          the manuscript's root document
 *   tex:build         { build }         the last build that wrote a PDF, or null
 *   tex:find          { step }          "open" the editor's search panel, or step to the "next" or "previous" match
 * Page to host:
 *   md:change         { source, base }  the whole file after an edit made against `base`
 *   md:undo, md:redo
 *   md:caret          { line, column }  1-based, in the file
 *   md:open-path      { path }          an `\input`'s file, or a figure's
 *   md:open-location  { path, line }    a `\ref`'s label
 *   tex:open-citation { key }           a citation's entry
 *   doc:view-state    { viewState }     the caret and the line at the top, for a woken page
 *   md:load-asset     (request) { path } → url | null
 */
import "../shared/install";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { findNext, findPrevious, openSearchPanel } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";
import { mount, activateLocale } from "../shared/boot";
import { host } from "../shared/host";
import "./latex.css";
import { CodeMirrorHost } from "../../../src/editor/codemirror-host";
import { CodeMirrorScrollbar } from "../../../src/canvas/codemirror-scrollbar";
import { latex } from "../../../src/editor/latex/latex-language";
import { latexEditorExtensions, latexIndexChanged, type LatexEditorLiveData } from "../../../src/editor/latex/latex-editor";
import { latexVisualDataChanged, type LatexVisualHost } from "../../../src/editor/latex/latex-visual-switch";
import {
  katexMacrosFromSources, mergeReferences, parseGraphicsPaths, parseLocalLabels, parseLocalMacros,
  type CitationInfo, type DefinitionTarget, type ReferenceInfo,
} from "../../../src/editor/latex/latex-text";
import type { CompiledBuild } from "../../../src/editor/latex/compiled-labels";
import { flattenProjectPaths } from "../../../src/build/compile-diagnostics";
import type { FileNode } from "../../../src/app-types";

type Locale = "en" | "zh-CN";

type ProjectIndex = { citations: CitationInfo[]; references: ReferenceInfo[]; pending: boolean };

/** Where the reader was: the caret and the line at the top, as offsets into the file. */
type ViewState = { head: number; top: number };

type LatexOpen = {
  path: string;
  source: string;
  projectRoot: string;
  viewState?: ViewState | null;
  locale: Locale;
  active: boolean;
  files: FileNode[];
  texSources: string[];
  index: ProjectIndex | null;
  rootDocument: string | null;
  build: CompiledBuild | null;
};

type State = {
  opened: LatexOpen | null;
  /** The file as the page has it: the owner's latest, or the editor's own edit. */
  source: string;
  /** `source` once typing has paused: what the live data is read from. */
  settled: string;
  ready: boolean;
  files: FileNode[];
  texSources: string[];
  index: ProjectIndex;
  rootDocument: string | null;
  build: CompiledBuild | null;
  assetRevision: number;
  /** Visual mode's module, once loaded. */
  visual: VisualModule | null;
  /** The editor, for its overlay scrollbar. */
  view: EditorView | null;
};

type Action =
  | { type: "open"; open: LatexOpen }
  | { type: "source"; source: string }
  | { type: "settle" }
  | { type: "ready" }
  | { type: "project"; files: FileNode[]; texSources: string[] }
  | { type: "index"; index: ProjectIndex }
  | { type: "root"; rootDocument: string | null }
  | { type: "build"; build: CompiledBuild | null }
  | { type: "assets" }
  | { type: "visual"; visual: VisualModule }
  | { type: "view"; view: EditorView };

const NO_INDEX: ProjectIndex = { citations: [], references: [], pending: true };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return {
        ...state,
        opened: action.open,
        source: action.open.source,
        settled: action.open.source,
        files: action.open.files,
        texSources: action.open.texSources,
        index: action.open.index ?? NO_INDEX,
        rootDocument: action.open.rootDocument,
        build: action.open.build,
      };
    case "source":
      return { ...state, source: action.source };
    case "settle":
      return { ...state, settled: state.source };
    case "ready":
      return { ...state, ready: true };
    case "project":
      return { ...state, files: action.files, texSources: action.texSources };
    case "index":
      return { ...state, index: action.index };
    case "root":
      return { ...state, rootDocument: action.rootDocument };
    case "build":
      return { ...state, build: action.build };
    case "assets":
      return { ...state, assetRevision: state.assetRevision + 1 };
    case "visual":
      return { ...state, visual: action.visual };
    case "view":
      return { ...state, view: action.view };
  }
}

type VisualModule = typeof import("../../../src/editor/latex/visual/latex-visual");
/** Visual mode's module, as the source editor loads it (`latex-visual-switch.ts`): its own chunk. */
const loadVisual = () => import("../../../src/editor/latex/visual/latex-visual");

/** How long after its commit the editor is taken to have drawn (`shared/document.tsx`). */
const DRAWN_DELAY_MS = 120;
/** How long the open file's own labels and macros wait for typing to pause. */
const SETTLE_MS = 300;

// A page holds one document, so what its editor reads as it runs lives with
// the page, outside React's state (as `shared/document.tsx` keeps its own).
/** The live data the editor's extensions read when they run (`LatexEditorLiveData`). */
let liveData: LatexEditorLiveData = {
  citationKeys: [], citations: [], references: [], indexPending: true, unusedLabels: [], unusedCitations: [],
  localMacros: [], graphicsRoots: [], projectPaths: [], spellingWords: [],
};
let editorView: EditorView | null = null;
/** The file as the page last had it, so the owner's echo is not a change. */
let pageSource = "";
/** A jump that arrived before the editor was there, taken once it is. */
let pendingReveal: number | null = null;

const loadAsset = (path: string) => host().request<string | null>("md:load-asset", { path }).catch(() => null);

/** Follow a link the editor draws or a definition it jumps to, in the GPUI app. */
function openTarget(target: DefinitionTarget): void {
  switch (target.kind) {
    case "reference":
      host().post("md:open-location", { path: target.path, line: target.line });
      return;
    case "citation":
      host().post("tex:open-citation", { key: target.key });
      return;
    case "include":
    case "asset":
      host().post("md:open-path", { path: target.path });
  }
}

/**
 * The editor's undo and redo, sent to the owner: the buffer's history is the
 * one both views share. Above every other keymap, Vim's and the base one's.
 */
const sharedHistory: Extension = Prec.highest(keymap.of([
  { key: "Mod-z", run: () => { host().post("md:undo"); return true; }, preventDefault: true },
  { key: "Mod-Shift-z", run: () => { host().post("md:redo"); return true; }, preventDefault: true },
  { key: "Mod-y", run: () => { host().post("md:redo"); return true; }, preventDefault: true },
]));

/**
 * The editor's extensions for the document at `path`, built once per
 * document: everything that changes as the writer works is read from
 * `liveData` when it runs (`source-session.ts`).
 */
function editorExtensions(visual: VisualModule, path: string): Extension[] {
  const data = { get current() { return liveData; } };
  const visualHost: LatexVisualHost = {
    data: () => liveData,
    loadImage: loadAsset,
    open: openTarget,
    readFile: (filePath) => invoke<string>("read_project_file", { path: filePath, projectRoot: liveData.projectRoot }),
  };
  return [
    sharedHistory,
    latex(),
    visual.latexVisual(visualHost),
    ...latexEditorExtensions({ live: data, currentPath: path, loadReferenceImage: loadAsset, onGotoDefinition: openTarget }),
  ];
}

function sendChange(next: string, base: string): void {
  pageSource = next;
  host().post("md:change", { source: next, base });
}

function reportView(update: ViewUpdate): void {
  if (!update.selectionSet && !update.docChanged && !update.viewportChanged) return;
  const head = update.state.selection.main.head;
  if (update.selectionSet || update.docChanged) {
    const line = update.state.doc.lineAt(head);
    host().post("md:caret", { line: line.number, column: head - line.from + 1 });
  }
  const top = update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop).from;
  host().post("doc:view-state", { viewState: { head, top } satisfies ViewState });
}

function Latex() {
  const [state, dispatch] = useReducer(reduce, {
    opened: null, source: "", settled: "", ready: false, files: [], texSources: [], index: NO_INDEX,
    rootDocument: null, build: null, assetRevision: 0, visual: null, view: null,
  });
  const { opened, source, settled, ready, files, texSources, index, rootDocument, build, assetRevision, visual, view } = state;

  useEffect(() => {
    let current = true;
    void loadVisual().then((module) => { if (current) dispatch({ type: "visual", visual: module }); });
    return () => { current = false; };
  }, []);
  // The live data is read from the text once typing pauses.
  useEffect(() => {
    if (source === settled) return;
    const timer = window.setTimeout(() => dispatch({ type: "settle" }), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settled, source]);

  const projectPaths = useMemo(() => flattenProjectPaths(files), [files]);
  const macroSources = useMemo(() => [...texSources, settled], [settled, texSources]);
  const localMacros = useMemo(() => parseLocalMacros(macroSources), [macroSources]);
  const katexMacros = useMemo(() => katexMacrosFromSources(macroSources), [macroSources]);
  const graphicsRoots = useMemo(() => parseGraphicsPaths(macroSources), [macroSources]);
  const path = opened?.path ?? "";
  const references = useMemo(
    () => mergeReferences(index.references, path, parseLocalLabels(path, settled)),
    [index.references, path, settled],
  );
  const citationKeys = useMemo(() => index.citations.map((citation) => citation.key), [index.citations]);
  const projectRoot = opened?.projectRoot;

  // One object per change, so Visual mode's identity checks see what changed.
  useEffect(() => {
    liveData = {
      citationKeys,
      citations: index.citations,
      references,
      indexPending: index.pending,
      unusedLabels: [],
      unusedCitations: [],
      localMacros,
      graphicsRoots,
      projectPaths,
      rootDocumentPath: rootDocument ?? undefined,
      projectRoot,
      katexMacros,
      compiledBuild: build ?? undefined,
      spellingWords: [],
    };
    // Draw again from the new data, and lint against the new index.
    editorView?.dispatch({ effects: [latexVisualDataChanged.of(null), latexIndexChanged.of(null)] });
  }, [build, citationKeys, graphicsRoots, index, katexMacros, localMacros, projectPaths, projectRoot, references, rootDocument]);
  // Figures load again once the project's files change.
  useEffect(() => {
    if (assetRevision) editorView?.dispatch({ effects: latexVisualDataChanged.of(null) });
  }, [assetRevision]);

  useEffect(() => {
    const bridge = host();
    const stops = [
      bridge.on("doc:open", (payload) => {
        const open = payload as LatexOpen;
        pageSource = open.source;
        dispatch({ type: "open", open });
        void activateLocale(open.locale).then(() => dispatch({ type: "ready" }));
      }),
      bridge.on("doc:source", (payload) => {
        const next = (payload as { source: string }).source;
        if (next === pageSource) return;
        pageSource = next;
        dispatch({ type: "source", source: next });
      }),
      // A hidden page keeps its document; the owner hides its view.
      bridge.on("doc:active", () => {}),
      // Every edit is sent as it is made: nothing waits to be flushed.
      bridge.on("doc:flush", () => bridge.post("doc:flushed")),
      bridge.on("doc:locale", (payload) => { void activateLocale((payload as { locale: Locale }).locale); }),
      bridge.on("md:reveal", (payload) => {
        const { line } = payload as { id: string; line: number };
        if (editorView) revealLine(editorView, line);
        else pendingReveal = line;
      }),
      bridge.on("tex:find", (payload) => {
        if (!editorView) return;
        const { step } = payload as { step: "open" | "next" | "previous" };
        if (step === "next") findNext(editorView);
        else if (step === "previous") findPrevious(editorView);
        else openSearchPanel(editorView);
      }),
      bridge.on("md:assets-changed", () => dispatch({ type: "assets" })),
      bridge.on("md:project", (payload) => {
        const { files: nextFiles, texSources: nextSources } = payload as { files: FileNode[]; texSources: string[] };
        dispatch({ type: "project", files: nextFiles, texSources: nextSources });
      }),
      bridge.on("tex:index", (payload) => dispatch({ type: "index", index: payload as ProjectIndex })),
      bridge.on("tex:root", (payload) => dispatch({ type: "root", rootDocument: (payload as { path: string | null }).path })),
      bridge.on("tex:build", (payload) => dispatch({ type: "build", build: (payload as { build: CompiledBuild | null }).build })),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, []);

  useEffect(() => {
    if (!opened || !ready || !visual) return;
    // A timer, as the structured pages' (`shared/document.tsx`): WebKit runs
    // no frames for a page still clipped away, and the host reveals it only on
    // this. The editor has committed by now; its first layout follows within
    // the delay.
    const timer = window.setTimeout(() => host().post("doc:drawn"), DRAWN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [opened, ready, visual]);

  const extensions = useMemo(() => (visual ? editorExtensions(visual, path) : []), [path, visual]);

  const onChange = useCallback((next: string, base: string) => {
    sendChange(next, base);
    dispatch({ type: "source", source: next });
  }, []);

  const saved = opened?.viewState;
  const onCreateEditor = useCallback((editor: EditorView) => {
    editorView = editor;
    dispatch({ type: "view", view: editor });
    const pending = pendingReveal;
    pendingReveal = null;
    if (pending !== null) {
      revealLine(editor, pending);
    } else if (saved) {
      const length = editor.state.doc.length;
      editor.dispatch({
        selection: EditorSelection.cursor(Math.min(saved.head, length)),
        effects: EditorView.scrollIntoView(Math.min(saved.top, length), { y: "start" }),
      });
    }
  }, [saved]);

  if (!opened || !ready || !visual) return null;
  return (
    <div className="source-workspace" data-tour="document-editor">
      <div className="source-main">
        <div className="source-editor" data-editor-pane="primary">
          <CodeMirrorHost
            key={`${opened.projectRoot}\n${opened.path}`}
            className="code-editor-root"
            label={opened.path}
            value={source}
            extensions={extensions}
            onChange={onChange}
            onUpdate={reportView}
            onCreateEditor={onCreateEditor}
          />
          <CodeMirrorScrollbar view={view} />
        </div>
      </div>
    </div>
  );
}

/** Put the caret at the start of the 1-based `line`, in the middle of the view, and the keyboard there. */
function revealLine(view: EditorView, line: number): void {
  const { doc } = view.state;
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
}

mount(() => <Latex />);
