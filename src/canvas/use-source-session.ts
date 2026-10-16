/**
 * The source editor's session: the live CodeMirror view, the extensions it
 * runs and how long they live, the annotation note being written in it, and
 * the editor-local status (caret, selection, completion) shown around it.
 *
 * The extensions keep one identity per `SourceSessionConfig` (see
 * source-session.ts), held in state and replaced only when the configuration
 * changes: typing, moving the caret and every other prop update leave the
 * editor configured as it was. That is a contract, not a cache: CodeMirrorHost
 * reconfigures on any new identity. What the extensions read while they run
 * comes through committed getters, and the effects below push the values a
 * mounted view must repaint for (diagnostics, comments, the note, carets).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { completionStatus } from "@codemirror/autocomplete";
import { forceLinting as refreshLint } from "@codemirror/lint";
import type { SelectionRange, Text } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { AgentSelectionLines } from "../agent/agent-host-context";
import { CommentCardHosts, setEditorCommentDraftEffect, setEditorCommentsEffect } from "../editor/comments/editor-comments";
import { harperDictionaryChanged } from "../editor/harper-spellcheck";
import { latexIndexChanged } from "../editor/latex/latex-editor";
import { setOverleafCursorsEffect } from "../overleaf/overleaf-editor-extensions";
import { isHarperProseFilePath } from "../app-utils";
import { useCommittedRef } from "../hooks/use-latest-ref";
import type { AnnotationDraft } from "./annotation-composer";
import type { DocumentCanvasProps } from "./canvas-model";
import { isLatexSourcePath, useOptionalKeymapExtensions, useTextLanguageExtensions } from "./editor-extensions";
import type { ProofreadBridge } from "./proofread-bridge";
import { sameSourceConfig, sourceSessionExtensions, type SourceSessionConfig, type SourceSessionLive } from "./source-session";

/** The lines a non-empty selection covers; one that ends at a line's start stops on the line before. */
function selectionLines(doc: Text, range: SelectionRange): AgentSelectionLines {
  const start = doc.lineAt(range.from).number;
  const last = doc.lineAt(range.to);
  return { start, end: Math.max(start, range.to === last.from ? last.number - 1 : last.number) };
}

type SourceSessionOptions = {
  /** The canvas's committed props (`useCommittedRef`), read when the editor runs. */
  latestRef: RefObject<DocumentCanvasProps>;
  proofread: ProofreadBridge;
  /** The accessible name of an annotation pin over `numbers`. */
  pinLabel: (numbers: number[]) => string;
  /** The canvas's own answer to an editor update; `path` is the file the canvas shows, empty when none. */
  onEditorUpdate: (update: ViewUpdate, path: string) => void;
};

