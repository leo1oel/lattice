/**
 * The Markdown island: a `.md` file's Preview, which in the Tauri app is its
 * visual editor (Lattice's own engine over TipTap,
 * `src/editor/markdown/engine/lattice-visual-editor.tsx`), laid in the
 * canvas's scroll area (`.markdown-preview`, `.editor-doc-scroll`) as
 * `document-canvas.tsx` lays it, with that canvas's host contract
 * (`visual-editor-props.ts`) answered here and by the owner in the GPUI app
 * (`gpui/crates/lattice-gpui/src/structured/markdown.rs`).
 *
 * The owner holds the file's text in its editor buffer, as every document's;
 * the page renders its body (the text after any front matter, which the
 * visual editor never sees) and writes an edit back as the whole file, so
 * the front matter and every byte the edit did not touch stay as they were.
 * As in the canvas:
 *
 * - text from the owner settles before the editor takes it
 *   (`useSettledPreviewText`: 200 ms after typing pauses, at most 1.5 s, more
 *   for a long file), except the page's own edit coming back;
 * - an edit splices the new body after the front matter
 *   (`spliceMarkdownBody`) and lands only on the text it was made against:
 *   the owner applies it as the minimal change from `base`, or refuses it and
 *   sends the buffer's text, which the editor then takes;
 * - undo and redo are the buffer's (the canvas's CodeMirror history when the
 *   source is mounted), so the two views step through one history.
 *
 * Host to page, beside the document protocol's `doc:open` (with `projectRoot`,
 * `files`, `texSources`, `split`), `doc:source`, `doc:active`, `doc:flush`
 * and `doc:locale`:
 *   md:split          { split }         the view is Split (source labels kept for its scroll sync)
 *   md:reveal         { id, line }      land on a 1-based line of the file
 *   md:assets-changed                   project files changed: images load again
 *   md:project        { files, texSources }   the project's tree and TeX sources changed
 *   md:scroll-to      { center, min, max }   Split: the line at the source's centre, and its range
 * Page to host:
 *   md:change         { source, base }  the whole file after an edit made against `base`
 *   md:undo, md:redo
 *   md:view-in-source { offset }        show the source with the caret at a UTF-16 offset
 *   md:open-path      { path }          a project link followed
 *   md:caret          { line, column }  1-based, in the file
 *   md:scrolled       { center }        Split: the source line the preview's centre maps to
 *   md:read           (request) { path } → text   a project file, for the page index
 *   md:load-asset     (request) { path } → url | null
 *   md:import-asset   (request) { base64, type } → project path | null
 */
import "../shared/install";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { mount, activateLocale } from "../shared/boot";
import { host } from "../shared/host";
import { LineIndex, SplitScroll } from "./split-scroll";
import "./markdown.css";
import { ScrollArea } from "../../../src/components/ui/scroll-area";
import { LatticeVisualMarkdownEditor } from "../../../src/editor/markdown/engine/lattice-visual-editor";
import { MarkdownWorkspaceIndex } from "../../../src/editor/markdown/markdown-workspace-index";
import type { VisualRevealTarget } from "../../../src/editor/markdown/visual-editor-props";
import { katexMacrosFromSources } from "../../../src/editor/latex/latex-text";
import { markdownFrontmatterEnd } from "../../../src/app-utils";
import type { FileNode } from "../../../src/app-types";
import {
  capturePreviewViewport, restorePreviewViewport, spliceMarkdownBody, useSettledPreviewText,
  type PreviewViewportSnapshot,
} from "../../../src/canvas/markdown-preview-sync";

type Locale = "en" | "zh-CN";

type MarkdownOpen = {
  path: string;
  source: string;
  projectRoot: string;
  viewState?: PreviewViewportSnapshot | null;
  locale: Locale;
  active: boolean;
  split: boolean;
  editable: boolean;
  files: FileNode[];
  texSources: string[];
};

type Reveal = { id: string; target: VisualRevealTarget };

type State = {
  opened: MarkdownOpen | null;
  source: string;
  split: boolean;
  ready: boolean;
  assetRevision: number;
  reveal: Reveal | null;
  files: FileNode[];
  texSources: string[];
};

type Action =
  | { type: "open"; open: MarkdownOpen }
  | { type: "source"; source: string }
  | { type: "split"; split: boolean }
  | { type: "ready" }
  | { type: "assets" }
  | { type: "reveal"; reveal: Reveal | null }
  | { type: "project"; files: FileNode[]; texSources: string[] };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return {
        ...state, opened: action.open, source: action.open.source, split: action.open.split,
        files: action.open.files, texSources: action.open.texSources, reveal: null,
      };
    case "source":
      return { ...state, source: action.source };
    case "split":
      return { ...state, split: action.split };
    case "ready":
      return { ...state, ready: true };
    case "assets":
      return { ...state, assetRevision: state.assetRevision + 1 };
    case "reveal":
      return { ...state, reveal: action.reveal };
    case "project":
      return { ...state, files: action.files, texSources: action.texSources };
  }
}

