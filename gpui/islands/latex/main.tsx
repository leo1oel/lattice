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
 *   tex:spelling      { enabled, words, ignores }   Settings' spell check, the project's dictionary and ignores
 *   tex:unused        { labels, citations }   what nothing uses (empty while TexLab reports it)
 *   tex:outline       { nodes, rootPath, pdf }   the manuscript's outline for the rail, and its PDF's token
 *   tex:annotations   { comments, author }   the project's local annotations on the file, and who signs a reply
 *   md:presence       { cursors }       co-authors' Overleaf carets (also `doc:open`'s `presence`)
 *   tex:overleaf      { threads, anchors, hues, mode, canAct }   a linked Overleaf project's threads on the
 *                     file, for their marks and margin review (also `doc:open`'s `overleaf`)
 *   tex:environment   { rename, name }   the window's dialog's name: wrap the selection in that
 *                     environment, or rename the one at the caret (`rename`), as the canvas does
 * Page to host:
 *   md:change         { source, base, join }  the whole file after an edit made against `base`;
 *                     `join` when the page's history counts it in the previous edit's undo group
 *   md:undo, md:redo
 *   md:caret          { line, column }  1-based, in the file
 *   md:open-path      { path }          an `\input`'s file, or a figure's
 *   md:open-location  { path, line }    a `\ref`'s label
 *   tex:open-citation { key }           a citation's entry
 *   doc:view-state    { viewState }     the caret and the line at the top, for a woken page
 *   tex:caret         { offset }        the caret, a UTF-16 offset, for the source to mirror
 *   tex:add-word      { word }          a lint card's Add to dictionary
 *   tex:ignore        { rule } | { sentence }   a lint card's Ignore
 *   tex:find-references, tex:rename  { kind, symbol }   a label's or citation key's (⇧F12, F2)
 *   tex:paste-image                     an image pasted: insert it as a figure
 *   tex:wrap-environment                ⌘⇧E: the window's Wrap in environment… dialog
 *   tex:rename-environment  { name }    ⌘⌥R on an environment: the window's rename dialog
 *   tex:outline-jump  { path, line }    an outline rail row
 *   tex:open-annotation, tex:resolve-annotation  { id }   a note's pin, its card's Resolve
 *   tex:reply-annotation  { id, body }  its card's Reply
 *   md:load-asset     (request) { path } → url | null
 */
import "../shared/install";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { t as tGlobal } from "@lingui/core/macro";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
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
import { wrapEnvironment } from "../../../src/editor/latex/latex-edits";
import { renameEnvironmentAt } from "../../../src/editor/latex/latex-environments";
import { editAndFocus } from "../../../src/canvas/source-selection-edits";
import {
  katexMacrosFromSources, mergeReferences, parseGraphicsPaths, parseLocalLabels, parseLocalMacros,
  type DefinitionTarget, type SymbolTarget,
} from "../../../src/editor/latex/latex-text";
import type { CompiledBuild } from "../../../src/editor/latex/compiled-labels";
import { flattenProjectPaths } from "../../../src/build/compile-diagnostics";
import type { IgnoreGrammar } from "../../../src/editor/harper-spellcheck";
import { LatexOutlineRail } from "../../../src/editor/latex/latex-outline-rail";
import { EditorCommentCards } from "../../../src/canvas/editor-comment-cards";
import { CommentCardHosts, editorCommentsExtension, setEditorCommentsEffect } from "../../../src/editor/comments/editor-comments";
import type { EditorComment } from "../../../src/editor/comments/editor-comment-data";
import {
  marginReviewExtension, overleafCursorsExtension, overleafTrackChangesExtension, setOverleafCursorsEffect,
  type PresenceCursor,
} from "../../../src/overleaf/overleaf-editor-extensions";
import { VisualMarginReview } from "./margin-review";
import {
  NO_OVERLEAF_REVIEW, changeAuthorName, overleafChangeActions, overleafEditorComments, overleafThreadActions,
  overleafThreadOf, type OverleafReview,
} from "./margin-review-data";
import {
  INITIAL_STATE, reduce, type LatexOpen, type Locale, type Outline, type ProjectIndex, type Spelling, type Unused,
  type Annotations, type ViewState, type VisualModule,
} from "./state";
import type { FileNode } from "../../../src/app-types";

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
/** Co-authors' carets and the file's annotations and Overleaf threads, read by their extensions when they run. */
let presenceCursors: PresenceCursor[] = [];
/** The file's Overleaf review, which the suggestions' marks and cards read when they run. */
let overleafReview: OverleafReview = NO_OVERLEAF_REVIEW;
let editorComments: EditorComment[] = [];
/** Where a note's card is drawn over its hovered passage (`EditorCommentCards`). */
const commentCards = new CommentCardHosts();
/** A gutter pin's name, as the canvas names it (`document-canvas.tsx`). */
const pinLabel = (numbers: number[]) => {
  const list = numbers.join(", ");
  return numbers.length === 1 ? tGlobal`Annotation ${list}` : tGlobal`Annotations ${list}`;
};
/** A card over a marked passage: a local annotation's, or an Overleaf thread's (as `use-editor-comments.ts` routes them). */
const resolveAnnotation = (id: string) => {
  const thread = overleafThreadOf(id);
  if (thread !== null) void overleafThreadActions.onResolve(thread, true);
  else host().post("tex:resolve-annotation", { id });
};
const replyToAnnotation = (id: string, body: string) => {
  const thread = overleafThreadOf(id);
  if (thread !== null) void overleafThreadActions.onReply(thread, body);
  else host().post("tex:reply-annotation", { id, body });
};
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
/** A lint card's Add to dictionary and Ignore, written to the project's manifest by the owner. */
const addSpellingWord = (word: string) => { host().post("tex:add-word", { word }); return true; };
const ignoreGrammar: IgnoreGrammar = (ignore) => { host().post("tex:ignore", ignore); return true; };
/** ⇧F12 and F2 on a label or citation key: the window's references bar and rename dialog. */
const askAboutSymbol = (type: string) => (target: SymbolTarget) => {
  host().post(type, { kind: target.kind, symbol: target.kind === "label" ? target.label : target.key });
};
/** ⌘⇧E and ⌘⌥R: the window's dialog asks for the name (`tex:environment` brings it back). */
const askToWrapEnvironment = () => host().post("tex:wrap-environment");
const askToRenameEnvironment = (name: string) => host().post("tex:rename-environment", { name });
/** The owner reads the pasted image from the clipboard, as ⌘V in the source does. */
const pasteImage = () => { host().post("tex:paste-image"); return true; };
const jumpToHeading = (path: string, line: number) => host().post("tex:outline-jump", { path, line });

function editorExtensions(visual: VisualModule, path: string, spellcheck: boolean, texlab: boolean): Extension[] {
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
    ...latexEditorExtensions({
      live: data,
      currentPath: path,
      spellcheck,
      texlab,
      loadReferenceImage: loadAsset,
      onGotoDefinition: openTarget,
      onFindReferences: askAboutSymbol("tex:find-references"),
      onRenameSymbol: askAboutSymbol("tex:rename"),
      onWrapEnvironment: askToWrapEnvironment,
      onRenameEnvironment: askToRenameEnvironment,
      onPasteImage: pasteImage,
      onTexlabGoto: (target, line) => host().post("md:open-location", { path: target, line }),
    }),
    // The source session's review layers (`source-session.ts`).
    overleafCursorsExtension({ getCursors: () => presenceCursors }),
    overleafTrackChangesExtension({
      getChanges: () => overleafReview.changes ?? [],
      authorName: (userId) => changeAuthorName(overleafReview, userId),
      canAct: () => overleafReview.canAct,
      ...overleafChangeActions,
    }),
    marginReviewExtension(),
    editorCommentsExtension(path, {
      pinLabel,
      cards: commentCards,
      onOpenAnnotation: (comment) => host().post("tex:open-annotation", { id: comment.id }),
      getComments: () => editorComments,
      getDraft: () => null,
    }),
  ];
}

