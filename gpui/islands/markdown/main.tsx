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
 *   md:pages-changed  { paths }       these Markdown files' text changed (null: any may have): the page index reads them again
 *   md:scroll-to      { center, min, max }   Split: the line at the source's centre, and its range
 *   md:paper          { paper }       the file is a saved paper's reading text (null: it is not)
 *   md:presence       { cursors }       co-authors' carets, rows of the file (also `doc:open`'s `presence`)
 *   md:overleaf       { changes, authors, canAct }   Overleaf's suggestions on the file, painted with their cards (also `doc:open`'s `overleaf`)
 *   doc:editable      { editable }      the file may (not) be edited here
 * Page to host:
 *   md:change         { source, base }  the whole file after an edit made against `base`
 *   md:undo, md:redo
 *   md:overleaf-accept, md:overleaf-reject   { id }   a suggestion card's Accept or Reject
 *   md:view-in-source { offset }        show the source with the caret at a UTF-16 offset
 *   md:open-path      { path }          a project link followed
 *   md:caret          { line, column }  1-based, in the file
 *   md:selection      { text }          the visual editor's selection, for the Agent
 *   md:scrolled       { center }        Split: the source line the preview's centre maps to
 *   md:masthead       { inView }        a paper's masthead (its title at the top) is on screen or not
 *   md:paper-source   { page, first, last }   a source link into the paper's own PDF was followed
 *   md:read           (request) { path } → text   a project file, for the page index
 *   md:load-asset     (request) { path } → url | null
 *   md:import-asset   (request) { base64, type } → project path | null
 */
import "../shared/install";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { mount, activateLocale } from "../shared/boot";
import { host } from "../shared/host";
import { LineIndex, SplitScroll } from "./split-scroll";
import "./markdown.css";
import { ScrollArea } from "../../../src/components/ui/scroll-area";
import { InlineMessage } from "../../../src/components/ui/inline-message";
import { paperSourceCitation } from "../../../src/papers/paper-source";
import { LatticeVisualMarkdownEditor } from "../../../src/editor/markdown/engine/lattice-visual-editor";
import { MarkdownWorkspaceIndex } from "../../../src/editor/markdown/markdown-workspace-index";
import type { VisualRevealTarget } from "../../../src/editor/markdown/visual-editor-props";
import { katexMacrosFromSources } from "../../../src/editor/latex/latex-text";
import { markdownFrontmatterEnd } from "../../../src/app-utils";
import type { FileNode } from "../../../src/app-types";
import { t as tGlobal } from "@lingui/core/macro";
import type { PresenceCursor, TrackedChangeTooltipActions } from "../../../src/overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../../src/overleaf/overleaf-realtime-model";
import { restoreViewportAround } from "../../../src/canvas/viewport-restore";
import {
  capturePreviewViewport, restorePreviewViewport, spliceMarkdownBody, useSettledPreviewText,
  type PreviewViewportSnapshot,
} from "../../../src/canvas/markdown-preview-sync";

type Locale = "en" | "zh-CN";

/**
 * A saved paper's reading text, as the Tauri canvas reads it
 * (`document-canvas.tsx`, `activePaper`): the visual editor in its reading
 * form, and over the full text (not the overview) its masthead, the title and
 * the whole author list at the top of the column.
 */
type PaperReading = {
  title: string;
  authors: string | null;
  fullText: boolean;
  /** The paper's identity, when its reader can show its original PDF. */
  pdf: { arxivId: string; url: string | null; hasLocalPdf: boolean } | null;
};

/**
 * A plain click on a source link into this paper's own PDF (a page, its
 * quote's first and last words in the title) opens the PDF in the reader at
 * that page rather than the browser (`followPaperSourceLink`). Any other
 * link, a modified click, or a drag that selected text is left to the editor.
 */
function followSourceLink(event: React.MouseEvent, paper: PaperReading | null) {
  if (!paper?.pdf || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (window.getSelection()?.isCollapsed === false) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link) return;
  const citation = paperSourceCitation({ ...paper.pdf, url: paper.pdf.url ?? undefined }, link.href, link.title);
  if (!citation) return;
  event.preventDefault();
  event.stopPropagation();
  host().post("md:paper-source", citation);
}

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
  paper?: PaperReading | null;
  presence?: PresenceCursor[];
  overleaf?: Partial<MarkdownOverleaf>;
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
  paper: PaperReading | null;
  /** Co-authors' carets, by rows of the file. */
  presence: PresenceCursor[];
  /** Overleaf's suggestions on the file, positioned in it. */
  overleaf: MarkdownOverleaf;
};