/** How long after its commit the editor is taken to have drawn (`shared/document.tsx`). */
const DRAWN_DELAY_MS = 120;

/** The editor's flush of an edit it is still holding (`onFlushPendingChange`). */
let pendingFlush: (() => boolean) | null = null;

const readProjectFile = (path: string) => host().request<string>("md:read", { path });
const loadAsset = (path: string) => host().request<string | null>("md:load-asset", { path }).catch(() => null);

async function importAsset(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return host().request<string | null>("md:import-asset", { base64: btoa(binary), type: file.type || "image/png" })
    .catch(() => null);
}

/** The number of lines before `offset` in `text`. */
function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line += 1;
  return line;
}

function Markdown() {
  const [state, dispatch] = useReducer(reduce, {
    opened: null, source: "", split: false, ready: false, assetRevision: 0, reveal: null, files: [], texSources: [],
  });
  const { opened, source, split, ready, assetRevision, reveal, files, texSources } = state;
  // The file as the page has it: the owner's latest, or the page's own edit.
  const sourceRef = useRef(source);
  useLayoutEffect(() => { sourceRef.current = source; }, [source]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Split's scroll coordination (`split-scroll.ts`), over the file's lines.
  const splitScrollRef = useRef<SplitScroll | null>(null);
  const linesRef = useRef<{ text: string; lines: LineIndex } | null>(null);
  const splitRef = useRef(split);
  useLayoutEffect(() => { splitRef.current = split; }, [split]);

  const start = markdownFrontmatterEnd(source);
  const body = source.slice(start);
  const lineOffset = useMemo(() => lineOf(source, start), [source, start]);
  const { settled, markEcho } = useSettledPreviewText(source, body, opened?.path ?? "");

  const workspaceIndex = useMemo(() => new MarkdownWorkspaceIndex(readProjectFile), []);
  useEffect(() => { void workspaceIndex.update(files); }, [files, workspaceIndex]);
  const macros = useMemo(() => katexMacrosFromSources(texSources), [texSources]);

  useEffect(() => {
    const bridge = host();
    const stops = [
      bridge.on("doc:open", (payload) => {
        const open = payload as MarkdownOpen;
        dispatch({ type: "open", open });
        void activateLocale(open.locale).then(() => dispatch({ type: "ready" }));
      }),
      bridge.on("doc:source", (payload) => {
        const next = (payload as { source: string }).source;
        if (next !== sourceRef.current) dispatch({ type: "source", source: next });
      }),
      // A hidden page keeps its document; the owner hides its view.
      bridge.on("doc:active", () => {}),
      // The editor's flush calls onChangeMarkdown at once, so its md:change goes first.
      bridge.on("doc:flush", () => {
        pendingFlush?.();
        bridge.post("doc:flushed");
      }),
      bridge.on("doc:locale", (payload) => { void activateLocale((payload as { locale: Locale }).locale); }),
      bridge.on("md:split", (payload) => dispatch({ type: "split", split: Boolean((payload as { split: boolean }).split) })),
      bridge.on("md:reveal", (payload) => {
        const { id, line } = payload as { id: string; line: number };
        // The editor counts lines in the body it renders.
        const bodyLine = Math.max(1, line - lineOf(sourceRef.current, markdownFrontmatterEnd(sourceRef.current)));
        dispatch({ type: "reveal", reveal: { id, target: { line: bodyLine } } });
      }),
      bridge.on("md:assets-changed", () => dispatch({ type: "assets" })),
      bridge.on("md:project", (payload) => {
        const { files: nextFiles, texSources: nextSources } = payload as { files: FileNode[]; texSources: string[] };
        dispatch({ type: "project", files: nextFiles, texSources: nextSources });
      }),
      bridge.on("md:scroll-to", (payload) => {
        const { center, min, max } = payload as { center: number; min: number; max: number };
        splitScrollRef.current?.followSource(center, min, max);
      }),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, []);

  useEffect(() => {
    if (!opened || !ready) return;
    // A timer, as the structured pages' (`shared/document.tsx`): WebKit runs
    // no frames for a page still clipped away, and the host reveals it only on
    // this. The editor has committed by now; its first layout follows within
    // the delay.
    const timer = window.setTimeout(() => host().post("doc:drawn"), DRAWN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [opened, ready]);

  // The reader's place: kept by the owner for the session, so a woken page
  // (or the file opened again) shows where it was left.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!opened || !ready || !viewport) return;
    const saved = opened.viewState;
    let frame = 0;
    let tries = 0;
    const restore = () => {
      if (!saved || restorePreviewViewport(viewport, saved) || ++tries > 30) return;
      frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    // Split's map of the blocks, measured again once the layout changes.
    const text = () => {
      const current = sourceRef.current;
      if (linesRef.current?.text !== current) linesRef.current = { text: current, lines: new LineIndex(current) };
      return { lines: linesRef.current.lines, bodyStart: markdownFrontmatterEnd(current) };
    };
    const splitScroll = new SplitScroll(viewport, text);
    splitScrollRef.current = splitScroll;
    const resized = new ResizeObserver(() => splitScroll.invalidate());
    resized.observe(viewport);
    if (viewport.firstElementChild) resized.observe(viewport.firstElementChild);
    let pending = 0;
    const report = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        host().post("doc:view-state", { viewState: capturePreviewViewport(viewport) });
        if (!splitRef.current) return;
        const center = splitScroll.sourceCenter();
        if (center != null) host().post("md:scrolled", { center });
      });
    };
    viewport.addEventListener("scroll", report, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pending);
      viewport.removeEventListener("scroll", report);
      resized.disconnect();
      splitScrollRef.current = null;
    };
  }, [opened, ready]);
  // New text lays the blocks out again.
  useEffect(() => { splitScrollRef.current?.invalidate(); }, [settled]);

  const onChangeMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    const base = sourceRef.current;
    const splice = spliceMarkdownBody(base, markdownFrontmatterEnd(base), expectedBody, nextBody);
    if (!splice) return false;
    const next = `${splice.prefix}${splice.inserted}`;
    // The page's own edit: the preview takes it at once when it comes back.
    markEcho(next);
    sourceRef.current = next;
    dispatch({ type: "source", source: next });
    host().post("md:change", { source: next, base });
    return true;
  }, [markEcho]);

  const onUndo = useCallback(() => { host().post("md:undo"); return true; }, []);
  const onRedo = useCallback(() => { host().post("md:redo"); return true; }, []);
  const onFlushPendingChange = useCallback((flush: (() => boolean) | null) => { pendingFlush = flush; }, []);
  const onViewInSource = useCallback((offset: number) => {
    host().post("md:view-in-source", { offset: markdownFrontmatterEnd(sourceRef.current) + offset });
  }, []);
  const onOpenProjectPath = useCallback((path: string) => host().post("md:open-path", { path }), []);
  const onCaretChange = useCallback((row: number, column: number) => {
    host().post("md:caret", { line: row + lineOffset + 1, column });
  }, [lineOffset]);
  const onRevealHandled = useCallback((id: string) => {
    if (reveal?.id === id) dispatch({ type: "reveal", reveal: null });
  }, [reveal]);

  if (!opened || !ready) return null;
  return (
    <ScrollArea
      className="markdown-preview"
      // Wide tables, code and formulas own their horizontal overflow.
      orientation="vertical"
      // Mask gradients repaint the whole editable surface while scrolling in WebKit.
      fadeEdges={false}
      contentClassName="markdown-preview-content"
      // The visual editor finds its scroller through `.editor-doc-scroll`.
      viewportClassName="editor-doc-scroll"
      viewportProps={{
        "data-testid": "editor-scroll-container",
        // Split follows the source itself; native anchoring would be a second writer.
        style: split ? { overflowAnchor: "none" } : undefined,
      }}
      viewportRef={viewportRef}
      style={{ flex: "1 1 0", minWidth: 0 }}
    >
      <Fragment key={`${opened.projectRoot}\n${opened.path}`}>
        <LatticeVisualMarkdownEditor
          text={settled}
          activePath={opened.path}
          projectRoot={opened.projectRoot}
          onChangeMarkdown={onChangeMarkdown}
          onFlushPendingChange={onFlushPendingChange}
          synchronizeSourceScroll={split || reveal !== null}
          revealRequest={reveal}
          onRevealHandled={onRevealHandled}
          onOpenProjectPath={onOpenProjectPath}
          workspaceIndex={workspaceIndex}
          macros={macros}
          onUndo={onUndo}
          onRedo={onRedo}
          onViewInSource={onViewInSource}
          onImportAsset={importAsset}
          onLoadAsset={loadAsset}
          assetRevision={assetRevision}
          editable={opened.editable}
          onCaretChange={onCaretChange}
        />
      </Fragment>
    </ScrollArea>
  );
}

mount(() => <Markdown />);