/** The page's undo depth after its last edit (`sendChange`). */
let lastUndoDepth = 0;

/**
 * Send an edit, and say whether the page's own history (the host's
 * `history()`, as in the Tauri app) put it in the previous edit's undo group:
 * ⌘Z goes to the buffer, which then undoes what the Tauri app's editor would,
 * a word typed in one go at once, whatever the edits' arrival times.
 */
function sendChange(next: string, base: string): void {
  pageSource = next;
  const depth = editorView ? undoDepth(editorView.state) : 0;
  const join = depth > 0 && depth === lastUndoDepth;
  lastUndoDepth = depth;
  host().post("md:change", { source: next, base, join });
}

function reportView(update: ViewUpdate): void {
  if (!update.selectionSet && !update.docChanged && !update.viewportChanged) return;
  const head = update.state.selection.main.head;
  if (update.selectionSet || update.docChanged) {
    const line = update.state.doc.lineAt(head);
    host().post("md:caret", { line: line.number, column: head - line.from + 1 });
    host().post("tex:caret", { offset: head });
  }
  const top = update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop).from;
  host().post("doc:view-state", { viewState: { head, top } satisfies ViewState });
}

function Latex() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const {
    opened, source, settled, ready, files, texSources, index, rootDocument, build, assetRevision, visual, view,
    spelling, unused, outline, annotations, presence, overleaf,
  } = state;
  const { t } = useLingui();
  const texlab = opened?.texlab ?? false;

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
      // With TexLab the Tauri app leaves unused symbols to its diagnostics.
      unusedLabels: texlab ? [] : unused.labels,
      unusedCitations: texlab ? [] : unused.citations,
      localMacros,
      graphicsRoots,
      projectPaths,
      rootDocumentPath: rootDocument ?? undefined,
      projectRoot,
      katexMacros,
      compiledBuild: build ?? undefined,
      spellingWords: spelling.words,
      onAddSpellingWord: addSpellingWord,
      grammarIgnores: spelling.ignores,
      onIgnoreGrammar: ignoreGrammar,
    };
    // Draw again from the new data, and lint against the new index.
    editorView?.dispatch({ effects: [latexVisualDataChanged.of(null), latexIndexChanged.of(null)] });
  }, [
    build, citationKeys, graphicsRoots, index, katexMacros, localMacros, projectPaths, projectRoot, references,
    rootDocument, spelling, texlab, unused,
  ]);
  // A linked Overleaf project's threads on the file, as comments to mark.
  const openedPath = opened?.path ?? "";
  const overleafComments = useMemo(() => overleafEditorComments(overleaf, openedPath), [openedPath, overleaf]);
  // Co-authors' carets, the file's annotations and its Overleaf threads,
  // pushed to the editor as they change (`use-source-session.ts` pushes the
  // same effects).
  useEffect(() => {
    presenceCursors = presence;
    editorView?.dispatch({ effects: setOverleafCursorsEffect.of(presence) });
  }, [presence]);
  // Its suggestions: read by their extension on the next transaction.
  useEffect(() => {
    overleafReview = overleaf;
    editorView?.dispatch({});
  }, [overleaf]);
  useEffect(() => {
    editorComments = [...annotations.comments, ...overleafComments];
    editorView?.dispatch({ effects: setEditorCommentsEffect.of(editorComments) });
  }, [annotations.comments, overleafComments]);
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
      bridge.on("tex:environment", (payload) => {
        if (!editorView) return;
        const { rename, name } = payload as { rename: boolean; name: string };
        const { state } = editorView;
        if (rename) {
          const edits = renameEnvironmentAt(state.doc.toString(), state.selection.main.head, name);
          if (edits) editAndFocus(editorView, { changes: edits });
        } else {
          const { from, to } = state.selection.main;
          const edit = wrapEnvironment(state.doc.toString(), from, to, name);
          editAndFocus(editorView, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
        }
      }),
      bridge.on("md:assets-changed", () => dispatch({ type: "assets" })),
      bridge.on("md:project", (payload) => {
        const { files: nextFiles, texSources: nextSources } = payload as { files: FileNode[]; texSources: string[] };
        dispatch({ type: "project", files: nextFiles, texSources: nextSources });
      }),
      bridge.on("tex:index", (payload) => dispatch({ type: "index", index: payload as ProjectIndex })),
      bridge.on("tex:root", (payload) => dispatch({ type: "root", rootDocument: (payload as { path: string | null }).path })),
      bridge.on("tex:build", (payload) => dispatch({ type: "build", build: (payload as { build: CompiledBuild | null }).build })),
      bridge.on("tex:spelling", (payload) => dispatch({ type: "spelling", spelling: payload as Spelling })),
      bridge.on("tex:unused", (payload) => dispatch({ type: "unused", unused: payload as Unused })),
      bridge.on("tex:outline", (payload) => dispatch({ type: "outline", outline: payload as Outline })),
      bridge.on("tex:annotations", (payload) => dispatch({ type: "annotations", annotations: payload as Annotations })),
      bridge.on("tex:overleaf", (payload) => dispatch({ type: "overleaf", overleaf: payload as OverleafReview })),
      bridge.on("md:presence", (payload) => {
        dispatch({ type: "presence", presence: (payload as { cursors: PresenceCursor[] }).cursors });
      }),
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

  // Built again only when what they run changes: spell checking turned on
  // or off, which the Tauri app's source session rebuilds for too.
  const extensions = useMemo(
    () => (visual ? editorExtensions(visual, path, spelling.enabled, texlab) : []),
    [path, spelling.enabled, texlab, visual],
  );

  const onChange = useCallback((next: string, base: string) => {
    sendChange(next, base);
    dispatch({ type: "source", source: next });
  }, []);

  const saved = opened?.viewState;
  const onCreateEditor = useCallback((editor: EditorView) => {
    editorView = editor;
    lastUndoDepth = 0;
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
          <EditorCommentCards
            cards={commentCards}
            author={annotations.author}
            onResolve={resolveAnnotation}
            onReply={replyToAnnotation}
          />
          {view && (
            <VisualMarginReview view={view} path={opened.path} review={overleaf} comments={overleafComments} />
          )}
          {view && (
            <LatexOutlineRail
              view={view}
              path={opened.path}
              source={settled}
              nodes={outline.nodes}
              rootPath={outline.rootPath}
              label={t`Outline`}
              pdfUrl={outline.pdf}
              onSelect={jumpToHeading}
            />
          )}
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