/** What the owner sends of Overleaf's suggestions (`md:overleaf`, `markdown_host.rs`). */
type MarkdownOverleaf = { changes: TrackedChange[]; authors: [string, string][]; canAct: boolean };
const NO_OVERLEAF: MarkdownOverleaf = { changes: [], authors: [], canAct: false };

type Action =
  | { type: "open"; open: MarkdownOpen }
  | { type: "source"; source: string }
  | { type: "split"; split: boolean }
  | { type: "ready" }
  | { type: "assets" }
  | { type: "reveal"; reveal: Reveal | null }
  | { type: "project"; files: FileNode[]; texSources: string[] }
  | { type: "paper"; paper: PaperReading | null }
  | { type: "presence"; presence: PresenceCursor[] }
  | { type: "overleaf"; overleaf: MarkdownOverleaf }
  | { type: "editable"; editable: boolean };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return {
        ...state, opened: action.open, source: action.open.source, split: action.open.split,
        files: action.open.files, texSources: action.open.texSources, reveal: null,
        paper: action.open.paper ?? null,
        presence: action.open.presence ?? [],
        overleaf: { ...NO_OVERLEAF, ...action.open.overleaf },
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
    case "paper":
      return { ...state, paper: action.paper };
    case "presence":
      return { ...state, presence: action.presence };
    case "overleaf":
      return { ...state, overleaf: action.overleaf };
    case "editable":
      return state.opened ? { ...state, opened: { ...state.opened, editable: action.editable } } : state;
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
    paper: null,
    presence: [],
    overleaf: NO_OVERLEAF,
  });
  const { opened, source, split, ready, assetRevision, reveal, files, texSources, paper, presence, overleaf } = state;
  // Why the engine cannot show this full text as written, for its masthead
  // (`onEligibilityChange`, `paperVisualEligibilityReason`).
  const [eligibility, setEligibility] = useState<string | null>(null);
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
  const filesRef = useRef(files);
  useLayoutEffect(() => { filesRef.current = files; }, [files]);
  // The open file's headings and title follow its text, as the canvas's do.
  useEffect(() => {
    if (opened) workspaceIndex.noteDocumentContent(opened.path, settled);
  }, [opened, settled, workspaceIndex]);
  const macros = useMemo(() => katexMacrosFromSources(texSources), [texSources]);
  // The editor counts rows in the body it renders (`markdownVisualCursors`).
  const presenceCursors = useMemo(
    () => presence
      .filter((cursor) => cursor.row >= lineOffset)
      .map((cursor) => ({ ...cursor, row: cursor.row - lineOffset })),
    [lineOffset, presence],
  );
  // Suggestions within the body the editor renders, moved past the front
  // matter it never shows (`markdownVisualChanges`).
  const overleafChanges = useMemo(() => overleaf.changes.flatMap((change) => {
    const end = change.deletion ? change.position : change.position + change.text.length;
    return change.position < start || end > source.length ? [] : [{ ...change, position: change.position - start }];
  }), [overleaf.changes, source.length, start]);
  const overleafTrackChangeActions = useMemo((): TrackedChangeTooltipActions => ({
    authorName: (userId) => overleaf.authors.find(([id]) => id === userId)?.[1] ?? tGlobal`Unknown`,
    canAct: () => overleaf.canAct,
    onAccept: (change) => host().post("md:overleaf-accept", { id: change.id }),
    onReject: (change) => host().post("md:overleaf-reject", { id: change.id }),
  }), [overleaf]);

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
      bridge.on("md:overleaf", (payload) => dispatch({ type: "overleaf", overleaf: { ...NO_OVERLEAF, ...(payload as Partial<MarkdownOverleaf>) } })),
      bridge.on("md:presence", (payload) => {
        dispatch({ type: "presence", presence: (payload as { cursors: PresenceCursor[] }).cursors });
      }),
      bridge.on("doc:editable", (payload) => {
        dispatch({ type: "editable", editable: Boolean((payload as { editable: boolean }).editable) });
      }),
      bridge.on("md:project", (payload) => {
        const { files: nextFiles, texSources: nextSources } = payload as { files: FileNode[]; texSources: string[] };
        dispatch({ type: "project", files: nextFiles, texSources: nextSources });
      }),
      bridge.on("md:pages-changed", (payload) => {
        const { paths } = payload as { paths: string[] | null };
        if (!paths) {
          void workspaceIndex.update(filesRef.current);
          return;
        }
        const tracked = new Set<string>();
        const collect = (nodes: FileNode[]) => {
          for (const node of nodes) {
            tracked.add(node.path);
            collect(node.children);
          }
        };
        collect(filesRef.current);
        for (const path of paths.filter((candidate) => tracked.has(candidate))) {
          void readProjectFile(path)
            .then((content) => workspaceIndex.noteDocumentContent(path, content))
            .catch(() => {});
        }
      }),
      bridge.on("md:paper", (payload) => {
        dispatch({ type: "paper", paper: (payload as { paper: PaperReading | null }).paper ?? null });
      }),
      bridge.on("md:scroll-to", (payload) => {
        const { center, min, max } = payload as { center: number; min: number; max: number };
        splitScrollRef.current?.followSource(center, min, max);
      }),
    ];
    bridge.ready();
    return () => { for (const stop of stops) stop(); };
  }, [workspaceIndex]);

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
  const onSelectionMarkdown = useCallback((text: string) => host().post("md:selection", { text }), []);
  // Adding a block (Add block below and the like) keeps the reader's place:
  // the block acted on stays where it was on screen for the next frames,
  // as the canvas's `lockMarkdownPreviewViewport` holds it.
  const viewportLock = useRef({ lock: 0, anchor: "" });
  const onRequestViewportLock = useCallback((anchor: HTMLElement | null, anchorTop: number | null, revealed: HTMLElement | null) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    const held = viewportLock.current;
    const lock = held.lock + 1;
    if (held.lock === 0) held.anchor = viewport.style.overflowAnchor;
    held.lock = lock;
    viewport.style.overflowAnchor = "none";
    const restore = () => {
      if (held.lock !== lock || !viewport.isConnected) return false;
      restoreViewportAround(viewport, scrollTop, anchor, anchorTop, revealed);
      return true;
    };
    restore();
    queueMicrotask(restore);
    window.requestAnimationFrame(() => {
      if (!restore()) return;
      window.requestAnimationFrame(() => {
        if (!restore()) return;
        held.lock = 0;
        viewport.style.overflowAnchor = held.anchor;
      });
    });
  }, []);
  const onRevealHandled = useCallback((id: string) => {
    if (reveal?.id === id) dispatch({ type: "reveal", reveal: null });
  }, [reveal]);

  const masthead = Boolean(paper?.fullText);
  useEffect(() => { if (!masthead) setEligibility(null); }, [masthead]);
  // The reader's strip names the paper only while the masthead is off screen
  // (`useMastheadInView` in paper-reader.tsx): the viewport clips the title,
  // so it stops intersecting exactly when it has scrolled out from under the
  // strip. Without a masthead the strip keeps the whole identity.
  useLayoutEffect(() => {
    const title = masthead && ready ? viewportRef.current?.querySelector(".paper-visual-header h1") : null;
    if (!title || typeof IntersectionObserver === "undefined") {
      host().post("md:masthead", { inView: false });
      return;
    }
    let last: boolean | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting === last) return;
      last = entry.isIntersecting;
      host().post("md:masthead", { inView: last });
    }, { root: viewportRef.current });
    observer.observe(title);
    return () => observer.disconnect();
  }, [masthead, ready, opened]);

  if (!opened || !ready) return null;
  return (
    <ScrollArea
      className="markdown-preview"
      data-tour={paper ? "paper-reading-view" : "markdown-visual-editor"}
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
        onClickCapture: (event) => followSourceLink(event, paper),
      }}
      viewportRef={viewportRef}
      style={{ flex: "1 1 0", minWidth: 0 }}
    >
      {masthead && paper && (
        <header className="paper-visual-header">
          <div>
            {eligibility && (
              <InlineMessage level="warning" className="paper-visual-eligibility">{eligibility}</InlineMessage>
            )}
            <h1>{paper.title}</h1>
            {paper.authors && <p>{paper.authors}</p>}
          </div>
        </header>
      )}
      <Fragment key={`${opened.projectRoot}\n${opened.path}`}>
        <LatticeVisualMarkdownEditor
          text={settled}
          activePath={opened.path}
          // The canvas passes no project root for a paper: the root only
          // resolves a paper dragged in from the Papers panel, which a
          // paper's own text does not take.
          projectRoot={paper ? undefined : opened.projectRoot}
          optimizeForReading={Boolean(paper)}
          onEligibilityChange={masthead ? setEligibility : undefined}
          onChangeMarkdown={onChangeMarkdown}
          onFlushPendingChange={onFlushPendingChange}
          synchronizeSourceScroll={split || reveal !== null}
          revealRequest={reveal}
          onRevealHandled={onRevealHandled}
          onRequestViewportLock={onRequestViewportLock}
          presenceCursors={presenceCursors}
          overleafChanges={overleafChanges}
          overleafTrackChangeActions={overleafTrackChangeActions}
          onSelectionMarkdown={onSelectionMarkdown}
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