export function useSourceSession(props: DocumentCanvasProps, options: SourceSessionOptions) {
  const { latestRef, proofread } = options;
  const { activeFile: path, editorKey } = props.document;
  const { buildDiagnostics, texlabDiagnostics } = props.status;
  const { editorComments, overleafPresenceCursors } = props.review;
  const optionsRef = useCommittedRef(options);

  /** The live view, while one is mounted, and the document it was built for. */
  const viewRef = useRef<EditorView | null>(null);
  const viewPathRef = useRef("");
  /** Where one-shot edits (citations, environments, tables) land: the editor last focused or mounted. */
  const insertionViewRef = useRef<EditorView | null>(null);
  // Weak on purpose; deref at the point of use and never keep the result in a
  // render-scope variable. Every closure created while rendering captures this
  // render's scope, and a CodeMirror view keeps its handlers' closures alive
  // for its whole life. A strong reference here chained each editor to the one
  // before it (new view → closure → render scope → previous view), so every
  // file switch retained the previous editor and its whole document.
  const [view, setView] = useState<WeakRef<EditorView> | null>(null);

  const [position, setPosition] = useState({ line: 1, column: 0 });
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selectedText, setSelectedText] = useState("");
  const completionActiveRef = useRef(false);

  /** The annotation note being written, and (weakly, as above) the view it was opened in. */
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [draftView, setDraftView] = useState<WeakRef<EditorView> | null>(null);
  const draftRef = useCommittedRef(draft);
  const openDraft = useCallback((inView: EditorView, next: AnnotationDraft) => {
    setDraftView(new WeakRef(inView));
    setDraft(next);
  }, []);

  const comments = useMemo(() => editorComments.filter((comment) => comment.path === path), [editorComments, path]);
  const commentsRef = useCommittedRef(comments);

  const [live] = useState<SourceSessionLive>(() => ({
    props: () => latestRef.current,
    comments: () => commentsRef.current,
    draft: () => draftRef.current,
    pinLabel: (numbers) => optionsRef.current.pinLabel(numbers),
  }));
  const [commentCards] = useState(() => new CommentCardHosts());
  const [keymap, vimMode] = useOptionalKeymapExtensions(props.preferences.editorKeymap);
  const language = useTextLanguageExtensions(isLatexSourcePath(path) ? "" : path);
  const config: SourceSessionConfig = {
    path,
    spellcheck: props.preferences.editorSpellcheck && isHarperProseFilePath(path),
    keymap,
    language,
    proofread: proofread.extension,
    reviewBridge: props.review.annotationRounds.reviewBridge,
    commentCards,
  };
  const [configured, setConfigured] = useState(() => ({ config, extensions: sourceSessionExtensions(config, live) }));
  let extensions = configured.extensions;
  if (!sameSourceConfig(configured.config, config)) {
    const next = { config, extensions: sourceSessionExtensions(config, live) };
    setConfigured(next);
    extensions = next.extensions;
  }

  // Values the mounted view repaints for, pushed as they change. A view built
  // since (a remount for another document, a parked one resuming) is pushed
  // again: a reconfigure keeps a field's old value.
  useEffect(() => {
    if (viewRef.current) refreshLint(viewRef.current);
  }, [buildDiagnostics, texlabDiagnostics]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: latexIndexChanged.of(null) });
  }, [props.bibliography.indexPending]);

  useEffect(() => {
    const current = viewRef.current;
    if (!current) return;
    current.dispatch({ effects: harperDictionaryChanged.of(null) });
    refreshLint(current);
  }, [props.preferences.spellingWords, props.preferences.englishVariant]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setEditorCommentsEffect.of(comments) });
  }, [comments, editorKey]);

  useLayoutEffect(() => {
    const shown = draft?.path === path ? draft : null;
    viewRef.current?.dispatch({ effects: setEditorCommentDraftEffect.of(shown) });
  }, [path, draft, editorKey]);

  // Someone else's caret has to repaint when they move it, not when we type next.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setOverleafCursorsEffect.of(overleafPresenceCursors) });
  }, [overleafPresenceCursors, editorKey]);

  useEffect(() => () => {
    if (completionActiveRef.current) latestRef.current.document.onCompletionActiveChange(false);
  }, [latestRef]);

  const reportPosition = (current: EditorView, at: string) => {
    const head = current.state.selection.main.head;
    const line = current.state.doc.lineAt(head);
    const column = head - line.from;
    setCursorOffset(head);
    setPosition((shown) => shown.line === line.number && shown.column === column ? shown : { line: line.number, column });
    latestRef.current.navigation.onEditorPosition({ path: at, line: line.number, column });
    latestRef.current.navigation.onViewState(at, { cursor: head, scrollTop: current.scrollDOM.scrollTop });
  };

  // Also the board's and spreadsheet's change handler, so it keeps one identity.
  const onChange = useCallback((value: string) => latestRef.current.document.setSource(value), [latestRef]);
  /** CodeMirrorHost's props for this session's editor; it reads its handlers' newest identities. */
  const host = {
    extensions,
    onCreateEditor: (created: EditorView) => {
      viewRef.current = created;
      viewPathRef.current = path;
      setView(new WeakRef(created));
      insertionViewRef.current = created;
      reportPosition(created, path);
    },
    onChange,
    onUpdate: (update: ViewUpdate) => {
      // "pending" keeps the last answer. In LaTeX every typed letter queries the
      // completion sources (pending) and usually finds nothing (null), and
      // reporting both edges re-rendered all of App twice per keystroke. A menu
      // that is already open stays active while it refreshes its results.
      const status = completionStatus(update.state);
      const completionActive = status === "active" || (status === "pending" && completionActiveRef.current);
      if (completionActiveRef.current !== completionActive) {
        completionActiveRef.current = completionActive;
        latestRef.current.document.onCompletionActiveChange(completionActive);
      }
      const { state } = update;
      const range = state.selection.main;
      const nextSelection = range.empty ? "" : state.sliceDoc(range.from, range.to);
      latestRef.current.selection.setSelection(nextSelection, range.empty ? undefined : selectionLines(state.doc, range));
      setSelectedText(nextSelection);
      // The update listener outlives a file switch by a render: it answers for
      // the file the canvas shows now.
      const shownPath = latestRef.current.document.activeFile;
      optionsRef.current.onEditorUpdate(update, shownPath);
      if (shownPath) reportPosition(update.view, shownPath);
      if (range.empty) setDraft(null);
    },
  };

  return {
    /** The live view; read in handlers and effects, never while rendering. */
    viewRef,
    viewPathRef,
    insertionViewRef,
    /** The mounted view, as state, for children that draw over it. */
    view,
    host,
    position,
    setPosition,
    cursorOffset,
    selectedText,
    vimMode,
    /** The open file's comments. */
    comments,
    commentCards,
    draft,
    setDraft,
    /** The view the note was opened in, fixed while it is open. */
    draftView,
    openDraft,
  };
}
