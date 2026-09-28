import v8 from "node:v8";
import vm from "node:vm";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { completionStatus, insertBracket, selectedCompletionIndex } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist-v4/legacy/build/pdf.mjs";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { registerAgentCanvasAdapter } from "./agent/agent-canvas-tools";
import { registerAgentSpreadsheetDocument } from "./agent/agent-spreadsheet-tools";
import { clearAppLogs, formatAppLogs, getAppLogEntry, getVisibleAppToastIds } from "./telemetry/app-log-store";
import { APPEARANCE_KEY, loadWorkspaceLayout, persistWorkspaceLayout, type WorkspaceLayout } from "./settings/app-settings";
import { mapCollabProjectStatusV2 } from "./collab/collab-status";
import { formatCollabInvitationV2 } from "./collab/collab-invitation-v2";
import { loadTextLanguageExtensions } from "./editor/editor-languages";
import { activateAppLocale } from "./i18n";
import { referenceAssetPreviewDataUrl } from "./project/reference-preview";
import { usePanelLayout } from "./app/use-panel-layout";
import { parseVisualMarkdown } from "./editor/markdown/visual-markdown-schema";
import type { SynaraRuntimeInfo } from "./agent/synara-runtime";
import { ConfirmActionProvider } from "./components/ui/confirm-action-dialog";
import type { CollabProjectStatusV2 } from "./collab/collab-project-v2";
import { loadVisualMarkdownEditorModule } from "./canvas/canvas-lazy-modules";
// Keep the cold Vite transforms of these real lazy surfaces outside interaction-test deadlines; the tests
// still mount them, not doubles: the visual Markdown editor, the file-tree navigator, the canvas and
// comment surfaces the comment-routing regression uses, and the PDF viewer source navigation needs.
import "./editor/markdown/visual-markdown-editor";
import "./project/navigator";
import "./canvas/document-canvas";
import "./overleaf/overleaf-collab";
import "./editor/comments/editor-comments-panel";
import "./pdf/pdf-viewer";
import type { FileNode, ProjectManifest, ProjectSnapshot } from "./app-types";
import type { OpenSlideMutation, OpenSlideSyncOperation } from "./editor/presentation/open-slide-bridge";

const windowApi = vi.hoisted(() => ({
  label: "main", setFocus: vi.fn(async () => {}), startDragging: vi.fn(), isFullscreen: vi.fn(), setFullscreen: vi.fn(),
  setMinSize: vi.fn(), onResized: vi.fn(),
}));
const webviewApi = vi.hoisted(() => ({
  dragDropHandler: null as null | ((event: {
    payload: { type: "drop"; paths: string[]; position: { x: number; y: number } };
  }) => void),
}));
const tauriEventApi = vi.hoisted(() => ({ handlers: new Map<string, Set<(event: { payload: unknown }) => void>>() }));
const { synaraHook, readySynaraRuntime } = vi.hoisted(() => {
  const readySynaraRuntime = (): SynaraRuntimeInfo => ({
    state: "ready", origin: "http://127.0.0.1:4173", authToken: "test-token", message: null, startupMs: 1,
    version: "test", revision: "test",
  });
  return { readySynaraRuntime, synaraHook: { runtime: readySynaraRuntime(), retry: vi.fn(), enabledCalls: [] as boolean[] } };
});
const interfaceSounds = vi.hoisted(() => ({ configure: vi.fn(), play: vi.fn() }));
const openSlideWorkspaceApi = vi.hoisted(() => ({
  onMutation: null as null | ((mutation: OpenSlideMutation) => Promise<OpenSlideSyncOperation[]>),
}));
const browserRuntime = vi.hoisted(() => ({ hosted: false, bundled: false }));
const pdfSlickTestApi = vi.hoisted(() => ({ sources: [] as Array<string | ArrayBuffer> }));
const tauriCoreApi = vi.hoisted(() => ({ channel: null as { onmessage: ((message: unknown) => void) | null } | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(), isTauri: () => true,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
    constructor() { tauriCoreApi.channel = this; }
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async (handler: typeof webviewApi.dragDropHandler) => {
    webviewApi.dragDropHandler = handler;
    return () => {};
  } }),
}));
// Unmocked, every `listen` reaches for Tauri's IPC bridge and rejects, which jsdom reports as an unhandled
// rejection for each runtime listener. Retaining the handlers also lets filesystem tests exercise the real event path.
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = tauriEventApi.handlers.get(event) ?? new Set();
    tauriEventApi.handlers.set(event, handlers.add(handler));
    return () => {
      handlers.delete(handler);
      if (!handlers.size) tauriEventApi.handlers.delete(event);
    };
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
// The board creation flow opens the .tldr in the canvas; mounting the real
// Tldraw editor needs browser canvas APIs jsdom doesn't have.
vi.mock("./editor/board/board-editor", () => ({ BoardEditor: () => <div data-testid="board-editor-mock" /> }));
vi.mock("./editor/spreadsheet/spreadsheet-editor", () => ({ SpreadsheetEditor: () => <div data-testid="spreadsheet-editor-mock" /> }));
vi.mock("./editor/presentation/open-slide-workspace", () => ({
  OpenSlideWorkspace: ({ projectRoot, path, source, onMutation }: {
    projectRoot: string; path: string; source: string; onMutation: NonNullable<typeof openSlideWorkspaceApi.onMutation>;
  }) => {
    openSlideWorkspaceApi.onMutation = onMutation;
    return <div data-testid="open-slide-workspace-mock" data-project-root={projectRoot} data-path={path} data-source={source} />;
  },
}));
vi.mock("./agent/use-synara-runtime", () => ({
  useSynaraRuntime: (enabled: boolean) => {
    synaraHook.enabledCalls.push(enabled);
    return synaraHook;
  },
}));
vi.mock("./telemetry/interface-sounds", () => ({
  configureInterfaceSounds: interfaceSounds.configure, playInterfaceSound: interfaceSounds.play,
}));
vi.mock("./platform/browser-runtime", () => ({
  isBrowserHosted: () => browserRuntime.hosted, isBundledChromium: () => browserRuntime.bundled,
}));
vi.mock("pdfjs-dist-v4/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
  TextLayer: class {
    container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) { this.container = container; }
    render() {
      this.container.append(Object.assign(document.createElement("span"), { textContent: "Attention is all you need" }));
      return Promise.resolve();
    }
    cancel() {}
  },
}));

type PdfSlickMockArgs = { viewer: HTMLDivElement; options?: { scaleValue?: string; getDocumentParams?: Record<string, unknown> } };
type PdfSlickMockPage = {
  getAnnotations?: (options: { intent: string }) => Promise<Array<{ url?: string; unsafeUrl?: string; title?: string }>>;
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render?: (options: { canvasContext: CanvasRenderingContext2D; viewport: object }) => { promise: Promise<unknown> };
};
type PdfSlickMockDocument = {
  numPages: number; getPage: (pageNumber: number) => Promise<PdfSlickMockPage>; loadingTask?: { destroy: () => unknown };
};
type PdfSlickMockPageView = {
  div: HTMLDivElement; textLayer: { div: HTMLDivElement }; viewport: { scale: number; width: number; height: number };
};

vi.mock("@pdfslick/core", () => {
  const scaleOf = (value?: string) => (value === "page-width" ? 0.9 : value === "page-fit" ? 0.75 : Number(value));
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) => (
    Object.assign(document.createElement(tag), props)
  );
  return { PDFSlick: class PDFSlickMock {
    args: PdfSlickMockArgs;
    document: PdfSlickMockDocument | null = null;
    eventHandlers = new Map<string, Array<(event: object) => void>>();
    pageViews: PdfSlickMockPageView[] = [];
    findIndex = 0;
    linkService = { page: 1, goToDestination: vi.fn(async () => undefined), setDocument: vi.fn() };
    l10n = { get: vi.fn(async (id: string) => id) };
    unbindEvents = vi.fn();
    pagesReady = false;
    readyListeners = new Set<() => void>();
    store = {
      getState: () => ({ pagesReady: this.pagesReady }),
      subscribe: (listener: () => void) => {
        this.readyListeners.add(listener);
        return () => this.readyListeners.delete(listener);
      },
    };
    viewer: {
      cleanup: ReturnType<typeof vi.fn>; setDocument: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>;
      currentScale: number; currentScaleValue: string;
      getPageView: (index: number) => PdfSlickMockPageView;
    };

    constructor(args: PdfSlickMockArgs) {
      this.args = args;
      const emit = (name: string, event: object) => this.emit(name, event);
      let currentScale = scaleOf(args.options?.scaleValue) || 0.825;
      let currentScaleValue = args.options?.scaleValue ?? "page-width";
      this.viewer = {
        cleanup: vi.fn(), setDocument: vi.fn(), update: vi.fn(),
        get currentScale() { return currentScale; },
        set currentScale(value: number) { currentScale = value; emit("scalechanging", { scale: value }); },
        get currentScaleValue() { return currentScaleValue; },
        set currentScaleValue(value: string) {
          currentScaleValue = value;
          currentScale = scaleOf(value);
          const presetValue = value === "page-width" || value === "page-fit" ? value : undefined;
          emit("scalechanging", { scale: currentScale, presetValue });
        },
        getPageView: (index: number) => this.pageViews[index],
      };
    }

    on(name: string, listener: (event: object) => void) {
      this.eventHandlers.set(name, [...this.eventHandlers.get(name) ?? [], listener]);
    }

    emit(name: string, event: object) { for (const listener of this.eventHandlers.get(name) ?? []) listener(event); }

    gotoPage(pageNumber: number) {
      this.linkService.page = pageNumber;
      this.emit("pagechanging", { pageNumber });
    }

    clearHighlights() {
      for (const page of this.pageViews) page.div.querySelectorAll(".highlight").forEach((highlight) => highlight.remove());
    }

    dispatch(name: string, event: Record<string, unknown>) {
      if (name === "findbarclose") {
        this.clearHighlights();
        this.emit("updatefindmatchescount", { matchesCount: { current: 0, total: 0 } });
        return;
      }
      if (name !== "find") return;
      const query = String(event.query ?? "").toLocaleLowerCase();
      const matches = this.pageViews.filter((page) => (page.div.textContent ?? "").toLocaleLowerCase().includes(query));
      this.findIndex = event.type === "again" && matches.length
        ? (this.findIndex + (event.findPrevious ? -1 : 1) + matches.length) % matches.length
        : 0;
      this.clearHighlights();
      for (const [index, page] of matches.entries()) {
        const className = `highlight${index === this.findIndex ? " selected" : ""}`;
        page.div.querySelector(".textLayer")?.append(element("span", { className, textContent: query }));
      }
      this.emit("updatefindmatchescount", {
        matchesCount: { current: matches.length ? this.findIndex + 1 : 0, total: matches.length },
      });
    }

    async loadDocument(source: string | ArrayBuffer) {
      pdfSlickTestApi.sources.push(source);
      const pdfjs = await import("pdfjs-dist-v4/legacy/build/pdf.mjs");
      const loadingTask = pdfjs.getDocument({
        ...(typeof source === "string" ? { url: source } : { data: new Uint8Array(source) }),
        ...this.args.options?.getDocumentParams,
      });
      const loaded = await loadingTask.promise as unknown as PdfSlickMockDocument;
      loaded.loadingTask = loadingTask;
      this.document = loaded;
      const viewportScale = this.viewer.currentScale * (96 / 72);
      for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
        const pdfPage = await loaded.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: viewportScale });
        const canvas = element("canvas");
        const canvasContext = canvas.getContext("2d") as CanvasRenderingContext2D;
        if (pdfPage.render) await pdfPage.render({ canvasContext, viewport }).promise;
        const textLayer = element("div", { className: "textLayer" });
        textLayer.append(element("span", { textContent: "Attention is all you need" }));
        const annotationLayer = element("div", { className: "annotationLayer" });
        for (const { url, unsafeUrl, title } of await pdfPage.getAnnotations?.({ intent: "display" }) ?? []) {
          const href = url ?? unsafeUrl;
          if (!href) continue;
          annotationLayer.append(element("a", { href, target: "_blank", rel: "noopener noreferrer nofollow", title: title ?? href }));
        }
        const page = element("div", { className: "page" });
        page.dataset.pageNumber = String(pageNumber);
        page.append(canvas, textLayer, annotationLayer);
        this.args.viewer.append(page);
        this.pageViews.push({
          div: page, textLayer: { div: textLayer },
          viewport: { scale: viewportScale, width: viewport.width, height: viewport.height },
        });
      }
      this.emit("pagesinit", {});
      this.pagesReady = true;
      this.readyListeners.forEach((listener) => listener());
      this.emit("pagerendered", { pageNumber: 1 });
      for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
        this.emit("textlayerrendered", { pageNumber });
      }
    }
  } };
});

/** Answers the commands every window issues at startup; rejects any other command a test did not declare. */
function mockAppCommand(command: string) {
  // Every window asks for its one-shot instruction; only a window opened to join a share is given one.
  if (command === "take_pending_window_action" || command === "set_browser_access_enabled") return null;
  if (command === "browser_access_enabled") return false;
  if (["list_citation_keys", "list_citations", "list_references"].includes(command)) return [];
  throw new Error(`Unexpected command: ${command}`);
}

const FILE_KINDS: Record<string, string> = {
  tex: "tex", md: "markdown", bib: "bib", tldr: "board", "lattice-sheet": "spreadsheet", tsx: "tsx",
  png: "figure", pdf: "figure", svg: "figure", eps: "figure", webp: "figure",
};

/** A project tree file; `kind` follows the extension unless a test needs another. */
function fileNode(path: string, kind = FILE_KINDS[path.split(".").pop() ?? ""] ?? "text", extra?: Partial<FileNode>): FileNode {
  return { name: path.split("/").pop() ?? path, path, kind, children: [], ...extra };
}

const fileNodes = (...paths: string[]) => paths.map((path) => fileNode(path));

function dirNode(path: string, children: FileNode[] = []): FileNode {
  return { name: path.split("/").pop() ?? path, path, kind: "directory", children };
}

/** A command's canned result, or a function computing it from the call's arguments. */
type CommandResult = ((args: InvokeArgs | undefined, command: string) => unknown) | string | number | boolean | object | null | undefined;
type Commands = Record<string, CommandResult>;

/** Answers `invoke` from `commands`: values as-is (the same instance on every call), functions per call, and
 * anything missing through mockAppCommand, which rejects commands a test did not expect. */
function mockCommands(commands: Commands) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (!Object.hasOwn(commands, command)) return mockAppCommand(command);
    const result = commands[command];
    return typeof result === "function" ? result(args, command) : result;
  });
}

/** What opening `snapshot` reads: its root document, papers, history, and prose lints. */
function projectCommands(snapshot: ProjectSnapshot | null = projectSnapshot(), source = "\\documentclass{article}") {
  return {
    initial_project: snapshot, read_project_file: source, list_papers: () => [], list_history: () => [], harper_lint: () => [],
  } satisfies Commands;
}

/** projectCommands, plus project-tree re-reads that find `snapshot` unchanged. */
function refreshableProject(snapshot = projectSnapshot(), source?: string) {
  return { ...projectCommands(snapshot, source), refresh_project: snapshot } satisfies Commands;
}

/** The paper the citation-removal tests cite as `chen2024single`. */
const SINGLE_TRANSFORMER = { arxivId: "2407.06438", title: "A Single Transformer", citationKey: "chen2024single", hasFullText: true };

/** The paper most Papers tests import, with whatever metadata a test needs. */
function attentionPaper<T extends object>(paper: T = {} as T) {
  return { arxivId: "1706.03762", title: "Attention Is All You Need", hasFullText: true, ...paper };
}

// Overleaf responses for a linked, connected project; tests override what they exercise.
const overleafLink = (link: object = {}) => ({
  projectId: "ol-project", projectName: "Overleaf paper", host: "https://www.overleaf.com", lastSync: null, paused: false, ...link,
});
const overleafStatus = (status: object = {}) => ({
  connected: true, email: "writer@example.com", name: "Writer", host: "https://www.overleaf.com", ...status,
});
const overleafProbe = (probe: object = {}) => ({
  changed: false, localChanged: false, versionKnown: true, remoteVersion: 1, lastSync: null, ...probe,
});
const overleafSyncResult = (result: object = {}) => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [],
  automaticRemoteDeletes: [], readOnly: false, ...result,
});
const overleafSession = (session: object = {}) => ({
  publicId: null, rootFolderId: "root", docs: [{ id: "main-doc", path: "main.tex" }], entities: [],
  permission: "readAndWrite", trackChanges: false, userId: null, ...session,
});
/** The realtime feeds an open Overleaf project polls, all empty. */
const OVERLEAF_EMPTY_FEEDS = {
  overleaf_chat_messages: () => [], overleaf_threads: () => [], overleaf_comment_anchors: () => [],
  overleaf_change_authors: () => [], overleaf_rt_connected_users: () => [],
};
/** The commands of a linked Overleaf project whose realtime session opens with empty feeds. */
function overleafCommands(overrides: Commands = {}): Commands {
  return {
    overleaf_link: () => overleafLink(), overleaf_status: () => overleafStatus(), overleaf_probe: () => overleafProbe(),
    overleaf_sync: () => overleafSyncResult(), overleaf_rt_connect: () => overleafSession(), overleaf_rt_disconnect: undefined,
    git_auto_commit: null, ...OVERLEAF_EMPTY_FEEDS, ...overrides,
  };
}

/** Root of the standard test project. */
const ROOT = "/tmp/lattice-paper";

/** The standard single-document project; tests override only what they exercise. */
function projectSnapshot({ root = ROOT, files = [fileNode("main.tex")], ...manifest }:
  Partial<ProjectManifest> & { root?: string; files?: FileNode[] } = {}): ProjectSnapshot {
  const defaults = {
    schemaVersion: 1, projectId: "paper-id", name: "Lattice paper",
    rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }], primaryBibliography: "references.bib", trusted: false,
  };
  return { root, manifest: { ...defaults, ...manifest }, files };
}

/** A project's single, default root document. */
const rootDocument = (path: string, name = "Notes") => [{ path, name, isDefault: true }];
/** A root document registered under the short name some fixtures use. */
const MAIN_DOCUMENT = rootDocument("main.tex", "Main");
/** A second project holding one private Markdown draft. */
const notesSnapshot = () => projectSnapshot({
  root: "/tmp/notes", projectId: "notes-id", name: "Notes", rootDocuments: [], files: [fileNode("draft.md")],
});
/** A project whose only root document is the Markdown file `path`. */
const markdownSnapshot = (path = "notes.md", files = [fileNode(path)]) => projectSnapshot({ rootDocuments: rootDocument(path), files });
/** The project most Overleaf tests link. */
const overleafPaperSnapshot = () => projectSnapshot({
  root: "/tmp/lattice-overleaf-paper", projectId: "overleaf-paper-id", name: "Overleaf paper",
});
const EMPTY_BOARD = "{\"tldrawFileFormatVersion\":1,\"records\":[]}";
const BIB_SOURCE = "@article{lattice, title={Lattice}}";
const PAPER_ABSTRACT = "## Abstract\n\nPaper content.";

/** A `build_project` answer: a successful build unless `result` says otherwise. */
function buildResult(result: object = {}) {
  return () => ({ success: true, hasPdf: false, log: "", durationMs: 50, diagnostics: [], ...result });
}

/** A failed `build_project` answer reporting the single error `message`. */
const failedBuild = (message: string, log = "") => buildResult({
  success: false, log, durationMs: 80, diagnostics: [{ level: "error", message }],
});

/** Answers `read_project_file` from `files` by path, else with `fallback`. */
function readFiles(files: Record<string, unknown>, fallback: unknown = "\\documentclass{article}") {
  return (args: InvokeArgs | undefined) => files[argPath(args)] ?? fallback;
}

/** Answers each read with `content:<path>`, so a pane shows which file it holds. */
const readPathContent = (args: InvokeArgs | undefined) => `content:${argPath(args)}`;

/** A promise whose settlers the test holds. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
type Deferred<T = void> = ReturnType<typeof deferred<T>>;

function setAutoBuildMode(autoBuildMode: "manual" | "automatic") {
  localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode }));
}

/** Switches the interface language the way a persisted user choice does. */
async function setInterfaceLanguage(locale: "en" | "zh-CN") {
  await activateAppLocale(locale);
  localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: locale }));
}

/** The project the bottom-assistant tests open. */
const agentDockSnapshot = () => projectSnapshot({ root: "/tmp/agent-dock", projectId: "dock", name: "Dock test", rootDocuments: MAIN_DOCUMENT });

/** Restores the sidebar open on the Agent, as a previous session left it. */
function showAgentSidebar() {
  localStorage.setItem("lattice.sidebar-open.v1", "1");
  localStorage.setItem("lattice.sidebar-mode.v1", "agent");
}

// The provider/model/effort pickers are Radix Selects: options are portaled and only exist while the menu is
// open, so a native `fireEvent.change` no longer works. The trigger opens on pointerdown only for a real mouse
// press (pointerType "mouse", primary button), so spell that out.
async function chooseOption(selectLabel: string, optionName: string | RegExp) {
  fireEvent.pointerDown(await screen.findByLabelText(selectLabel), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

const switchSidebarMode = async (mode: "Project" | "Papers" | "Agent") => fireEvent.click(await screen.findByRole("tab", { name: mode }));

/** Opens the Papers sidebar, then the paper titled `title`. */
async function openPaper(title: string) {
  await switchSidebarMode("Papers");
  fireEvent.click(await screen.findByTitle(title));
}

/** Switches the active document between its Edit, Preview, and Split views. */
function selectDocumentView(view: "Edit" | "Preview" | "Split") {
  fireEvent.click(within(screen.getByRole("tablist", { name: "Document view" })).getByRole("tab", { name: view }));
}

const projectTreeRoot = () => document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
const queryProjectTreeItem = (path: string) => projectTreeRoot()?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null;

/** Waits for `selector` inside the project tree's shadow root. */
function findInProjectTree<T extends HTMLElement = HTMLElement>(selector: string, timeout?: number): Promise<T> {
  return waitFor(() => {
    const element = projectTreeRoot()?.querySelector<T>(selector) ?? null;
    expect(element, `Project tree: ${selector}`).not.toBeNull();
    return element!;
  }, { timeout });
}

const findProjectTreeItem = (path: string, timeout = 1000) => findInProjectTree(`[data-item-path="${path}"]`, timeout);
const findProjectTreeRenameInput = () => findInProjectTree<HTMLInputElement>("[data-item-rename-input]");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lattice.tutorial-seen.v1", "1");
  Object.assign(browserRuntime, { hosted: false, bundled: false });
  pdfSlickTestApi.sources.length = 0;
  openSlideWorkspaceApi.onMutation = null;
  webviewApi.dragDropHandler = null;
  tauriEventApi.handlers.clear();
  tauriCoreApi.channel = null;
  synaraHook.runtime = readySynaraRuntime();
  synaraHook.retry.mockReset();
  synaraHook.enabledCalls.length = 0;
  // The app asks through the dialog plugin, not the global — see confirmAction.
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(revealItemInDir).mockResolvedValue(undefined);
  vi.mocked(writeText).mockResolvedValue(undefined);
  vi.mocked(readText).mockResolvedValue("");
  windowApi.isFullscreen.mockResolvedValue(false);
  windowApi.setFullscreen.mockResolvedValue(undefined);
  windowApi.setMinSize.mockResolvedValue(undefined);
  windowApi.onResized.mockResolvedValue(() => undefined);
  mockCommands({ initial_project: null });
});

afterEach(() => {
  cleanup();
  clearAppLogs();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // Drop tests stub the hit test; jsdom has none of its own.
  Reflect.deleteProperty(document, "elementFromPoint");
});

/** Renders the app, first answering `invoke` from `commands` when given; `confirmations` mounts the in-app
 * confirmation dialog host `main.tsx` provides. */
function renderApp(commands?: Commands, { confirmations = false } = {}) {
  if (commands) mockCommands(commands);
  return render(confirmations ? <ConfirmActionProvider><App /></ConfirmActionProvider> : <App />);
}

/** Renders a linked Overleaf project — the Overleaf paper unless `snapshot` says otherwise — with manual builds
 * and, when given, a persisted Overleaf sync mode. */
function renderOverleafPaper(overrides: Commands, { snapshot = overleafPaperSnapshot(), syncMode, confirmations }:
  { snapshot?: ProjectSnapshot; syncMode?: "live" | "manual"; confirmations?: boolean } = {}) {
  setAutoBuildMode("manual");
  if (syncMode) localStorage.setItem("lattice.overleaf.sync-mode.v1", syncMode);
  return renderApp({ ...refreshableProject(snapshot), ...overleafCommands(overrides) }, { confirmations });
}

/** Opens `snapshot` with automatic builds, waits for its initial build, then forgets the calls made so far. */
async function openWithAutomaticBuilds(commands: Commands, snapshot = projectSnapshot({ files: [] })) {
  setAutoBuildMode("automatic");
  renderApp({ ...projectCommands(snapshot), build_project: buildResult(), ...commands });
  await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
  vi.mocked(invoke).mockClear();
}

/** Opens Settings from the titlebar button, then `section` when given. */
async function openSettings(section?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  if (section) fireEvent.click(await screen.findByRole("button", { name: section }));
}

/** A full GC for retention tests; WeakRef targets survive until the job ends. */
function exposeGarbageCollector(): () => Promise<void> {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  };
}

describe("collaboration status mapping", () => {
  it.each<[CollabProjectStatusV2, ReturnType<typeof mapCollabProjectStatusV2>]>([
    ["syncing", { status: "connecting", detail: "Syncing changes…" }],
    ["server-received", { status: "synced", detail: null }],
    ["durable", { status: "synced", detail: null }],
    ["offline", { status: "disconnected", detail: "Offline" }],
    ["read-only", { status: "disconnected", detail: "Collaboration is read-only" }],
    ["importing", { status: "connecting", detail: "Importing all project files…" }],
    ["closed", { status: "disconnected", detail: "This shared project is closed" }],
    ["error", { status: "error", detail: "Collaboration failed" }],
  ])("maps %s truthfully", (status, expected) => {
    expect(mapCollabProjectStatusV2(status)).toEqual(expected);
  });
});

// `main.tsx` mounts the toast stack beside `<App />`, so a test rendering the app alone cannot see its
// notifications. Every notification goes through `app-notify`, which always logs, so assert against the store
// the toasts read from — the same contract, without a second React tree. `app-log.test.tsx` covers the rendering.
const expectNotification = (pattern: RegExp) => waitFor(() => expect(formatAppLogs()).toMatch(pattern));

function emitTauriEvent(event: string, payload: unknown) {
  act(() => { tauriEventApi.handlers.get(event)?.forEach((handler) => handler({ payload })); });
}

/** Waits for `selector` to match and returns the element. */
function findElement<T extends Element = HTMLElement>(selector: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const element = document.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
  }, options);
}

const findFrame = (title = "Agent") => findElement<HTMLIFrameElement>(`iframe[title="${title}"]`);

/** The CodeMirror view mounted at `selector` right now. */
function editorViewAt(selector = ".cm-editor") {
  const element = document.querySelector<HTMLElement>(selector);
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view mounted at `selector`. */
async function findEditorView(selector = ".cm-editor", options?: Parameters<typeof waitFor>[1]) {
  const view = EditorView.findFromDOM(await findElement(selector, options));
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view at `selector` and types `text` at its end. */
async function appendToEditor(text: string, selector?: string) {
  const view = await findEditorView(selector);
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  return view;
}

/** Waits until the CodeMirror view at `selector` holds exactly `text`, and returns it. */
function expectEditorText(text: string, selector?: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const view = editorViewAt(selector);
    expect(view.state.doc.toString()).toBe(text);
    return view;
  }, options);
}

/** Delivers a window message from `source`, by default as the Synara origin. */
function postWindowMessage(source: MessageEventSource | null, data: unknown, origin = synaraHook.runtime.origin!) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { source, origin, data })); });
}

/** Waits until the app has invoked `command` with these arguments. */
function expectInvoked(command: string, ...args: unknown[]) {
  return waitFor(() => expect(invoke).toHaveBeenCalledWith(command, ...args));
}

function invokeCalls(command: string, matches: (args: InvokeArgs | undefined) => boolean = () => true) {
  return vi.mocked(invoke).mock.calls.filter(([called, args]) => called === command && matches(args));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves after `count` nested animation frames. */
function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => (remaining ? window.requestAnimationFrame(() => step(remaining - 1)) : resolve());
    step(count);
  });
}

/** jsdom has no layout; give `element` a fixed box. */
function stubRect(element: Element, left: number, top: number, width: number, height: number) {
  return vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}),
  } as DOMRect);
}

function stubElementFromPoint(element: Element | null) {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => element) });
}

/** The per-file editor view states the app persisted, by project root and path. */
function storedFileViews() {
  return JSON.parse(localStorage.getItem("lattice.file-view-states.v1") ?? "{}") as
    Record<string, Record<string, { text?: { cursor: number; scrollTop: number } }>>;
}

/** Delivers a Finder drop through the native webview drag-and-drop handler. */
async function dropFinderPaths(paths: string[]) {
  await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
  act(() => { webviewApi.dragDropHandler?.({ payload: { type: "drop", paths, position: { x: 100, y: 100 } } }); });
}

/** Persists the layout a test restores; omitted fields take a single-pane default. */
function persistLayout(root: string, layout: Pick<WorkspaceLayout, "openTabs" | "activeFile" | "canvasMode"> & Partial<WorkspaceLayout>) {
  persistWorkspaceLayout(root, {
    activeTab: layout.activeFile, secondaryFile: null, focusedPane: "primary",
    documentMode: layout.canvasMode as WorkspaceLayout["documentMode"], paperView: "blog", tabRecency: layout.openTabs, ...layout,
  });
}

const paneContent = (pane: "primary" | "secondary") => (
  document.querySelector<HTMLElement>(`.source-editor[data-editor-pane='${pane}'] .cm-content`)
);
const visualEditorOf = (surface: HTMLElement) => (surface as HTMLElement & { editor: TiptapEditor }).editor;
const argPath = (args: InvokeArgs | undefined) => (args as { path: string }).path;

/** Matches the editor tab of a project file by its file name. */
const fileTabName = (path: string) => new RegExp(path.split("/").at(-1)!.replace(/[.]/g, "\\."));

/** Waits until the editor tab for `path` is the selected one. */
function waitForSelectedTab(path: string) {
  const tab = () => screen.getByRole("tab", { name: fileTabName(path) });
  return waitFor(() => expect(tab()).toHaveAttribute("aria-selected", "true"));
}

/** Opens `path` from the Project tree and waits for its tab to take focus. */
async function openTreeFile(path: string) {
  fireEvent.click(await findProjectTreeItem(path));
  await waitForSelectedTab(path);
}

function stubScrollBox(element: Element, clientHeight: number, scrollHeight: number) {
  const box = (value: number) => ({ configurable: true, value });
  Object.defineProperties(element, { clientHeight: box(clientHeight), scrollHeight: box(scrollHeight) });
}

/** Opens the Agent sidebar and returns its frame, spying on what the host posts to it. */
async function openAgentFrame({ ready = false } = {}) {
  await switchSidebarMode("Agent");
  const frame = await findFrame();
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  if (ready) postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
  return { frame, postMessage };
}

/** Posts the Agent's project-history snapshot for `activeThreadId`. */
function postProjectHistory(frame: HTMLIFrameElement, activeThreadId: string, entries: unknown[], origin?: string) {
  postWindowMessage(frame.contentWindow, { type: "lattice:project-history", activeThreadId, entries }, origin);
}

/** An Agent checkpoint `cp-<id>` on thread `thread-<id>` that modified one file. */
function agentCheckpoint(id: string, file: { path?: string; additions: number; deletions: number }, extra = {}) {
  return {
    id: `cp-${id}`, label: "Edited files", timestamp: "2026-08-07T10:00:00.000Z", threadId: `thread-${id}`,
    threadTitle: "Agent task", turnId: `turn-${id}`, turnCount: 1, checkpointRef: `ref-${id}`,
    files: [{ path: "sections/intro.tex", kind: "modified", ...file }], ...extra,
  };
}

/** The messages of `type` the host posted through a `postMessage` spy, oldest first. */
function postedOfType<T extends object>(postMessage: { mock: { calls: unknown[][] } }, type: string) {
  return postMessage.mock.calls.map(([message]) => message as T & { type?: string }).filter((message) => message?.type === type);
}

/** The toasts currently on screen from `source`. */
const visibleToasts = (source: string) => getVisibleAppToastIds().map(getAppLogEntry).filter((entry) => entry?.source === source);

/** Opens the sharing dialog from its titlebar control once it mounts. */
const openCollaboration = async () => fireEvent.click(await findElement('[data-tour="collaboration"]'));

/** Waits for the Overleaf sync control to accept a manual sync. */
function findOverleafSyncButton() {
  return waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>("button[data-tour='overleaf']");
    expect(button).not.toBeNull();
    expect(button).not.toBeDisabled();
    return button!;
  });
}

/** Drags an editor tab onto the right edge of an 800px canvas; `whileOver` runs before the drop. */
function dragTabToRightEdge(name: RegExp, whileOver?: () => void) {
  stubCanvasRect(200, 40, 800, 600);
  dragToPoint(screen.getByRole("tab", { name }).closest(".editor-tab")!, [850, 300], { from: [120, 16], whileOver });
}

/** Drags `source` (a tree row or tab) with pointer `pointerId` to (`x`, `y`) in the window. */
function dragToPoint(source: Element, [x, y]: [number, number], {
  pointerId = 41, from = [10, 10], whileOver,
}: { pointerId?: number; from?: [number, number]; whileOver?: () => void } = {}) {
  const pointer = { pointerId, pointerType: "mouse" };
  fireEvent.pointerDown(source, { button: 0, clientX: from[0], clientY: from[1], ...pointer });
  fireEvent.pointerMove(window, { clientX: x, clientY: y, ...pointer });
  whileOver?.();
  fireEvent.pointerUp(window, { clientX: x, clientY: y, ...pointer });
}

/** Drags a project-tree row over `target` and drops it there; a function target is re-queried for the drop. */
function dragTreeItem(source: Element, target: Element | (() => Element)) {
  const at = () => (typeof target === "function" ? target() : target);
  const pointer = { pointerId: 1, pointerType: "mouse" };
  fireEvent.pointerDown(source, { button: 0, clientX: 1, clientY: 1, ...pointer });
  fireEvent.pointerMove(at(), { clientX: 20, clientY: 20, ...pointer });
  fireEvent.pointerUp(at(), { clientX: 20, clientY: 20, ...pointer });
}

/** Gives the canvas a fixed box so drop zones can be computed. */
const stubCanvasRect = (left: number, top: number, width: number, height: number) => (
  stubRect(document.querySelector(".canvas-body")!, left, top, width, height)
);

/** A loaded pdf.js document of identical stub pages; `pages` overrides the page stub. */
function pdfDocumentStub(numPages: number, pages: object = {}, extra: object = {}) {
  return { numPages, getPage: vi.fn(async () => pdfPageStub(pages)), getDestination: vi.fn(), getPageIndex: vi.fn(), ...extra };
}

/** Makes every pdf.js load resolve to `document()`. */
function mockPdfDocument(load: () => unknown) {
  vi.mocked(getDocument).mockImplementation(() => ({ promise: Promise.resolve(load()), destroy: vi.fn() }) as never);
}

/** Stubs blob URLs; `url` names each one created. */
function stubObjectUrls(url: () => string) {
  class TestURL extends globalThis.URL {
    static createObjectURL = vi.fn(url);
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", TestURL);
  return TestURL;
}

/** A pdf.js page whose 600×800 viewport maps PDF points one-to-one. */
function pdfPageStub(overrides: object = {}) {
  return {
    getViewport: () => ({ width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, y] }),
    streamTextContent: () => new ReadableStream(), getAnnotations: async () => [], cleanup: vi.fn(), ...overrides,
  };
}

async function chooseNewDocument(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "New document" }), { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

async function chooseProjectMenuItem(name: string) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("panel layout", () => {
  it("applies a newly measured sidebar minimum during an active drag", () => {
    const { result, rerender } = renderHook(({ minimum }) => usePanelLayout(minimum), { initialProps: { minimum: 220 } });
    const target = document.createElement("div");
    vi.spyOn(target, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(target, "hasPointerCapture").mockReturnValue(false);
    vi.spyOn(target, "releasePointerCapture").mockImplementation(() => undefined);
    act(() => result.current.beginSidebarResize({
      preventDefault: vi.fn(), button: 0, clientX: 320, pointerId: 1, currentTarget: target,
    } as never));
    rerender({ minimum: 300 });
    const move = new Event("pointermove") as PointerEvent;
    Object.defineProperties(move, {
      // Below the new minimum, but above the intentional collapse threshold.
      clientX: { value: 260 },
      pointerId: { value: 1 },
    });
    act(() => window.dispatchEvent(move));
    expect(result.current.sidebarWidth).toBe(300);
    act(() => window.dispatchEvent(new Event("pointerup")));
  });
});

describe("welcome screen", () => {
  it("renders the first page of a PDF figure for reference hover previews", async () => {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const destroy = vi.fn(() => Promise.resolve());
    const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 500 * scale, height: 300 * scale }));
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve({ getPage: vi.fn(() => Promise.resolve({ getViewport, render })) }), destroy,
    } as never);
    const image = "data:image/png;base64,preview";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(image);
    await expect(referenceAssetPreviewDataUrl({
      path: "figures/result.pdf", mimeType: "application/pdf", base64: "JVBERi0xLjQ=",
    })).resolves.toBe(image);
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({ disableFontFace: true, useSystemFonts: false }));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "#F9F9FA" }));
    expect(destroy).toHaveBeenCalled();
  });

  it("offers project creation and existing folder import", () => {
    renderApp();
    expect(screen.getByRole("heading", { name: "Research, written with evidence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guided tutorial" })).toBeInTheDocument();
  });

  it.each([
    ["from the welcome screen", true], ["directly on a genuinely empty first launch", false],
  ])("starts the guided tutorial %s", async (_when, tutorialSeen) => {
    if (!tutorialSeen) localStorage.removeItem("lattice.tutorial-seen.v1");
    renderApp({
      initial_project: null,
      open_tutorial_project: () => { throw new Error("Tutorial fixture stopped after invocation."); },
    });
    if (tutorialSeen) fireEvent.click(screen.getByRole("button", { name: "Guided tutorial" }));
    await expectInvoked("open_tutorial_project");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the project creation dialog", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Untitled research");
    expect(screen.getByRole("combobox", { name: "Venue template" })).toHaveTextContent("NeurIPS");
    expect(screen.getByText("Verified against the official 2026 style; creates a preprint draft")).toBeInTheDocument();
  });

  it("keeps duplicate project errors inside the creation dialog", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/research");
    renderApp({
      initial_project: null, create_project: () => { throw new Error("That folder already exists and is not empty."); },
    });
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder already exists and is not empty.");
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
  });

  it("keeps an explicitly opened project instead of replacing it with the tutorial", async () => {
    localStorage.removeItem("lattice.tutorial-seen.v1");
    const snapshot = projectSnapshot({ root: "/tmp/research/First paper", projectId: "first-paper-id", name: "First paper" });
    renderApp({
      ...projectCommands(snapshot),
      open_tutorial_project: () => { throw new Error("Tutorial fixture stopped after invocation."); },
    });
    await expectInvoked("read_project_file", { path: "main.tex", projectRoot: snapshot.root });
    expect(invoke).not.toHaveBeenCalledWith("open_tutorial_project");
    expect(open).not.toHaveBeenCalled();
  });

  it("starts the first build as soon as a new project opens", async () => {
    const snapshot = projectSnapshot({ root: "/tmp/research/New paper", projectId: "new-paper-id", name: "New paper" });
    vi.mocked(open).mockResolvedValue("/tmp/research");
    renderApp({
      ...projectCommands(null), create_project: snapshot, build_project: buildResult(),
      // Creation no longer binds a window; the caller places the project.
      open_project: snapshot,
    });
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Venue template" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "ICML" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    await expectInvoked("create_project", { parent: "/tmp/research", name: "New paper", venue: "icml" });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: "/tmp/research/New paper" }));
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("New paper");
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  }, 30_000);

  it("preserves a forced build queued behind an ordinary build", async () => {
    const success = buildResult({ durationMs: 1 })();
    const ordinaryBuild = deferred<typeof success>();
    let buildCalls = 0;
    renderApp({ ...projectCommands(), build_project: () => (++buildCalls === 1 ? ordinaryBuild.promise : success) });
    await screen.findByRole("button", { name: "Stop" });
    await waitFor(() => expect(buildCalls).toBe(1));
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Clean rebuild/i }));
    expect(buildCalls).toBe(1);
    ordinaryBuild.resolve(success);
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(2));
    expect(invokeCalls("build_project")[1]?.[1]).toEqual(expect.objectContaining({ force: true }));
    // The queued build can finish before the lazy editor imports do. Let the
    // real canvas mount before teardown so those imports keep a live test host.
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  });

  it("shows an existing compiled PDF without waiting for the initial build", async () => {
    const TestURL = stubObjectUrls(() => "blob:cached-pdf");
    renderApp({
      ...projectCommands(), build_project: new Promise<never>(() => undefined),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4 cached").buffer,
    });
    await expectInvoked("read_compiled_pdf", { projectRoot: ROOT });
    expect(TestURL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("uses fixed application fonts while preserving editor size controls", async () => {
    localStorage.setItem("lattice.appearance.v4", JSON.stringify({
      uiFont: "-apple-system, BlinkMacSystemFont, sans-serif", interfaceScale: 1.1,
      editorFont: "Menlo, ui-monospace, monospace", editorFontSize: 14,
    }));
    renderApp();
    expect(screen.queryByTitle("Toggle theme")).not.toBeInTheDocument();
    await openSettings();
    const settingsNavigation = await screen.findByRole("navigation", { name: "Settings sections" }, { timeout: 5000 });
    const section = (name: string) => within(settingsNavigation).getByRole("button", { name });
    expect(section("Appearance")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/latex editor font/i)).not.toBeInTheDocument();
    await chooseOption("Color theme", "Dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("lattice.theme-preference.v1")).toBe("dark");
    expect(screen.queryByLabelText("Interface font")).not.toBeInTheDocument();
    const rootStyle = (name: string) => document.documentElement.style.getPropertyValue(name);
    await waitFor(() => {
      expect(rootStyle("--ui-font")).toBe('"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif');
      expect(rootStyle("--editor-font")).toBe('"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace');
    });
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveValue("14");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(section("Appearance")).not.toHaveAttribute("aria-current");
    expect(section("Editor & builds")).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent("Automatic");
    expect(screen.getByText(/leave the editor or stop typing for 1.2 seconds/i)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("lattice.build-preferences.v2")).toContain("automatic"));
    expect(synaraHook.enabledCalls).not.toContain(true);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(screen.getByText("Open a project to manage Agent settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
  });

  it("does not load provider settings when opening a non-Agent settings page", async () => {
    renderApp({ ...projectCommands(), build_project: buildResult() });
    await chooseProjectMenuItem("Settings");
    expect(await screen.findByRole("heading", { name: "Appearance" }, { timeout: 60_000 })).toBeInTheDocument();
    const providersFrame = 'iframe[title="Synara Providers settings"]';
    expect(document.querySelector(providersFrame)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(document.querySelector(providersFrame)).not.toBeNull());
  }, 60_000);

  it("keeps successful TeX checks compact while retaining failure details", async () => {
    renderApp({ initial_project: null, run_doctor: { ok: true, summary: "ready", checks: [
      { name: "latexmk", detail: "LaTeX build driver: /Library/TeX/texbin/latexmk", ok: true },
      { name: "texlab", detail: "TexLab language server: not found on PATH", ok: false },
    ] } });
    await openSettings("TeX doctor");
    fireEvent.click(screen.getByRole("button", { name: "Run TeX doctor" }));
    const checklist = await findElement(".doctor-checklist");
    const latexmk = within(checklist).getByText("latexmk").closest("li");
    const texlab = within(checklist).getByText("texlab").closest("li");
    expect(latexmk).toHaveClass("ok");
    expect(latexmk).not.toHaveTextContent("LaTeX build driver");
    expect(texlab).toHaveClass("bad");
    expect(texlab).toHaveTextContent("not found on PATH");
  });

  it("uses the doctor button for progress and hides setup actions when tools are ready", async () => {
    const readyReport = { ok: true, summary: "ready", checks: ["latexmk", "pdflatex", "synctex", "bibtex", "conference-fonts", "uv", "uvx"]
      .map((name) => ({ name, detail: "ok", ok: true })) };
    const doctor = deferred<typeof readyReport>();
    renderApp({ initial_project: null, run_doctor: () => doctor.promise });
    await openSettings("TeX doctor");
    const runButton = screen.getByRole("button", { name: "Run TeX doctor" });
    await waitFor(() => expect(runButton).toBeDisabled());
    expect(screen.queryByText("Checking local tools…")).not.toBeInTheDocument();
    await act(async () => doctor.resolve(readyReport));
    await waitFor(() => expect(document.querySelector(".doctor-status")).toHaveTextContent("Ready to compile"));
    expect(screen.queryByRole("button", { name: "Install required tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();
  });

  it("resets the settings page scroll position when leaving Logs", async () => {
    renderApp();
    await openSettings("Logs");
    const settingsViewport = await findElement(".settings-content [data-slot='scroll-area-viewport']");
    settingsViewport.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    await waitFor(() => expect(settingsViewport).toHaveProperty("scrollTop", 0));
  });

  it("keeps an expanded Synara settings panel reachable from the old bottom", async () => {
    renderApp(projectCommands());
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Providers" }, { timeout: 10_000 }));
    const frame = await findFrame("Synara Providers settings");
    const settingsViewport = document.querySelector<HTMLDivElement>(".settings-content [data-slot='scroll-area-viewport']")!;
    Object.defineProperties(settingsViewport, {
      clientHeight: { configurable: true, value: 470 },
      scrollHeight: { configurable: true, get: () => Number.parseInt(frame.style.height, 10) + 730 },
    });
    await act(() => nextFrames(2));

    const providersHeight = (height: number) => postWindowMessage(frame.contentWindow, {
      type: "synara:settings-content-height", height, section: "providers",
    });
    settingsViewport.scrollTop = 500;
    providersHeight(1_200);
    await waitFor(() => expect(frame.style.height).toBe("1200px"));
    await act(() => nextFrames(2));
    expect(settingsViewport.scrollTop).toBe(500);

    settingsViewport.scrollTop = 1_445;
    providersHeight(1_400);
    await waitFor(() => expect(settingsViewport.scrollTop).toBe(2_130));

    // Skills replaces a list with a detail page, unlike the disclosure above. The iframe does not own the scroll in
    // embed mode: navigation must reset this host viewport, including when detail content arrives asynchronously.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const skillsFrame = await findFrame("Synara Skills settings");
    let scrollTop = 0;
    Object.defineProperties(settingsViewport, {
      scrollHeight: { configurable: true, get: () => Number.parseInt(skillsFrame.style.height, 10) },
      scrollTop: {
        configurable: true, get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, settingsViewport.scrollHeight - 470)); },
      },
    });
    const message = (data: object) => postWindowMessage(skillsFrame.contentWindow, { section: "skills", ...data });
    const settle = () => act(() => nextFrames(2));
    const skillsHeight = (height: number) => message({ type: "synara:settings-content-height", height });
    skillsHeight(2_400);
    await settle();
    settingsViewport.scrollTop = 615;
    message({ type: "synara:settings-navigation", view: "detail" });
    skillsHeight(470);
    await settle();
    skillsHeight(1_600);
    await settle();
    expect(settingsViewport.scrollTop).toBe(0);
    skillsHeight(470);
    message({ type: "synara:settings-navigation", view: "list" });
    await settle();
    skillsHeight(2_400);
    await settle();
    expect(settingsViewport.scrollTop).toBe(615);
  });

  it("switches the app chrome and settings to Simplified Chinese and persists the choice", async () => {
    renderApp();
    await openSettings();
    expect(screen.getByLabelText("Interface language")).toHaveTextContent("Follow system (default)");
    await chooseOption("Interface language", "Simplified Chinese");
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "设置分区" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByText("选择菜单、设置和帮助文字所使用的语言")).toBeInTheDocument();
    expect(localStorage.getItem("lattice.appearance.v5")).toContain('"interfaceLanguage":"zh-CN"');
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(await screen.findByRole("heading", { name: "让研究写作有据可循" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
  });

  it("keeps Settings draggable from its header and the top window strip", async () => {
    renderApp();
    await openSettings();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const header = dialog.querySelector<HTMLElement>(".settings-header")!;
    fireEvent.mouseDown(header, { button: 0, buttons: 1, detail: 1 });
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    windowApi.startDragging.mockClear();
    const topStrip = document.querySelector<HTMLElement>("[data-modal-window-drag]")!;
    fireEvent.pointerDown(topStrip, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.mouseDown(topStrip, { button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerUp(topStrip, { button: 0, buttons: 0, pointerType: "mouse" });
    fireEvent.mouseUp(topStrip, { button: 0, buttons: 0, detail: 1 });
    fireEvent.click(topStrip, { button: 0, detail: 1 });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it.each([
    ["persists the editor spellcheck setting when it is turned off", "Editor & builds", "Check spelling in prose", "editorSpellcheck"],
    ["lets the user mute the small set of interface sounds", undefined, "Interface sounds", "interfaceSounds"],
  ])("%s", async (_name, section, label, setting) => {
    renderApp();
    await openSettings(section);
    const toggle = await screen.findByLabelText(label);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v5")).toContain(`"${setting}":false`));
    if (setting === "interfaceSounds") expect(interfaceSounds.configure).toHaveBeenLastCalledWith(false);
  });

  it("keeps the resident browser entry at the bottom of Appearance and controls login startup", async () => {
    renderApp({ initial_project: null, browser_access_enabled: true, set_browser_access_enabled: null });
    await openSettings();
    const residentAccess = await screen.findByLabelText("Start browser access after login");
    expect(residentAccess).toBeChecked();
    expect(screen.getByText("Browser").compareDocumentPosition(screen.getByText("Feedback")))
      .toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(screen.getAllByText(/http:\/\/127\.0\.0\.1:18452/)).toHaveLength(2);
    fireEvent.click(residentAccess);
    await expectInvoked("set_browser_access_enabled", { enabled: false });
    expect(residentAccess).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const revisited = screen.getByLabelText("Start browser access after login");
    expect(revisited).not.toBeChecked();
    expect(revisited).toBeEnabled();
    expect(invokeCalls("browser_access_enabled")).toHaveLength(1);
  });

  it("opens every Settings dropdown with the Settings popover contract", async () => {
    renderApp({ initial_project: null });
    for (const section of ["Appearance", "Editor & builds"]) {
      await openSettings(section);
      const content = await screen.findByRole("heading", { name: section });
      const triggers = content.closest(".settings-section")!.querySelectorAll('[data-slot="select-trigger"]');
      expect(triggers.length).toBeGreaterThan(0);
      for (const trigger of triggers) {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        const listbox = await screen.findByRole("listbox");
        expect(listbox.closest('[data-slot="select-content"]')).toHaveAttribute("data-settings-control", "true");
        fireEvent.keyDown(listbox, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
      }
      fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    }
  });

  it("moves a browser workspace back into the desktop app from Settings", async () => {
    browserRuntime.hosted = true;
    renderApp({ ...projectCommands(projectSnapshot({ files: [] })), return_to_desktop: "project-1" });
    await screen.findByRole("tab", { name: "main.tex" });
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Open desktop app" }));
    await expectInvoked("return_to_desktop");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("opens the bundled Chromium workspace in the default browser", async () => {
    Object.assign(browserRuntime, { hosted: true, bundled: true });
    renderApp({ open_in_system_browser: null });
    await openSettings();
    await screen.findByLabelText("Start browser access after login");
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    await expectInvoked("open_in_system_browser");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
  });

  it.each([
    ["keeps an explicitly selected manual build preference", "lattice.build-preferences.v2", "Manual only"],
    ["migrates the legacy manual default to automatic build", "lattice.build-preferences.v1", "Automatic"],
  ])("%s", async (_name, key, label) => {
    localStorage.setItem(key, JSON.stringify({ autoBuildMode: "manual" }));
    renderApp();
    await openSettings("Editor & builds");
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent(label);
  });
});

describe("project workspace", () => {
  it.each([
    ["scripts/train.py", "def train(steps):\n    return steps + 1", "FunctionDefinition"],
    ["config/settings.toml", "[tool]\nname = \"research-writer\"\nenabled = true", "propertyName"],
    [".gitignore", "# Build output\ndist/\n*.log\n!important.log", "comment"],
  ])("loads syntax highlighting for %s", async (path, source, expectedNode) => {
    const state = EditorState.create({ doc: source, extensions: await loadTextLanguageExtensions(path) });
    expect(syntaxTree(state).toString()).toContain(expectedNode);
  });

  it("hands a re-opened file the language it already resolved", async () => {
    // Opening a file whose language loads asynchronously used to mount the editor bare and reconfigure it once the
    // language arrived, which parses the document a second time on every visit. Resolving to the same array for a
    // second file of the same type is what lets the editor be created with its language instead.
    for (const [first, second] of [["notes.md", "chapters/intro.md"], ["scripts/train.py", "tools/eval.py"]]) {
      const initial = await loadTextLanguageExtensions(first);
      expect(initial.length).toBeGreaterThan(0);
      expect(await loadTextLanguageExtensions(second)).toBe(initial);
      expect(await loadTextLanguageExtensions(first)).toBe(initial);
    }
  });

  it("temporarily reveals auxiliary sources without forgetting the selected document view", async () => {
    localStorage.setItem("lattice:show-hidden-files", "true");
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "introduction.tex", "references.bib", "conference.sty") });
    renderApp({
      ...projectCommands(snapshot), list_project_tree_with_hidden: () => snapshot.files,
      read_project_file: readFiles({ "references.bib": BIB_SOURCE, "conference.sty": "\\ProvidesPackage{conference}" }),
    });
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Preview");
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    await openTreeFile("introduction.tex");
    expect(document.querySelector(".source-editor")).toBeNull();

    // An auxiliary source opens in the plain source editor, with no document views.
    const expectPlainSource = async () => {
      await waitFor(() => expect(document.querySelector(".source-editor")).not.toBeNull());
      expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
      expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();
    };
    await openTreeFile("references.bib");
    await expectPlainSource();

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    selectDocumentView("Split");
    await openTreeFile("conference.sty");
    await expectPlainSource();

    fireEvent.click(await findProjectTreeItem("main.tex"));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" })).toBeInTheDocument();
  });

  it("restores pinned tabs, protects them from eviction and close, and persists unpinning", async () => {
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-pinned", projectId: "pinned-id", name: "Pinned tabs", rootDocuments: MAIN_DOCUMENT,
      files: fileNodes("main.tex", "pinned.tex", "old.tex"),
    });
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ maxOpenTabs: 2 }));
    persistLayout(snapshot.root, {
      openTabs: ["old.tex", "main.tex", "pinned.tex", "missing.tex"], pinnedTabs: ["pinned.tex", "missing.tex"],
      activeFile: "main.tex", canvasMode: "source", tabRecency: ["main.tex", "old.tex", "pinned.tex"],
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    const tabs = await screen.findByRole("tablist", { name: "Open files" });
    const pinnedTab = () => within(tabs).getByRole("tab", { name: /pinned\.tex/ });
    await waitFor(() => expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["pinned.tex", "main.tex"]));
    fireEvent.click(pinnedTab());
    await waitFor(() => expect(pinnedTab()).toHaveAttribute("aria-selected", "true"));
    fireEvent(pinnedTab(), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(pinnedTab()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close pinned.tex" })).toBeNull();
    fireEvent.contextMenu(pinnedTab());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin tab" }));
    await waitFor(() => expect(loadWorkspaceLayout(snapshot.root)?.pinnedTabs).toEqual([]));
    fireEvent.click(screen.getByRole("button", { name: "Close pinned.tex" }));
    await waitFor(() => expect(within(tabs).queryByRole("tab", { name: /pinned\.tex/ })).toBeNull());
  });

  it("opens the most recently used other file before a stale secondary or a TeX fallback", async () => {
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("old.tex", "Old paper"), files: fileNodes("old.tex", "recent.md", "current.bib"),
    });
    persistLayout(snapshot.root, {
      openTabs: ["old.tex", "recent.md", "current.bib"], activeFile: "current.bib", secondaryFile: "old.tex",
      canvasMode: "source", tabRecency: ["current.bib", "recent.md", "old.tex"],
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    fireEvent.click(await screen.findByRole("button", { name: "Split editor right" }));
    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:recent.md"));
  });

  it("releases the previous source editor after switching files", async () => {
    // Regression: DocumentCanvas closures capture their whole render scope and
    // CodeMirror keeps its extensions' closures alive, so an editor view held
    // strongly in that scope chained every replaced editor (and its document)
    // to its successor for the rest of the session.
    const collectGarbage = exposeGarbageCollector();
    const snapshot = projectSnapshot({ rootDocuments: [], files: fileNodes("a.txt", "b.txt", "c.txt") });
    persistLayout(snapshot.root, { openTabs: ["a.txt", "b.txt", "c.txt"], activeFile: "a.txt", canvasMode: "source" });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:a.txt"));
    const firstView = new WeakRef(EditorView.findFromDOM(paneContent("primary")!)!);
    for (const path of ["b.txt", "c.txt", "b.txt", "c.txt"]) {
      fireEvent.click(await screen.findByRole("tab", { name: path }));
      await waitFor(() => expect(paneContent("primary")).toHaveTextContent(`content:${path}`));
    }
    await waitFor(async () => {
      await collectGarbage();
      expect(firstView.deref()).toBeUndefined();
    }, { timeout: 5_000 });
  });

  it("uses document modes for previewable files and accepts a tab on the canvas edge", async () => {
    localStorage.setItem("lattice.split-ratio.v1", "0.7");
    renderApp({ ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "intro.tex") })), read_project_file: readPathContent });
    await screen.findByRole("tablist", { name: "Document view" });
    const editSelected = () => expect(within(screen.getByRole("tablist", { name: "Document view" })).getByRole("tab", { name: "Edit" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();

    selectDocumentView("Preview");
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();
    selectDocumentView("Split");
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();

    selectDocumentView("Edit");
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();
    await openTreeFile("intro.tex");
    await openTreeFile("main.tex");

    dragTabToRightEdge(/main\.tex/, () => {
      expect(document.querySelector(".editor-tab-split-drop-preview")).toHaveTextContent("Open on right");
    });

    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:main.tex"));
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toBe("minmax(220px, 0.5fr) 1px minmax(220px, 0.5fr)");
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.5");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();
    editSelected();

    selectDocumentView("Split");
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" })).toBeInTheDocument();
    selectDocumentView("Preview");
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    selectDocumentView("Edit");
    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:main.tex"));
    editSelected();
  });

  it("previews a document focused in the right pane and restores the dual layout", async () => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "references.bib") });
    renderApp({ ...projectCommands(snapshot), read_project_file: readFiles({ "references.bib": BIB_SOURCE }) });
    await openTreeFile("references.bib");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Edit");

    dragTabToRightEdge(/main\.tex/);

    // The bibliography stays on the left, main.tex on the right.
    const expectBothSources = () => {
      expect(paneContent("primary")).toHaveTextContent("@article{lattice");
      expect(paneContent("secondary")).toHaveTextContent("\\documentclass{article}");
    };
    const mainSelected = () => expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(expectBothSources);
    stubRect(document.querySelector<HTMLElement>(".dual-canvas")!, 0, 0, 1000, 700);
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize dual source panes" }));
    fireEvent.pointerMove(window, { clientX: 650 });
    fireEvent.pointerUp(window, { clientX: 650 });
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.65");
    mainSelected();
    expect(screen.getByRole("tablist", { name: "Document view" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument());
    expect(within(document.querySelector<HTMLElement>(".dual-pane-preview[data-editor-pane='secondary']")!)
      .getByLabelText("Show document outline")).toBeInTheDocument();
    expect(paneContent("primary")).toHaveTextContent("@article{lattice");
    expect(document.querySelector(".source-editor[data-editor-pane='secondary']")).toBeNull();
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns).toContain("0.65fr");
    expect(document.querySelector(".active-document")).toHaveTextContent("main.tex");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => {
      expectBothSources();
      mainSelected();
    });
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns).toContain("0.65fr");

    fireEvent.click(screen.getByRole("tab", { name: "Split" }));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" })).toBeInTheDocument();
    expect(paneContent("primary")).toHaveTextContent("\\documentclass{article}");

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(expectBothSources);
    mainSelected();
  });

  it("splits a TeX preview without replacing it with the source editor", async () => {
    renderApp({ ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "notes.md") })), read_project_file: readPathContent });
    await openTreeFile("notes.md");
    await openTreeFile("main.tex");
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Split editor right" }));
    await waitFor(() => expect(document.querySelector(".dual-pane-preview[data-editor-pane='primary'] .pdf-column"))
      .toBeInTheDocument());
    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:notes.md"));
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeNull());
    expect(document.querySelector(".pdf-column")).toBeInTheDocument();
    expect(document.querySelector(".source-editor")).toBeNull();
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not forward-sync a stale TeX cursor when the visible split peer is a spreadsheet", async () => {
    stubObjectUrls(() => "blob:lattice-pdf");
    vi.mocked(getDocument).mockReturnValue({ promise: new Promise(() => undefined), destroy: vi.fn() } as never);
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "results.lattice-sheet") })),
      read_project_file: readFiles({ "results.lattice-sheet": "{}" }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      build_project: buildResult({ hasPdf: true, durationMs: 1, rootDocument: "main.tex" }),
      synctex_view: () => ({ page: 1, x: 72, y: 96, width: 120, height: 14 }),
    });
    await screen.findByRole("button", { name: /Reveal cursor in PDF/i });
    fireEvent.click(await findProjectTreeItem("results.lattice-sheet"));
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Preview");
    fireEvent.click(screen.getByRole("button", { name: "Split editor right" }));
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    const revealCursor = await screen.findByRole("button", { name: /Reveal cursor in PDF/i });
    await waitFor(() => expect(revealCursor).toBeDisabled());
    const syncCallsBeforeClick = invokeCalls("synctex_view").length;
    fireEvent.click(revealCursor);
    expect(invokeCalls("synctex_view")).toHaveLength(syncCallsBeforeClick);
    expect(document.querySelector(".dual-canvas")).toBeInTheDocument();
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();
    expect(screen.getByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
  });

  it("previews each Markdown pane independently and allows both previews", { timeout: 60_000 }, async () => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "left.md", "right.md") });
    persistLayout(snapshot.root, {
      openTabs: ["left.md", "right.md"], activeFile: "left.md", secondaryFile: "right.md", canvasMode: "dual",
    });
    renderApp({
      ...projectCommands(snapshot), read_project_file: readFiles({ "left.md": "# Left notes" }, "# Right notes"),
      write_project_file: undefined,
    });
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2), { timeout: 20_000 });

    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    const visualPaths = () => Array.from(
      document.querySelectorAll<HTMLElement>(".visual-markdown-editor"), (editor) => editor.dataset.activePath,
    );
    const visualEditors = () => screen.getAllByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(visualEditors()).toHaveLength(1), { timeout: 30_000 });
    expect(visualPaths()).toEqual(["left.md"]);
    const rightSource = paneContent("secondary");
    expect(rightSource).toHaveTextContent("# Right notes");

    fireEvent.focus(rightSource!);
    await waitFor(() => expect(within(documentView).getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));

    await waitFor(() => expect(visualPaths()).toEqual(["left.md", "right.md"]));
    expect(visualEditors()).toHaveLength(2);
    expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(0);

    act(() => { visualEditorOf(visualEditors()[1]).commands.setContent(parseVisualMarkdown("# Right preview edit")); });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(visualPaths()).toEqual(["left.md"]));
    expect(paneContent("secondary")).toHaveTextContent("# Right preview edit");
  });

  it.each(["left.md", "right.md"])("restores both split files when returning through %s", { timeout: 30_000 }, async (returnPath) => {
    const snapshot = projectSnapshot({ rootDocuments: rootDocument("left.md"), files: fileNodes("left.md", "right.md", "references.bib") });
    persistLayout(snapshot.root, {
      openTabs: ["left.md", "right.md", "references.bib"], activeFile: "left.md", secondaryFile: "right.md",
      canvasMode: "dual",
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: (args) => `# ${argPath(args)}`, write_project_file: undefined });
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2), { timeout: 20_000 });
    fireEvent.click(screen.getByRole("tab", { name: /references\.bib/ }));
    await waitFor(() => {
      expect(document.querySelector(".dual-canvas")).toBeNull();
      expect(document.querySelector(".source-editor .cm-content")).toHaveTextContent("# references.bib");
    });
    fireEvent.click(screen.getByRole("tab", { name: fileTabName(returnPath) }));
    await waitFor(() => {
      expect(paneContent("primary")).toHaveTextContent("# left.md");
      expect(paneContent("secondary")).toHaveTextContent("# right.md");
    });
    expect(screen.queryByRole("textbox", { name: "Markdown document editor" })).toBeNull();
    expect(screen.getByRole("tab", { name: fileTabName(returnPath) })).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    ["Close split", null, "right.md"], ["Close left.md", "left.md", "right.md"], ["Close right.md", "right.md", "left.md"],
  ])("collapses a two-file split with %s and keeps %s closed", async (button, closedPath, survivingPath) => {
    const snapshot = projectSnapshot({ files: fileNodes("left.md", "right.md") });
    persistLayout(snapshot.root, {
      openTabs: ["left.md", "right.md"], activeFile: "left.md", activeTab: "right.md", secondaryFile: "right.md",
      focusedPane: "secondary", canvasMode: "dual", tabRecency: ["right.md", "left.md"],
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: (args) => `# ${argPath(args)}`, write_project_file: undefined });
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeNull());
    expect(document.querySelector(".source-editor .cm-content")).toHaveTextContent(`# ${survivingPath}`);
    expect(screen.getByRole("tab", { name: fileTabName(survivingPath) })).toHaveAttribute("aria-selected", "true");
    for (const path of ["left.md", "right.md"]) {
      if (path === closedPath) expect(screen.queryByRole("tab", { name: fileTabName(path) })).toBeNull();
      else expect(screen.getByRole("tab", { name: fileTabName(path) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Close split" })).toBeNull();
  });

  it("renders a board canvas rather than its JSON in the secondary split pane", async () => {
    const snapshot = projectSnapshot({ files: fileNodes("sketch.tldr", "notes.md") });
    persistLayout(snapshot.root, {
      openTabs: ["sketch.tldr", "notes.md"], activeFile: "notes.md", activeTab: "sketch.tldr",
      secondaryFile: "sketch.tldr", focusedPane: "secondary", canvasMode: "dual",
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: readFiles({ "sketch.tldr": EMPTY_BOARD }, "# Notes") });
    expect((await screen.findByTestId("board-editor-mock")).closest("[data-editor-pane='secondary']")).not.toBeNull();
    expect(document.querySelector(".dual-canvas")).not.toBeNull();
    expect(paneContent("primary")).toHaveTextContent("# Notes");
  });

  it("keeps a Markdown preview on the right when a board is dropped on the left", async () => {
    const snapshot = markdownSnapshot("notes.md", fileNodes("notes.md", "sketch.tldr"));
    persistLayout(snapshot.root, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    renderApp({ ...projectCommands(snapshot), read_project_file: readFiles({ "sketch.tldr": EMPTY_BOARD }, "# Notes") });
    await screen.findByRole("separator", { name: "Resize editor and Markdown preview" });
    stubCanvasRect(200, 40, 800, 600);
    dragToPoint(await findProjectTreeItem("sketch.tldr"), [250, 300], { pointerId: 45 });
    expect((await screen.findByTestId("board-editor-mock")).closest("[data-editor-pane='primary']")).not.toBeNull();
    expect(document.querySelector(".dual-pane-preview[data-editor-pane='secondary'] .secondary-markdown-preview"))
      .not.toBeNull();
    expect(document.querySelector(".source-editor[data-editor-pane='secondary']")).toBeNull();
  });

  it("keeps the current editor when an active-tab split loses a race with a late edit", async () => {
    const splitRead = deferred<string>();
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "intro.tex") })), write_project_file: undefined,
      read_project_file: (args) => (argPath(args) === "intro.tex" ? splitRead.promise : readPathContent(args)),
    });
    await screen.findByRole("tablist", { name: "Document view" });
    const introTab = await findProjectTreeItem("intro.tex");
    selectDocumentView("Edit");
    stubCanvasRect(200, 40, 800, 600);
    dragToPoint(introTab, [850, 300], { pointerId: 9, from: [120, 16] });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "intro.tex" }));
    const editor = editorViewAt(".source-editor[data-editor-pane='primary'] .cm-editor");
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: "\nEdited while splitting." } }));
    act(() => splitRead.resolve("content:intro.tex"));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /intro\.tex/ })).toHaveAttribute("aria-selected", "true");
      expect(editor.state.doc.toString()).toContain("Edited while splitting.");
      expect(document.querySelector(".dual-canvas")).not.toBeNull();
    });
  });

  it("restores tab order and active pane while migrating the old three-column layout", async () => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "intro.tex", "method.tex") });
    persistLayout(snapshot.root, {
      openTabs: ["intro.tex", "main.tex", "method.tex"], activeFile: "main.tex", activeTab: "method.tex",
      secondaryFile: "method.tex", focusedPane: "secondary", canvasMode: "columns",
      tabRecency: ["method.tex", "main.tex", "intro.tex"],
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeInTheDocument());
    expect(document.querySelector(".columns-canvas")).toBeNull();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".editor-tab"), (tab) => tab.dataset.tabPath))
      .toEqual(["intro.tex", "main.tex", "method.tex"]);
    expect(screen.getByRole("tab", { name: /method\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(paneContent("secondary")).toHaveTextContent("content:method.tex");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "main.tex", projectRoot: ROOT });
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "method.tex", projectRoot: ROOT });
  });

  it.each([false, true])("loads Papers even when a file is opened while the initial paper scan is pending (save: %s)", async (saveBeforeScan) => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "references.bib") });
    const paper = {
      arxivId: "", citationKey: "hinton06", title: "A Fast Learning Algorithm for Deep Belief Nets",
      authors: "Hinton, Geoffrey E.", hasFullText: false, hasBlog: false,
    };
    const firstScan = deferred<unknown[]>();
    let scanCalls = 0;
    renderApp({
      initial_project: snapshot,
      list_papers: () => (++scanCalls === 1 ? firstScan.promise : [{ ...paper, title: "Updated title" }]),
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      read_project_file: readFiles({
        "references.bib": "@article{hinton06,title={A Fast Learning Algorithm for Deep Belief Nets}}",
      }, "Main"),
    });
    await waitFor(() => expect(scanCalls).toBeGreaterThan(0));
    fireEvent.click(await findProjectTreeItem("references.bib", 10_000));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent("@article{hinton06"), { timeout: 10_000 });
    if (saveBeforeScan) {
      const view = editorViewAt(".source-editor .cm-editor");
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "@article{hinton06,title={Updated title}}" } }));
      fireEvent.keyDown(window, { key: "s", metaKey: true });
      await waitFor(() => expect(scanCalls).toBe(2));
      await switchSidebarMode("Papers");
      expect(await screen.findByText("Updated title")).toBeInTheDocument();
    }
    await act(async () => firstScan.resolve([paper]));
    await switchSidebarMode("Papers");
    expect(await screen.findByText(saveBeforeScan ? "Updated title" : paper.title)).toBeInTheDocument();
    expect(document.querySelector(".source-editor .cm-content")).toHaveTextContent("@article{hinton06");
  });

  it.each([
    ["references.bib", "primary"], ["other.bib", "primary"], ["other.bib", "secondary"],
  ] as const)("formats %s in %s on save and refreshes Papers without losing later edits", async (path, pane) => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", path) });
    const original = "@article{x,title={Old},author={Ada},year={2024}}";
    const edited = "@article{x,title={New},author={Ada},year={2024}}";
    const formatted = "@article{x,\n  title = {New},\n  author = {Ada},\n  year = {2024}\n}";
    let finishWrite: (() => void) | undefined;
    let saved = false;
    persistLayout(snapshot.root, {
      openTabs: ["main.tex", path], activeFile: pane === "primary" ? path : "main.tex", activeTab: path,
      secondaryFile: pane === "secondary" ? path : null, focusedPane: pane,
      canvasMode: pane === "secondary" ? "dual" : "source", documentMode: "source", paperView: "fulltext",
      tabRecency: [path, "main.tex"],
    });
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, read_project_file: readFiles({ [path]: original }, "Main"),
      list_papers: () => [{ arxivId: "bib:x", title: saved ? "New" : "Old", authors: "Ada", hasFullText: false, hasBlog: false }],
      // The bibliography refresh must not wait for unrelated project scans.
      list_history: () => (saved ? new Promise(() => {}) : mockAppCommand("list_history")),
      write_project_file: async (args) => {
        await new Promise<void>(resolve => { finishWrite = resolve; });
        saved = true;
        return { content: (args as { content: string }).content, hadConflicts: false };
      },
    });
    const view = await expectEditorText(original, `.source-editor[data-editor-pane='${pane}'] .cm-editor`, { timeout: 10_000 });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: edited } });
    if (path === "references.bib") await switchSidebarMode("Papers");
    else if (pane === "primary") fireEvent.keyDown(window, { key: "s", metaKey: true });
    // The secondary case deliberately relies on idle autosave.
    await waitFor(() => expect(finishWrite).toBeDefined(), { timeout: 3000 });
    expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({ path, content: formatted, baseContent: original }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(formatted));
    const paperCalls = invokeCalls("list_papers").length;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% later edit" } });
    finishWrite!();
    await waitFor(() => {
      expect(saved).toBe(true);
      expect(invokeCalls("list_papers").length).toBeGreaterThan(paperCalls);
    });
    expect(view.state.doc.toString()).toBe(`${formatted}\n% later edit`);
    await switchSidebarMode("Papers");
    await screen.findByText("New", { selector: "strong" });
    expect(screen.queryByText("Old", { selector: "strong" })).not.toBeInTheDocument();
  });

  /** Renders main.tex and a second TeX file, each read as `content:<path>`, answering saves with `write`. */
  const renderTexPair = (write: CommandResult, second = "intro.tex") => renderApp({
    ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", second) })), read_project_file: readPathContent,
    write_project_file: write,
  });

  it("overlaps the pre-switch save with the next file's read and gates the commit on it", async () => {
    const writeResolvers: Array<() => void> = [];
    renderTexPair(() => new Promise<void>((resolve) => writeResolvers.push(resolve)));
    await appendToEditor("\nEdited.");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    // The read of the next file starts while the previous file's write is
    // still pending — they used to run serially.
    await expectInvoked("read_project_file", expect.objectContaining({ path: "intro.tex" }));
    expect(writeResolvers.length).toBeGreaterThan(0);
    // But the switch must not commit until the save confirms.
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    writeResolvers.splice(0).forEach((resolve) => resolve());
    await waitForSelectedTab("intro.tex");
  });

  it("keeps the current document when the pre-switch save fails", async () => {
    renderTexPair(() => { throw new Error("disk full"); });
    await appendToEditor("\nEdited.");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await expectNotification(/Could not save main\.tex/);
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /intro\.tex/ })).toBeNull();
  });

  it("serializes the switch when the target is the dirty secondary file", async () => {
    persistLayout(ROOT, { openTabs: ["main.tex", "method.tex"], activeFile: "main.tex", secondaryFile: "method.tex", canvasMode: "dual" });
    const writeResolvers: Array<() => void> = [];
    renderTexPair(() => new Promise<void>((resolve) => writeResolvers.push(resolve)), "method.tex");
    await appendToEditor("\nEdited.", ".source-editor[data-editor-pane='secondary'] .cm-editor");
    vi.mocked(invoke).mockClear();
    fireEvent.click(await findProjectTreeItem("method.tex"));
    await waitFor(() => expect(writeResolvers.length).toBeGreaterThan(0));
    // save() rewrites method.tex itself, so the read may not start until the
    // write has finished — otherwise the editor would load pre-save contents.
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "method.tex" }));
    writeResolvers.splice(0).forEach((resolve) => resolve());
    await expectInvoked("read_project_file", expect.objectContaining({ path: "method.tex" }));
  });

  it("opens relative project files from Markdown previews", async () => {
    const snapshot = projectSnapshot({
      files: [fileNode("main.tex"), dirNode("notes", fileNodes("notes/index.md", "notes/native-unified-view.md"))],
    });
    persistLayout(snapshot.root, { openTabs: ["notes/index.md"], activeFile: "notes/index.md", secondaryFile: "", canvasMode: "split" });

    await Promise.all([loadTextLanguageExtensions("notes/index.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: readFiles({
        "notes/index.md": "---\ntitle: Exact metadata\n---\n[Native unified view](native-unified-view.md)\n\n-\n  [ ] Review preview",
      }, "# Native unified view"),
    });
    const editor = await waitFor(() => {
      const view = editorViewAt(".source-editor .cm-editor");
      expect(view.state.doc.toString()).toContain("[Native unified view]");
      expect(syntaxTree(view.state).toString()).toContain("Link(");
      return view;
    }, { timeout: 10_000 });
    const documentView = screen.getByRole("tablist", { name: "Document view" });
    const scrollContainer = () => screen.getByTestId("editor-scroll-container");
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(await screen.findByTestId("editor-scroll-container")).toHaveStyle({ overflowAnchor: "none" });
    const visualEditor = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    act(() => {
      visualEditor.commands.setContent(parseVisualMarkdown("[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview"));
    });
    await waitFor(() => expect(editor.state.doc.toString()).toContain("[Visually edited view](native-unified-view.md)"));
    expect(editor.state.doc.toString()).toBe(
      "---\ntitle: Exact metadata\n---\n[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview",
    );
    await waitFor(() => expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(editor.state.doc.toString()).toContain("- [x] Review preview"));

    // Source edits reach the preview on an idle budget rather than per keystroke, but an edit the preview itself
    // published is handed straight back: a document older than the one it last emitted reads as a remote revert and
    // would roll the user's typing back once the budget elapsed. Outlast the budget, twice, and confirm both
    // surfaces still agree.
    const expectPreviewEditKept = () => {
      expect(editor.state.doc.toString()).toContain("- [x] Review preview");
      expect(screen.getByRole("checkbox")).toBeChecked();
      expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument();
    };
    await act(() => pause(400));
    expectPreviewEditKept();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("checkbox")).toBeChecked();
    await act(() => pause(400));
    expectPreviewEditKept();

    const initialSplitPreview = scrollContainer();
    editor.scrollDOM.scrollTop = 360;
    initialSplitPreview.scrollTop = 520;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const editEditor = editorViewAt(".source-editor .cm-editor");
    expect(document.querySelector(".markdown-preview")).toBeNull();
    await waitFor(() => expect(editEditor.scrollDOM.scrollTop).toBe(360));

    editEditor.scrollDOM.scrollTop = 420;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const splitEditor = editorViewAt(".source-editor .cm-editor");
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(scrollContainer()).toHaveStyle({ overflowAnchor: "none" });
    await waitFor(() => expect(splitEditor.scrollDOM.scrollTop).toBe(420));
    await waitFor(() => expect(scrollContainer().scrollTop).toBe(420));
    splitEditor.dispatch({
      changes: { from: 0, to: splitEditor.state.doc.length, insert: "[Updated native view](native-unified-view.md)" },
    });
    // Re-rendering the preview costs a full parse of the document, so source keystrokes reach it on an idle budget
    // instead of one parse per key. The edit is still pending on the commit that follows the dispatch, and lands
    // once typing stops.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("link", { name: "Updated native view" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Updated native view" })).toBeInTheDocument();

    scrollContainer().scrollTop = 540;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const previewViewport = scrollContainer();
    expect(previewViewport.style.overflowAnchor).toBe("");
    await waitFor(() => expect(previewViewport.scrollTop).toBe(540));

    // Preview and Split mount separate visual-editor roots. Ordinary toolbar switches must hand the viewport to the
    // replacement just like the explicit View in Source action below does.
    await act(() => nextFrames(2));
    const ordinaryPreviewViewport = scrollContainer();
    let ordinaryPreviewScrollTop = 560;
    Object.defineProperty(ordinaryPreviewViewport, "scrollTop", {
      configurable: true,
      get: () => ordinaryPreviewViewport.isConnected ? ordinaryPreviewScrollTop : 0,
      set: (value: number) => { ordinaryPreviewScrollTop = value; },
    });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const ordinarySplitViewport = scrollContainer();
    await waitFor(() => expect(ordinarySplitViewport.scrollTop).toBe(560));
    ordinarySplitViewport.scrollTop = 570;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(scrollContainer().scrollTop).toBe(570));

    const previewEditor = visualEditorOf(screen.getByRole("textbox", { name: "Markdown document editor" }));
    act(() => { previewEditor.commands.setTextSelection({ from: 1, to: 8 }); });
    const viewSourceButton = await screen.findByRole("button", { name: "View in source Markdown" });
    const explicitPreviewViewport = scrollContainer();
    explicitPreviewViewport.scrollTop = 480;
    fireEvent.click(viewSourceButton);
    expect(await screen.findByRole("separator", { name: "Resize editor and Markdown preview" })).toBeInTheDocument();
    const splitPreviewViewport = scrollContainer();
    expect(splitPreviewViewport).not.toBe(explicitPreviewViewport);
    const revealedEditor = editorViewAt(".source-editor .cm-editor");
    // The visual selection starts on the link's first visible character. Its exact Markdown position is after the
    // opening `[`, rather than the old block-level fallback at offset zero.
    await waitFor(() => expect(revealedEditor.state.selection.main.head).toBe(1));

    // Exercise the settled Split geometry directly: the selected source-backed block has content center 920, while
    // its source range has center 610. View in Source must put both at the center of their 400px viewports.
    await act(() => nextFrames(3));
    stubScrollBox(splitPreviewViewport, 400, 2_000);
    stubScrollBox(revealedEditor.scrollDOM, 400, 3_000);
    splitPreviewViewport.scrollTop = 300;
    const previewRectSpy = stubRect(splitPreviewViewport, 0, 100, 500, 400);
    const sourceBackedBlock = splitPreviewViewport.querySelector<HTMLElement>("[data-source-offset='0']");
    if (!sourceBackedBlock) throw new Error("Split Preview did not publish a source-backed block.");
    const sourceBackedBlockRectSpy = vi.spyOn(sourceBackedBlock, "getBoundingClientRect").mockImplementation(() => {
      const top = 1_000 - splitPreviewViewport.scrollTop;
      return { x: 0, y: top, top, bottom: top + 40, left: 0, right: 500, width: 500, height: 40, toJSON: () => ({}) };
    });
    const lineBlockSpy = vi.spyOn(revealedEditor, "lineBlockAt").mockReturnValue({ top: 600, bottom: 620 } as never);
    const splitVisualEditor = visualEditorOf(screen.getByRole("textbox", { name: "Markdown document editor" }));
    act(() => splitVisualEditor.commands.setTextSelection({ from: 1, to: 8 }));
    fireEvent.click(await screen.findByRole("button", { name: "View in source Markdown" }));
    await waitFor(() => expect(revealedEditor.scrollDOM.scrollTop).toBe(410));
    await waitFor(() => expect(splitPreviewViewport.scrollTop).toBe(720));
    await act(() => nextFrames(3));

    // The first tiny source scroll must not perform a deferred correction.
    fireEvent.scroll(revealedEditor.scrollDOM);
    await act(() => nextFrames(2));
    expect(splitPreviewViewport.scrollTop).toBe(720);
    lineBlockSpy.mockRestore();
    previewRectSpy.mockRestore();
    sourceBackedBlockRectSpy.mockRestore();

    splitPreviewViewport.scrollTop = 580;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const restoredPreviewViewport = scrollContainer();
    await waitFor(() => expect(restoredPreviewViewport.scrollTop).toBe(580));

    restoredPreviewViewport.scrollTop = 640;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const restoredEditEditor = editorViewAt(".source-editor .cm-editor");
    await waitFor(() => expect(restoredEditEditor.scrollDOM.scrollTop).toBe(640));

    stubScrollBox(restoredEditEditor.scrollDOM, 1_000, 3_000);
    restoredEditEditor.scrollDOM.scrollTop = 1_000;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    const sourceMappedPreviewViewport = scrollContainer();
    // Keep the handoff pending beyond the old two-frame window, as happens
    // while the lazy visual-editor chunk or its scroll geometry is settling.
    await act(() => nextFrames(4));
    stubScrollBox(sourceMappedPreviewViewport, 1_000, 5_000);
    await waitFor(() => expect(sourceMappedPreviewViewport.scrollTop).toBe(2_000));
    fireEvent.click(await screen.findByRole("link", { name: "Updated native view" }), { metaKey: true });

    await expectInvoked("read_project_file", { path: "notes/native-unified-view.md" });
    expect(await screen.findByRole("tab", { name: /native-unified-view\.md/ })).toHaveAttribute("aria-selected", "true");
  }, 40_000);

  it("opens project-root Slides, Sheets, and boards from nested Markdown links", async () => {
    const snapshot = projectSnapshot({
      files: [
        fileNode("main.tex"), dirNode("notes", [fileNode("notes/index.md")]),
        dirNode("slides", [dirNode("slides/native", [fileNode("slides/native/index.tsx")])]),
        ...fileNodes("results.lattice-sheet", "sketch.tldr"),
      ],
    });
    const contentByPath: Record<string, string> = {
      "notes/index.md": "[Open slides](slides/native/index.tsx)\n\n[Open sheet](results.lattice-sheet)\n\n[Open board](sketch.tldr)",
      "slides/native/index.tsx": "export default [];\n", "results.lattice-sheet": "{}", "sketch.tldr": EMPTY_BOARD,
    };
    persistLayout(snapshot.root, { openTabs: ["notes/index.md"], activeFile: "notes/index.md", secondaryFile: "", canvasMode: "split" });

    await Promise.all([loadTextLanguageExtensions("notes/index.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: (args) => {
        if (argPath(args) in contentByPath) return contentByPath[argPath(args)];
        throw new Error(`Unexpected project path: ${argPath(args)}`);
      },
    });

    await waitFor(() => expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent("[Open slides]"), { timeout: 20_000 });
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    fireEvent.click(await screen.findByRole("link", { name: "Open slides" }));
    expect(await screen.findByTestId("open-slide-workspace-mock")).toHaveAttribute("data-path", "slides/native/index.tsx");
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", { path: "notes/slides/native/index.tsx", projectRoot: snapshot.root });

    for (const [link, editor, path] of [
      ["Open sheet", "spreadsheet-editor-mock", "results.lattice-sheet"], ["Open board", "board-editor-mock", "sketch.tldr"],
    ]) {
      fireEvent.click(screen.getByRole("tab", { name: /index\.md/ }));
      fireEvent.click(await screen.findByRole("link", { name: link }));
      expect(await screen.findByTestId(editor)).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledWith("read_project_file", { path, projectRoot: snapshot.root });
    }
  }, 40_000);

  it("opens HTML documents in an interactive sandboxed preview with Edit and Split views", async () => {
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("report.html", "Results"),
      files: [
        fileNode("report.html", "text", { contentKind: "text", size: 8 * 1024 * 1024 + 1 }),
        fileNode("figures/chart.html", "text", { contentKind: "text" }), fileNode("notes.md"),
      ],
    });
    let imageBase64 = "iVBORw0KGgo=";
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: readFiles({
        "report.html": "<!doctype html><html><head><base href='https://example.com/'><style>h1{color:tomato}</style></head><body><h1 id='results'>Results</h1><img src='figures/figure1_feature_retention.png' alt='Feature Retention'><iframe src='figures/chart.html' title='Plot'></iframe><button onclick='this.textContent=&quot;Done&quot;'>Run</button><a href='./details.html'>Details</a><a href='#results'>Jump</a><script>window.previewReady=true</script></body></html>",
      }, "# Notes"),
      read_project_asset: (args) => argPath(args) === "figures/chart.html" ? {
        path: "figures/chart.html", mimeType: "text/html",
        base64: btoa("<!doctype html><html><body><div id='plot'></div><script>Plotly.newPlot('plot', [], {})</script></body></html>"),
      } : { path: argPath(args), mimeType: "image/png", base64: imageBase64 },
    });
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    const previewTitle = "HTML preview for report.html";
    expect(screen.queryByTitle(previewTitle)).not.toBeInTheDocument();
    fireEvent.pointerDown(documentView);
    const preview = await screen.findByTitle<HTMLIFrameElement>(previewTitle, {}, { timeout: 30_000 });
    const srcdoc = () => preview.getAttribute("srcdoc");
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    for (const kept of [
      '<h1 id="results">Results</h1>', "h1{color:tomato}", "<script>window.previewReady=true</script>", "onclick=",
      '<base href="about:blank">', "href=\"#results\"", 'data-lattice-preview="fragment-navigation"',
      "target.scrollIntoView()", "lattice:html-preview-open-external",
    ]) expect(srcdoc()).toContain(kept);
    expect(srcdoc()).not.toContain("https://example.com/");
    expect(srcdoc()).not.toContain("href=\"./details.html\"");
    await waitFor(() => expect(srcdoc()).toContain('src="data:image/png;base64,iVBORw0KGgo="'));
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/figure1_feature_retention.png", projectRoot: ROOT });
    await waitFor(() => expect(srcdoc()).toContain("Plotly.newPlot"));
    expect(srcdoc()).not.toContain('src="figures/chart.html"');
    expect(srcdoc()).toContain('sandbox="allow-scripts"');
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/chart.html", projectRoot: ROOT });

    const assetReadsBeforePaperFetch = invokeCalls("read_project_asset").length;
    imageBase64 = "bmV3LWltYWdl";
    await switchSidebarMode("Agent");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(tauriEventApi.handlers.get("project-fs-changed")?.size).toBeGreaterThan(0));
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: [".research/papers/1706.03762/paper.md"] });
    await act(async () => { await pause(0); });
    expect(invokeCalls("read_project_asset")).toHaveLength(assetReadsBeforePaperFetch);
    expect(srcdoc()).toContain('src="data:image/png;base64,iVBORw0KGgo="');

    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["figures/figure1_feature_retention.png"] });
    await waitFor(() => expect(srcdoc()).toContain('src="data:image/png;base64,bmV3LWltYWdl"'));

    const zoomMessages = vi.spyOn(preview.contentWindow!, "postMessage");
    const zoomPercentage = () => screen.getByLabelText("HTML zoom percentage");
    expect(zoomPercentage()).toHaveValue("100");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomPercentage()).toHaveValue("110");
    expect(zoomMessages).toHaveBeenCalledWith({ type: "lattice:html-preview-set-zoom", scale: 1.1 }, "*");

    await waitFor(() => expect(preview.contentDocument?.readyState).toBe("complete"));
    postWindowMessage(preview.contentWindow, { type: "lattice:html-preview-open-external", href: "https://arxiv.org/abs/2110.04366" }, "");
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(new URL("https://arxiv.org/abs/2110.04366")));

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(screen.queryByTitle(previewTitle)).not.toBeInTheDocument();

    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(await screen.findByTitle(previewTitle)).toBeInTheDocument();
    expect(zoomPercentage()).toHaveValue("110");
    expect(screen.getByRole("separator", { name: "Resize editor and HTML preview" })).toBeInTheDocument();

    const editor = editorViewAt(".source-editor .cm-editor");
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "<!doctype html><html><body><h2>Updated results</h2></body></html>" },
    });
    await waitFor(() => expect(screen.getByTitle(previewTitle).getAttribute("srcdoc")).toContain("<h2>Updated results</h2>"));

    // Republishing srcdoc reloads the frame, so the reader's position has to be carried across it — otherwise every
    // pause in typing threw the author back to the top of their own document.
    const reloaded = screen.getByTitle<HTMLIFrameElement>(previewTitle);
    postWindowMessage(reloaded.contentWindow, {
      type: "lattice:html-preview-scroll", clientHeight: 600, scrollHeight: 4000, scrollTop: 420,
    }, "");
    const postMessage = vi.spyOn(reloaded.contentWindow!, "postMessage");
    fireEvent.load(reloaded);
    expect(postMessage).toHaveBeenCalledWith({ type: "lattice:html-preview-set-scroll-top", scrollTop: 420 }, "*");

    stubScrollBox(editor.scrollDOM, 600, 2600);
    editor.scrollDOM.scrollTop = 1000;
    postMessage.mockClear();
    fireEvent.scroll(editor.scrollDOM);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "lattice:html-preview-set-scroll-top", scrollTop: 1700 }, "*"));

    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    stubCanvasRect(200, 40, 800, 600);
    dragToPoint(await findProjectTreeItem("notes.md"), [850, 300], {
      pointerId: 73, from: [20, 20], whileOver: () => {
        expect(document.body).toHaveClass("dragging-project-item");
        expect(document.querySelector(".editor-tab-split-drop-preview")).toHaveAttribute("data-drop-zone", "right");
      },
    });

    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("# Notes"));
    expect(document.querySelector(".dual-pane-preview[data-editor-pane='primary'] .html-preview-frame")).toBeInTheDocument();
    expect(document.body).not.toHaveClass("dragging-project-item");
  });

  it("adds and removes project dictionary terms from Editor settings", async () => {
    const snapshot = projectSnapshot({ spellingWords: ["VLM"] });
    renderApp({
      ...projectCommands(snapshot),
      set_project_spelling_words: (args) => {
        snapshot.manifest.spellingWords = (args as { words: string[] }).words;
        return snapshot.manifest;
      },
    });
    await chooseProjectMenuItem("Settings");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(screen.getByRole("list", { name: "Project dictionary terms" })).toHaveTextContent("VLM");
    fireEvent.change(screen.getByLabelText("Add project term"), { target: { value: "TexLab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await expectInvoked("set_project_spelling_words", { words: ["VLM", "TexLab"] });
    expect(await screen.findByText("TexLab")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove VLM from project dictionary" }));
    await expectInvoked("set_project_spelling_words", { words: ["TexLab"] });
    expect(screen.queryByText("VLM")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add project term"), { target: { value: "Synara" } });
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Add project term")).toHaveValue("Synara");
  });

  it("shows Synara failure states without rendering the retired Agent settings or composer", async () => {
    // Keep both lazy surfaces' cold transforms outside DOM query deadlines.
    await Promise.all([import("./app/app-agent-panel"), import("./settings/settings-dialog")]);
    synaraHook.runtime = {
      state: "stopped", origin: null, authToken: null, message: "Synara did not start.", startupMs: null, version: null, revision: null,
    };
    renderApp(projectCommands());
    const sidebar = await findElement(".shared-sidebar");
    // The fixed Agent surface stays hidden until its sidebar has measurable
    // geometry. jsdom has no layout, so give this visibility test a real slot.
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40, 320, 700));
    await switchSidebarMode("Agent");
    const agentFailure = await screen.findByRole("alert");
    expect(agentFailure).toBeVisible();
    expect(agentFailure).toHaveTextContent("Agent unavailable");
    expect(agentFailure).toHaveTextContent("Synara did not start.");
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Conversation history")).not.toBeInTheDocument();
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Providers" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(await within(settings).findByRole("alert")).toHaveTextContent("Agent unavailable");
    expect(within(settings).queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Subscriptions")).not.toBeInTheDocument();
  });

  it("moves the sidebar assistant below the editor and back without replacing its frame", async () => {
    // Keep cold module compilation outside the DOM query timeout.
    await import("./app/app-agent-panel");
    showAgentSidebar();
    renderApp({
      ...projectCommands(agentDockSnapshot()), list_papers: () => [attentionPaper({ authors: "Ashish Vaswani", hasBlog: false })],
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: null,
    });
    await screen.findByRole("button", { name: "Move assistant below editor" });
    expect(screen.queryByRole("button", { name: "Toggle assistant" })).toBeNull();
    const frame = await findFrame();
    const context = frame.contentWindow;
    const surface = () => frame.closest(".agent-panel-surface");
    // The dock and the sidebar share one live assistant document.
    const expectSameFrame = () => {
      expect(document.querySelector('iframe[title="Agent"]')).toBe(frame);
      expect(frame.contentWindow).toBe(context);
    };
    fireEvent.click(screen.getByRole("button", { name: "Move assistant below editor" }));
    expect(document.querySelector(".workspace")).toHaveClass("sidebar-hidden");
    expect(surface()).toHaveAttribute("aria-hidden", "false");
    expect(document.querySelector(".agent-dock-header")).not.toBeNull();
    selectDocumentView("Preview");
    expect(surface()).toHaveAttribute("aria-hidden", "true");
    expect(surface()).toHaveAttribute("inert");
    expect(localStorage.getItem("lattice.agent-docked.v1")).toBe("1");
    selectDocumentView("Split");
    expect(surface()).toHaveAttribute("aria-hidden", "false");
    expectSameFrame();
    postWindowMessage(context, { type: "synara:open-file", filePath: "/tmp/agent-dock/.research/papers/1706.03762/paper.md" });
    await screen.findByRole("heading", { name: "Attention Is All You Need" });
    expect(surface()).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "View original PDF" }));
    expect(surface()).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("tab", { name: /main\.tex/ }));
    await waitFor(() => expect(surface()).toHaveAttribute("aria-hidden", "false"));
    expectSameFrame();
    // Reopening the file navigator leaves the dock where it was.
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(document.querySelector(".agent-dock-header")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    expect(document.querySelector(".agent-dock-header")).toBeNull();
    expectSameFrame();
    fireEvent.click(screen.getByRole("button", { name: "Move assistant below editor" }));
    // jsdom has no panel geometry; browser tests cover the visible close control.
    fireEvent.click(document.querySelector('.agent-dock-header button[aria-label="Hide assistant"]')!);
    expect(surface()).toHaveAttribute("inert");
    expect(document.querySelector(".agent-dock-header")).toBeNull();
    expect(document.querySelector('iframe[title="Agent"]')).toBe(frame);
  });

  it.each([true, false])("restores the bottom assistant independently of sidebar visibility (open: %s)", async (open) => {
    await import("./app/app-agent-panel");
    showAgentSidebar();
    const view = renderApp(projectCommands(agentDockSnapshot()));
    fireEvent.click(await screen.findByRole("button", { name: "Move assistant below editor" }));
    if (open) fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    view.unmount();
    const restored = renderApp();
    await waitFor(() => {
      expect(document.querySelector(".agent-dock-header")).not.toBeNull();
      expect(document.querySelector('iframe[title="Agent"]')).not.toBeNull();
    });
    expect(document.querySelector(".workspace")?.classList.contains("sidebar-hidden")).toBe(!open);
    expect(document.querySelector(".agent-panel-surface")).toHaveAttribute("aria-hidden", "false");
    expect(synaraHook.enabledCalls).toContain(true);
    // Neither moving back to the sidebar nor hiding the dock should restore it.
    const action = open ? "Move assistant to sidebar" : "Hide assistant";
    fireEvent.click(document.querySelector(`.agent-dock-header button[aria-label="${action}"]`)!);
    restored.unmount();
    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    expect(document.querySelector(".agent-dock-header")).toBeNull();
    expect(localStorage.getItem("lattice.agent-docked.v1")).toBe("0");
  });

  it.each([true, false])("restores the Agent selection and sidebar visibility (open: %s)", async (open) => {
    // Finish cold compilation before DOM waits and unmount/remount assertions.
    await Promise.all([import("./settings/settings-dialog"), import("./canvas/document-canvas")]);
    localStorage.setItem("lattice.sidebar-mode.v1", "agent");
    localStorage.setItem("lattice.sidebar-open.v1", open ? "1" : "0");
    localStorage.setItem("lattice.agent-thread.v1:/tmp/lattice-paper", "saved-thread");

    const view = renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    if (!open) {
      expect(document.querySelector('iframe[title="Agent"]')).toBeNull();
      expect(synaraHook.enabledCalls).not.toContain(true);
      expect(localStorage.getItem("lattice.sidebar-open.v1")).toBe("0");
      fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    }
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    const frame = await findFrame();
    expect(new URL(frame.src).pathname).toBe("/saved-thread");
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frame.closest(".synara-frame-shell")).not.toHaveAttribute("data-ready");

    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });

    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    expect(postMessage).toHaveBeenCalledWith({ type: "lattice:request-agent-permission-mode" }, synaraHook.runtime.origin);

    postProjectHistory(frame, "wrong-thread", [], "https://untrusted.example");
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("saved-thread");
    postProjectHistory(frame, "selected-thread", []);
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("selected-thread");
    // Recording navigation must not reload the live iframe or interrupt a turn.
    expect(new URL(frame.src).pathname).toBe("/saved-thread");

    const openSettings = { type: "synara:open-settings", section: "providers" };
    postWindowMessage(frame.contentWindow, openSettings, "https://untrusted.example");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    postWindowMessage(frame.contentWindow, openSettings);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");
    view.unmount();
    renderApp();
    await waitFor(() => {
      const restored = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(restored).not.toBeNull();
      expect(new URL(restored!.src).pathname).toBe("/selected-thread");
    });
  });

  it("starts Synara when source control is requested", async () => {
    renderApp({ ...projectCommands(), git_status: () => ({
      available: true, repository: true, branch: "main", remote: "origin", remoteUrl: "git@github.com:leo1oel/lattice.git", files: [],
    }) });
    await screen.findByRole("button", { name: "Switch project" });
    expect(synaraHook.enabledCalls).not.toContain(true);
    fireEvent.click(screen.getByRole("button", { name: "Git status and commit" }));
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open this repository on GitHub" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice");
  });

  it("routes agent paper, file, link, and review requests to their native surfaces", async () => {
    const sections = fileNode("sections", "folder", { children: [fileNode("sections/intro.tex")] });
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), sections] });
    renderApp({
      ...projectCommands(snapshot),
      read_project_file: (args) => {
        if (!argPath(args)?.endsWith(".png")) return "\\documentclass{article}";
        throw new Error("This is a binary or unsupported file and cannot be opened in the source editor.");
      },
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/png", base64: "iVBORw0KGgo=" }),
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: false })],
      read_paper: "---\ntitle: Attention Is All You Need\n---\n\n## Abstract\n\nPaper content.", read_paper_blog_local: null,
      build_project: buildResult({ durationMs: 5, rootDocument: "/private/outside/main.tex" }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    await switchSidebarMode("Papers");
    await screen.findByTitle("Attention Is All You Need");
    const { frame } = await openAgentFrame();

    const agent = (data: object) => postWindowMessage(frame.contentWindow, data);
    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/notes/detailed%20distillation.md" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "notes/detailed distillation.md" }));

    agent({ type: "synara:open-external", url: "https://example.com/paper" });
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/paper"));

    agent({ type: "synara:open-external", url: "javascript:alert(1)" });
    expect(openUrl).toHaveBeenCalledTimes(1);

    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/.research/papers/1706.03762/paper.md" });
    expect(await screen.findByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });

    agent({ type: "synara:open-review", filePath: "sections/intro.tex" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "sections/intro.tex" }));
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();

    const figure = "figures/mmvp_prefix_suffix_retained_pair_accuracy_plotly.png";
    agent({ type: "synara:open-review", filePath: figure });
    expect(await screen.findByAltText(`Preview of ${figure}`)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: figure });

    agent({ type: "synara:open-review", threadId: "thread-1", turnId: "turn-9" });
    expect(await screen.findByRole("tab", { name: "Agent turn" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Git workspace" })).toHaveClass("drawer-view-tabs");
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveClass("drawer-view-tab");
    expect(screen.getByRole("tab", { name: "Changes" })).not.toHaveClass("ui-compact-selectable");
    const reviewFrame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent turn review"]');
    expect(reviewFrame).not.toBeNull();
    expect(reviewFrame!.src).toContain("threadId=thread-1");
    expect(reviewFrame!.src).toContain("turnId=turn-9");

    // Tabbing back to the working tree drops the pinned turn.
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Agent turn" })).not.toBeInTheDocument());
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
  });

  it.each(["undo", "undo in manual mode", "same-count edit"])("rebuilds after an Agent %s", async (change) => {
    if (change === "undo in manual mode") setAutoBuildMode("manual");
    renderApp({
      ...projectCommands(), stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      build_project: buildResult({ durationMs: 5, rootDocument: "main.tex" }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame();
    const entry = agentCheckpoint("undo", { additions: 2, deletions: 2 });
    postProjectHistory(frame, entry.threadId, [entry]);
    const builds = () => invokeCalls("build_project").length;
    const baseline = builds();
    postProjectHistory(frame, entry.threadId, change.startsWith("undo") ? [] : [{ ...entry, timestamp: "2026-08-07T10:01:00.000Z" }]);
    await waitFor(() => expect(builds()).toBe(baseline + 1), { timeout: 4_000 });
  });

  it("rebuilds after fresh agent checkpoints but not for replayed history", async () => {
    const tutorialSnapshot = projectSnapshot({ root: "/tmp/tutorial-paper", projectId: "tutorial-id", name: "Tutorial paper" });
    const built = buildResult({ durationMs: 5, rootDocument: "/private/outside/main.tex" })();
    let nextBuildHasPdf = false;
    // Held operations wait on their deferred until the test settles it.
    let heldBuild: Deferred | undefined;
    let heldPdfRead: Deferred | undefined;
    const holdNextBuild = () => (heldBuild = deferred());
    const buildCalls = () => invokeCalls("build_project").length;
    const tutorialBuilds = () => invokeCalls(
      "build_project", (args) => (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root,
    );
    // One checkpoint whose intro.tex work grows by `additions` lines.
    const postCheckpoint = (frame: HTMLIFrameElement, additions: number, deletions = 2) => {
      postProjectHistory(frame, "thread-1", [agentCheckpoint("1", { additions, deletions })]);
    };

    const view = renderApp({
      ...projectCommands(), open_tutorial_project: tutorialSnapshot,
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      build_project: async () => {
        const result = nextBuildHasPdf ? { ...built, hasPdf: true } : built;
        nextBuildHasPdf = false;
        const hold = heldBuild;
        heldBuild = undefined;
        if (hold) await hold.promise;
        return result;
      },
      read_compiled_pdf: async () => {
        const hold = heldPdfRead;
        heldPdfRead = undefined;
        if (!hold) return mockAppCommand("read_compiled_pdf");
        await hold.promise;
        return new ArrayBuffer(8);
      },
    });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame, postMessage } = await openAgentFrame();

    // The first snapshot for a thread replays its existing history; it must
    // prime the fingerprints without scheduling a rebuild.
    postCheckpoint(frame, 1, 0);
    const baseline = buildCalls();
    await pause(2_200);
    expect(buildCalls()).toBe(baseline);

    // The same checkpoint growing new file work is fresh agent editing.
    postCheckpoint(frame, 5);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 1), { timeout: 4_000 });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "lattice:agent-compile-result", version: 1, threadId: "thread-1", turnId: "turn-1", checkpointRef: "ref-1",
      success: true, durationMs: 5, rootDocument: null, diagnostics: { errors: 0, warnings: 0 },
    }), synaraHook.runtime.origin));
    const agentCompileRelays = () => postedOfType(postMessage, "lattice:agent-compile-result").length;
    const relaysAfterFirstCheckpoint = agentCompileRelays();
    const clickBuild = () => fireEvent.click(screen.getByRole("button", { name: "Build" }));
    // Starts a manual build that stays in flight until the returned hold is settled, waits until `started`, then
    // lets fresh checkpoint work (`additions` lines) arrive in `checkpointFrame` behind it.
    const checkpointBehindHeldBuild = async (started: () => void, checkpointFrame: HTMLIFrameElement, additions: number) => {
      const held = holdNextBuild();
      clickBuild();
      await waitFor(started);
      postCheckpoint(checkpointFrame, additions);
      await pause(1_800);
      return held;
    };

    // A manual build during the checkpoint debounce must not consume its
    // association. The dedicated automatic pass still runs and owns the relay.
    postCheckpoint(frame, 9);
    clickBuild();
    await waitFor(() => expect(buildCalls()).toBe(baseline + 2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Build" })).toBeEnabled());
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 3), { timeout: 4_000 });
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1));

    // A checkpoint that arrives during an in-flight manual build queues its
    // own pass; it must not be credited to the older output.
    let held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 4), frame, 13);
    expect(buildCalls()).toBe(baseline + 4);
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1);
    held.resolve();
    await waitFor(() => expect(buildCalls()).toBe(baseline + 5));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 2));

    // A rejected backend build used to skip the loop condition and strand the
    // checkpoint pass forever. The queued owner must still run and relay.
    held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 6), frame, 15);
    held.reject(new Error("build rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 7));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 3));

    // Reading a newly compiled PDF can reject independently of compilation.
    // That failure must not prevent a checkpoint queued during the read.
    nextBuildHasPdf = true;
    const pdfRead = heldPdfRead = deferred();
    clickBuild();
    // The read has started once it takes the hold.
    await waitFor(() => expect(heldPdfRead).toBeUndefined());
    postCheckpoint(frame, 16);
    await pause(1_800);
    pdfRead.reject(new Error("PDF read rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 9));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 4));

    // Queued work and its associations belong to an immutable project scope. Switching while the old manual build
    // is in flight must cancel the queued checkpoint instead of compiling the incoming project under the old turn.
    held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 10), frame, 17);
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    held.resolve();
    await waitFor(() => expect(tutorialBuilds()).toHaveLength(1));
    await pause(2_000);
    expect(tutorialBuilds()).toHaveLength(1);

    const tutorialFrame = await findFrame();
    postCheckpoint(tutorialFrame, 10);
    await pause(2_000);
    expect(tutorialBuilds()).toHaveLength(1);

    // Unmount is another ownership boundary: resolving an old build afterward
    // must not launch its queued checkpoint pass against a dead window.
    held = await checkpointBehindHeldBuild(() => expect(tutorialBuilds()).toHaveLength(2), tutorialFrame, 14);
    view.unmount();
    held.resolve();
    await pause(100);
    expect(tutorialBuilds()).toHaveLength(2);
  }, 90_000);

  it("opens a project switcher with recent and folder actions", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    expect(screen.queryByText(ROOT)).not.toBeInTheDocument();
    expect(document.querySelector(".titlebar-navigator")).not.toHaveAttribute("style");
    fireEvent.mouseDown(document.querySelector(".titlebar-drag-area")!, { button: 0, buttons: 1 });
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });

    expect(await screen.findByText("Recent projects")).toBeInTheDocument();
    const projectMenu = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(projectMenu).toHaveClass("w-52");
    expect(projectMenu).toHaveAttribute("data-align", "center");
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Light" })).not.toBeInTheDocument();
    for (const name of ["Settings", "Guided tutorial", /open another folder/i, /new project/i]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("separator", { name: "Resize workspace sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize writing agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize Project and Papers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add file or folder" })).not.toBeInTheDocument();
    expect(document.querySelector(".source-editor > .code-editor-root")).toBeInTheDocument();
    const titlebar = document.querySelector(".titlebar")!;
    const titlebarMain = titlebar.querySelector(".titlebar-main")!;
    const canvasPanel = document.querySelector(".canvas-panel")!;
    const titlebarTabs = titlebar.querySelector(".editor-tabs")!;
    const titlebarTools = titlebar.querySelector(".canvas-toolbar")!;
    expect(titlebar.querySelector(".titlebar-sidebar")).toHaveStyle({ width: "321px" });
    expect(titlebarTabs).toBeInTheDocument();
    expect(titlebarTools).toBeInTheDocument();
    expect([...titlebarMain.children].indexOf(titlebarTabs)).toBeLessThan([...titlebarMain.children].indexOf(titlebarTools));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Project history" }));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Git status and commit" }));
    expect(canvasPanel.querySelector(".editor-tabs")).not.toBeInTheDocument();
    expect(canvasPanel.querySelector(".canvas-toolbar")).not.toBeInTheDocument();
    await switchSidebarMode("Agent");
    expect(document.querySelector('iframe[title="Agent"]')).toHaveAttribute("src", expect.stringContaining("127.0.0.1:4173"));
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
  });

  it.each(["fullscreen", "a browser tab"])("moves the navigator control to the left edge in %s", async (host) => {
    if (host === "fullscreen") windowApi.isFullscreen.mockResolvedValue(true);
    else browserRuntime.hosted = true;
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    await screen.findByRole("button", { name: "Hide sidebar" });
    const shell = () => expect(document.querySelector(".app-shell"));
    if (host === "fullscreen") {
      await waitFor(() => shell().toHaveClass("fullscreen"));
    } else {
      shell().toHaveClass("browser-hosted");
      expect(invoke).not.toHaveBeenCalledWith("align_traffic_lights", expect.anything());
    }
  });

  it("toggles fullscreen when double-clicking the titlebar drag area", async () => {
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.doubleClick(document.querySelector(".titlebar-drag-area")!);
    await waitFor(() => expect(windowApi.setFullscreen).toHaveBeenCalledWith(true));
  });

  it("resizes panels with the accessible divider controls", async () => {
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    const divider = await screen.findByRole("separator", { name: "Resize workspace sidebar" });
    const dragDivider = (from: number, to: number, finish = () => fireEvent.pointerUp(window)) => {
      fireEvent.pointerDown(divider, { clientX: from });
      fireEvent.pointerMove(window, { clientX: to });
      finish();
    };
    const titlebarSidebar = () => document.querySelector(".titlebar-sidebar");
    expect(divider).toHaveAttribute("aria-valuenow", "320");
    expect(document.querySelector<HTMLElement>(".workspace")?.style.gridTemplateAreas).toContain("sidebar sidebar-resizer canvas");
    expect(screen.queryByRole("separator", { name: "Resize writing agent" })).not.toBeInTheDocument();
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "336");
    expect(titlebarSidebar()).toHaveStyle({ width: "337px" });

    dragDivider(336, 400);
    expect(divider).toHaveAttribute("aria-valuenow", "400");
    expect(titlebarSidebar()).toHaveStyle({ width: "401px" });

    dragDivider(400, 440, () => fireEvent.pointerCancel(window));
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    expect(document.body).not.toHaveClass("resizing-panels");

    dragDivider(440, 400, () => fireEvent.blur(window));
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(divider).toHaveAttribute("aria-valuenow", "384");
    expect(document.body).not.toHaveClass("resizing-panels");

    dragDivider(400, 700);
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    expect(titlebarSidebar()).toHaveStyle({ width: "425px" });

    await switchSidebarMode("Papers");
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    await switchSidebarMode("Agent");
    expect(divider).toHaveAttribute("aria-valuenow", "424");

    // This test can run alone with a cold lazy canvas; sidebar controls mount
    // before its editor modules finish loading.
    const splitDivider = await screen.findByRole("separator", { name: "Resize editor and PDF preview" }, { timeout: 15_000 });
    expect(splitDivider.closest(".split-canvas")).toHaveAttribute("data-minimum-workspace-width", "901");
    await waitFor(() => expect(windowApi.setMinSize).toHaveBeenCalledWith(expect.objectContaining({ width: 1222, height: 680 })));
    expect(splitDivider).toHaveAttribute("aria-valuenow", "46");
    fireEvent.keyDown(splitDivider, { key: "ArrowRight" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");

    const splitCanvas = splitDivider.closest<HTMLElement>(".split-canvas")!;
    stubRect(splitCanvas, 0, 0, 1201, 800);
    fireEvent.pointerDown(splitDivider, { clientX: 588 });
    fireEvent.pointerMove(window, { clientX: 600.4 });
    expect(splitCanvas.style.gridTemplateColumns).toBe("600px 1px minmax(500px, 1fr)");
    // The live drag stays out of React so the PDF toolbar is not re-rendered
    // for every pointer event; the accessible value commits on pointer-up.
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");
    fireEvent.pointerUp(window);
    expect(splitDivider).toHaveAttribute("aria-valuenow", "50");
  });

  it("resizes the loaded Agent below the bootstrap sidebar minimum", async () => {
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    const divider = await screen.findByRole("separator", { name: "Resize workspace sidebar" });
    const { frame: agentFrame } = await openAgentFrame();
    const reportMinimum = (minimumSidebarWidth: number) => postWindowMessage(
      agentFrame.contentWindow, { type: "synara:layout-metrics", minimumSidebarWidth },
    );
    // Once the real controls load, their measured width replaces the bootstrap
    // limit, including updates that arrive while the pointer is still down.
    reportMinimum(280);
    fireEvent.pointerDown(divider, { clientX: 320 });
    fireEvent.pointerMove(window, { clientX: 250 });
    expect(divider).toHaveAttribute("aria-valuenow", "280");
    const workspaceColumns = document.querySelector<HTMLElement>(".workspace")!.style.gridTemplateColumns;
    reportMinimum(240);
    // A layout report must not restore the saved 320px content width behind
    // the still-dragging column, nor reload the embedded assistant.
    expect(divider).toHaveAttribute("aria-valuenow", "280");
    expect(document.querySelector(".workspace-sidebar-content")).toHaveStyle({ width: "280px" });
    expect(document.querySelector<HTMLElement>(".workspace")!.style.gridTemplateColumns).toBe(workspaceColumns);
    expect(document.querySelector('iframe[title="Agent"]')).toBe(agentFrame);
    fireEvent.pointerMove(window, { clientX: 220 });
    expect(divider).toHaveAttribute("aria-valuenow", "240");
    fireEvent.pointerUp(window);
    expect(divider).toHaveAttribute("aria-valuenow", "240");

    // A click closes the column, but keeps the live assistant document mounted.
    fireEvent.pointerDown(divider, { clientX: 240 });
    fireEvent.pointerUp(window);
    expect(screen.queryByRole("separator", { name: "Resize workspace sidebar" })).toBeNull();
    expect(document.querySelector('iframe[title="Agent"]')).toBe(agentFrame);
    expect(agentFrame.closest(".agent-panel-surface")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.getByRole("separator", { name: "Resize workspace sidebar" })).toBe(divider);
    expect(divider).toHaveAttribute("aria-valuenow", "240");
    expect(document.querySelector('iframe[title="Agent"]')).toBe(agentFrame);
    // This scenario never opens an editor, but project startup still prewarms
    // it. Let that import finish before an isolated test tears down its runner.
    await vi.dynamicImportSettled();
  });

  it("automatically refreshes the project tree when files appear on disk", async () => {
    const snapshot = projectSnapshot();
    renderApp({ ...projectCommands(snapshot), refresh_project: { ...snapshot, files: [...snapshot.files, fileNode("notes.md")] } });
    expect(queryProjectTreeItem("notes.md")).toBeNull();
    expect(await findProjectTreeItem("notes.md", 3500)).toBeInTheDocument();
  });

  it("uses Pierre's default density, flattened folders, and Git decorations", async () => {
    localStorage.setItem("lattice:show-hidden-files", "true");
    localStorage.setItem("lattice:expanded-directories:/tmp/lattice-paper", JSON.stringify(["chapters", "chapters/method"]));
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("chapters/method/main.tex", "Main paper"),
      files: [
        dirNode("chapters", [dirNode("chapters/method", [fileNode("chapters/method/main.tex")])]),
        fileNode("component.tsx", "text"), fileNode("references.bib", "text"),
        ...fileNodes("paper.pdf", "conference.sty", "plain.bst", "figure.eps"),
      ],
    });
    renderApp({
      ...refreshableProject(snapshot), list_project_tree_with_hidden: () => snapshot.files,
      git_status: () => ({
        available: true, repository: true, branch: "main",
        files: [{ path: "chapters/method/main.tex", status: "modified", staged: false, unstaged: true }],
      }),
    });
    const file = await findProjectTreeItem("chapters/method/main.tex");
    await waitFor(() => expect(file).toHaveAttribute("data-item-git-status", "modified"));

    const host = document.querySelector<HTMLElement>("file-tree-container.lattice-file-tree");
    expect(host?.style.getPropertyValue("--trees-item-height")).toBe("32px");
    expect(host).toHaveAttribute("data-file-tree-virtualized", "true");
    expect((await findProjectTreeItem("component.tsx")).querySelector("[data-icon-token='react']")).not.toBeNull();
    for (const [path, icon] of [
      ["chapters/method/main.tex", "lattice-material-tex"], ["references.bib", "lattice-material-bibliography"],
      ["paper.pdf", "lattice-material-pdf"], ["conference.sty", "lattice-material-tex-style"],
      ["plain.bst", "lattice-material-bibtex-style"], ["figure.eps", "file-tree-builtin-image"],
    ]) expect((await findProjectTreeItem(path)).querySelector("use")).toHaveAttribute("href", `#${icon}`);
    const folderRows = projectTreeRoot()?.querySelectorAll("[data-item-type='folder']");
    expect(new Set(Array.from(folderRows ?? [], (row) => (row as HTMLElement).dataset.itemPath))).toEqual(new Set(["chapters/method/"]));
    for (const trigger of projectTreeRoot()?.querySelectorAll("[data-type='context-menu-trigger']") ?? []) {
      expect(trigger).toHaveAttribute("data-visible", "false");
    }
  });

  it.each(["source pane", "outside input"])("saves pending visual Markdown when focus moves to %s in manual build mode", async (destination) => {
    setAutoBuildMode("manual");
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", secondaryFile: "", canvasMode: "split" });
    await loadVisualMarkdownEditorModule();
    const snapshot = projectSnapshot({ files: [fileNode("notes.md")] });
    renderApp({ ...refreshableProject(snapshot, "Original paragraph.\n"), write_project_file: undefined });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" }, { timeout: 15_000 });
    const editor = visualEditorOf(surface);
    const outsideInput = document.createElement("input");
    document.body.append(outsideInput);
    try {
      act(() => { surface.focus(); });
      vi.mocked(invoke).mockClear();
      act(() => {
        editor.commands.insertContentAt(1, "Latest edit. ");
        (destination === "source pane" ? document.querySelector<HTMLElement>(".cm-content")! : outsideInput).focus();
      });
      // Focus loss must persist the latest transaction, without waiting for
      // either the visual publisher's debounce or the app's idle autosave.
      expect(invoke).toHaveBeenCalledWith("write_project_file", {
        path: "notes.md", content: "Latest edit. Original paragraph.\n", baseContent: "Original paragraph.\n", projectRoot: ROOT,
      });
      expect(invoke).not.toHaveBeenCalledWith("build_project", expect.anything());
    } finally {
      outsideInput.remove();
    }
  });

  it.each([
    ["source blur", "manual"], ["preview blur", "manual"], ["idle", "manual"],
    ["source blur", "automatic"], ["preview blur", "automatic"], ["idle", "automatic"],
  ])("saves non-collaborative secondary Markdown on %s in %s mode", async (trigger, autoBuildMode) => {
    setAutoBuildMode(autoBuildMode as "manual" | "automatic");
    persistLayout(ROOT, {
      openTabs: ["left.md", "right.md"], activeFile: "left.md", secondaryFile: "right.md", focusedPane: "secondary", canvasMode: "dual",
    });
    await loadVisualMarkdownEditorModule();
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("left.md", "right.md") })), write_project_file: undefined,
      read_project_file: readFiles({ "left.md": "Left unchanged.\n" }, "Right original.\n"),
    });
    const source = await waitFor(() => {
      const element = paneContent("secondary");
      expect(element).toHaveTextContent("Right original.");
      return element!;
    });
    act(() => { source.focus(); });
    let surface = source;
    if (trigger === "preview blur") {
      selectDocumentView("Preview");
      surface = await screen.findByRole("textbox", { name: "Markdown document editor" }, { timeout: 15_000 });
      act(() => { surface.focus(); });
    }
    vi.mocked(invoke).mockClear();
    act(() => {
      if (trigger === "preview blur") {
        visualEditorOf(surface).commands.insertContentAt(1, "New right. ");
      } else {
        EditorView.findFromDOM(source)!.dispatch({ changes: { from: 0, insert: "New right. " } });
      }
      if (trigger !== "idle") paneContent("primary")!.focus();
    });
    const expectSaved = () => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "right.md", content: "New right. Right original.\n", baseContent: "Right original.\n", projectRoot: ROOT,
    });
    if (trigger === "idle") await waitFor(expectSaved);
    else expectSaved();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.objectContaining({ path: "left.md" }));
    if (autoBuildMode === "automatic") {
      await expectInvoked("build_project", expect.objectContaining({ projectRoot: ROOT, force: false }));
    } else {
      expect(invoke).not.toHaveBeenCalledWith("build_project", expect.anything());
    }
  });

  it.each(["editor leave", "PDF pointer down", "PDF focus"])("saves and builds changed source on %s", async (trigger) => {
    await openWithAutomaticBuilds({ write_project_file: undefined });
    const view = await findEditorView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nNew result." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    if (trigger === "editor leave") fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    else if (trigger === "PDF pointer down") fireEvent.pointerDown(document.querySelector(".pdf-column")!);
    else fireEvent.focus(document.querySelector(".pdf-column")!);
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nNew result.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    });
    // The open file rides along so the backend can re-target the build on it
    // when it is a compilable root (Overleaf's rule).
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT, documentPath: "main.tex" }));
  });

  it.each(["build", "save"])("saves and queues the latest edit while an automatic %s is in flight", async (heldOperation) => {
    setAutoBuildMode("automatic");
    let releaseBuild: (() => void) | undefined;
    let holdBuild = false;
    let releaseSave: (() => void) | undefined;
    let holdSave = false;
    const builtSources: string[] = [];
    let diskSource = "\\documentclass{article}";
    renderApp({
      ...refreshableProject(projectSnapshot({ files: [] })), read_project_file: () => diskSource,
      write_project_file: async (args) => {
        if (holdSave) {
          holdSave = false;
          await new Promise<void>((resolve) => { releaseSave = resolve; });
        }
        diskSource = (args as { content: string }).content;
      },
      build_project: async () => {
        builtSources.push(diskSource);
        if (holdBuild) {
          holdBuild = false;
          await new Promise<void>((resolve) => { releaseBuild = resolve; });
        }
        return buildResult()();
      },
    });
    const view = await findEditorView();
    const type = (text: string) => {
      act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); });
      fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    };
    await waitFor(() => expect(builtSources).toHaveLength(1));
    holdBuild = heldOperation === "build";
    holdSave = heldOperation === "save";
    type("\nFirst edit.");
    await waitFor(() => expect(heldOperation === "build" ? releaseBuild : releaseSave).toBeDefined());
    try {
      type("\nSecond edit.");
      await act(async () => { releaseSave?.(); });
      await waitFor(() => expect(diskSource).toBe("\\documentclass{article}\nFirst edit.\nSecond edit."));
    } finally {
      await act(async () => { releaseSave?.(); releaseBuild?.(); });
    }
    await waitFor(() => expect(builtSources).toEqual([
      "\\documentclass{article}", "\\documentclass{article}\nFirst edit.", "\\documentclass{article}\nFirst edit.\nSecond edit.",
    ]));
  });

  it("automatically builds after 1.2 seconds without editing", async () => {
    await openWithAutomaticBuilds({ write_project_file: undefined });
    const view = await findEditorView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nIdle build." } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nIdle build.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    }), { timeout: 2_500 });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it.each(["completion selection", "PDF pointer down", "PDF wheel"])("resumes autosave after citation completion on %s", async (trigger) => {
    await openWithAutomaticBuilds({
      list_citation_keys: () => ["dosovitskiy2021image", "vaswani2017attention"], write_project_file: undefined,
    }, projectSnapshot());
    const view = await waitFor(() => editorViewAt(), { timeout: 60_000 });

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    for (const character of "\nSee \\cite") {
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: character },
        selection: { anchor: range.from + character.length },
        annotations: Transaction.userEvent.of("input.type"),
      });
    }
    const openingBrace = new KeyboardEvent("keydown", { key: "{", code: "BracketLeft", shiftKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(openingBrace);
    if (!openingBrace.defaultPrevented) {
      const transaction = insertBracket(view.state, "{");
      if (transaction) view.dispatch(transaction);
    }
    expect(view.state.doc.toString()).toContain("\\cite{}");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    await act(() => pause(1_400));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "build_project")).toBe(false);

    if (trigger !== "completion selection") {
      const pdf = document.querySelector(".pdf-column")!;
      if (trigger === "PDF pointer down") fireEvent.pointerDown(pdf);
      else fireEvent.wheel(pdf, { deltaY: 120 });
      await expectInvoked("write_project_file", {
        path: "main.tex", content: "\\documentclass{article}\nSee \\cite{}", baseContent: "\\documentclass{article}", projectRoot: ROOT,
      });
      expect(completionStatus(view.state)).toBeNull();
      return;
    }

    expect(selectedCompletionIndex(view.state)).toBe(0);
    fireEvent.keyDown(view.contentDOM, { key: "ArrowDown", code: "ArrowDown" });
    expect(selectedCompletionIndex(view.state)).toBe(1);
    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
    expect(view.state.doc.toString()).toContain("\\cite{vaswani2017attention}");
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT })), { timeout: 2_500 });
  }, 90_000);

  it("syncs an agent's unopened chapter without requiring an automatic build or remote change", async () => {
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-agent-sync", projectId: "agent-sync", name: "Agent sync", rootDocuments: MAIN_DOCUMENT,
    });
    renderOverleafPaper({
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      overleaf_link: () => overleafLink({ projectId: "ol-agent-sync", projectName: "Agent sync", lastSync: undefined }),
      overleaf_status: () => overleafStatus({ email: undefined, name: undefined }),
      overleaf_probe: () => overleafProbe({ lastSync: undefined }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", rootFolderId: undefined, docs: [{ id: "main", path: "main.tex" }], userId: "me",
      }),
      overleaf_rt_join_doc: () => ({
        text: "\\documentclass{article}", version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
      }),
      overleaf_sync: () => overleafSyncResult({ pushed: ["sections/results.tex"] }),
    }, { snapshot, syncMode: "live" });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame();
    postProjectHistory(frame, "agent-sync", []);
    const syncCalls = () => invokeCalls("overleaf_sync");
    expect(syncCalls()).toHaveLength(0);
    postProjectHistory(frame, "agent-sync", [agentCheckpoint("sync", { path: "sections/results.tex", additions: 3, deletions: 1 }, {
      label: "Edited chapter", timestamp: "2026-09-24T01:00:00.000Z", threadId: "agent-sync", threadTitle: "Edit",
      checkpointRef: "refs/lattice/checkpoints/test",
    })]);
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 6_000 });
    expect(syncCalls()[0][1]).toMatchObject({ projectRoot: snapshot.root });
    expect((syncCalls()[0][1] as { live: string[] }).live).not.toContain("sections/results.tex");
  });

  it("uploads a reference-check update right away and a resolved bibliography conflict after saving", async () => {
    // The Papers path behind the reported conflict: an update written straight
    // to references.bib used to wait, unsynced, for some later save. Here the
    // first sync it schedules meets an Overleaf edit, and the resolver's choice
    // must be what lands on disk and what the following sync uploads.
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-bib-sync", projectId: "bib-sync", name: "Bib sync", rootDocuments: MAIN_DOCUMENT,
      files: fileNodes("main.tex", "references.bib"),
    });
    const source = "\\documentclass{article}";
    const before = "@misc{doe2020,\n  title = {A Study},\n  year = {2020},\n}";
    const after = "@article{doe2020,\n  title = {A Study},\n  journal = {Journal},\n  year = {2020},\n}";
    let bib = `${before}\n`;
    const conflicted = `<<<<<<< ours\n${after}\n||||||| original\n${before}\n=======\n>>>>>>> theirs\n`;
    let syncs = 0;
    renderOverleafPaper({
      read_project_file: (args) => (argPath(args) === "references.bib" ? bib : source),
      stat_project_file: { exists: true, mtimeMs: 1 },
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        if (path === "references.bib") bib = content;
        return { content, hadConflicts: false };
      },
      overleaf_link: () => overleafLink({ projectId: "ol-bib-sync", projectName: "Bib sync" }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", userId: "me", docs: [{ id: "main", path: "main.tex" }, { id: "bib", path: "references.bib" }],
      }),
      overleaf_rt_join_doc: { text: source, version: 4, comments: [], changes: [], caughtUp: [], resumed: false },
      bibliography_audit_scan: () => ({
        entries: [{ path: "references.bib", key: "doe2020", title: "A Study", bibtex: bib.trim(), issues: [] }], issues: [],
      }),
      bibliography_audit_report_load: [["references.bib\0doe2020", {
        snapshot: before, applied: false,
        result: {
          status: "update", message: "A published version is available.", before, after,
          checkedAt: "2026-09-26T10:07:00.000Z", changes: [{ field: "journal", before: "", after: "Journal" }],
        },
      }]],
      bibliography_audit_report_save: null,
      bibliography_audit_apply: () => {
        bib = `${after}\n`;
        return null;
      },
      overleaf_sync: () => {
        syncs += 1;
        if (syncs > 1) return overleafSyncResult({ pushed: ["references.bib"] });
        // Overleaf changed the same entry in the meantime.
        bib = conflicted;
        return overleafSyncResult({
          conflicts: [{ path: "references.bib", localCopy: "references (local conflict 20260926-1808).bib", markers: true }],
        });
      },
      list_todos: () => [],
    }, { snapshot, syncMode: "live" });
    await screen.findByRole("button", { name: "Switch project" });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: "Check references" }));
    const syncCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_sync");
    // The drawer is a lazy chunk; a cold, busy test runner can take a while.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_scan", { projectRoot: snapshot.root }), { timeout: 60_000 });
    const apply = await screen.findByRole("button", { name: "Apply this update" }, { timeout: 20_000 });
    expect(syncCalls()).toHaveLength(0);
    fireEvent.click(apply);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_apply", expect.objectContaining({
      path: "references.bib", key: "doe2020", before, after,
    })));
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 6_000 });
    expect((syncCalls()[0][1] as { live: string[] }).live).not.toContain("references.bib");

    const dialog = await screen.findByRole("dialog", { name: "Resolve conflicts in references.bib" }, { timeout: 60_000 });
    expect(await within(dialog).findByRole("region", { name: "Overleaf" }, { timeout: 10_000 }))
      .toHaveTextContent("Overleaf removed this part.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Keep this computer's version" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save resolved file" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "references.bib", content: `${after}\n`, projectRoot: snapshot.root,
    }));
    // Queued like any disk edit, so it respects the live channel's sync gap.
    await waitFor(() => expect(syncCalls()).toHaveLength(2), { timeout: 40_000 });
    expect(bib).toBe(`${after}\n`);
  }, 240_000);

  it("automatically rebuilds after the active source changes on disk", async () => {
    let source = "\\documentclass{article}";
    let mtimeMs = 1;
    await openWithAutomaticBuilds({ read_project_file: () => source, stat_project_file: () => ({ exists: true, mtimeMs }) });
    source = "\\documentclass{article}\nExternal edit.";
    mtimeMs = 2;
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT })), { timeout: 3_500 });
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it("does not mistake a disk read started before autosave for a new external edit", async () => {
    const original = "\\documentclass{article}";
    let disk = original;
    let mtimeMs = 1;
    let holdRead = false;
    let finishRead: (() => void) | undefined;
    await openWithAutomaticBuilds({
      read_project_file: () => {
        if (!holdRead) return disk;
        holdRead = false;
        const captured = disk;
        return new Promise<string>((resolve) => { finishRead = () => resolve(captured); });
      },
      stat_project_file: () => ({ exists: true, mtimeMs }),
      write_project_file: (args) => {
        disk = (args as { content: string }).content;
        mtimeMs += 1;
        return { content: disk, hadConflicts: false };
      },
    });
    const view = await expectEditorText(original);
    holdRead = true;
    mtimeMs += 1;
    await waitFor(() => expect(finishRead).toBeTypeOf("function"), { timeout: 3_500 });
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n我的新修改" } }));
    const expected = `${original}\n我的新修改`;
    await waitFor(() => expect(disk).toBe(expected), { timeout: 2_500 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Build" })).toBeEnabled());
    await act(async () => {
      finishRead!();
      await pause(300);
    });
    expect(view.state.doc.toString()).toBe(expected);
    expect(disk).toBe(expected);
  });

  it("accepts an agent edit in an open Markdown preview and still switches files", async () => {
    persistLayout(ROOT, { openTabs: ["methods.md", "notes.md"], activeFile: "methods.md", secondaryFile: "", canvasMode: "pdf" });
    const sources: Record<string, string> = { "methods.md": "## Scope\n- **Measures**: Initial result\n", "notes.md": "# Notes" };
    let mtimeMs = 1;
    renderApp({
      ...refreshableProject(projectSnapshot({
        rootDocuments: rootDocument("methods.md", "Methods"), files: fileNodes("methods.md", "notes.md"),
      })),
      read_project_file: readFiles(sources, ""), stat_project_file: () => ({ exists: true, mtimeMs }), write_project_file: undefined,
    });
    const visualEditor = () => screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(visualEditor()).toHaveTextContent("Initial result"));
    sources["methods.md"] = "## Scope\n- **Measures**: Agent revision\n";
    mtimeMs = 2;
    await waitFor(() => expect(visualEditor()).toHaveTextContent("Agent revision"), { timeout: 4_000 });
    expect(screen.queryByText("This document changed in the same place")).not.toBeInTheDocument();
    await openTreeFile("notes.md");
  });

  it("preserves an external Markdown blank-line edit through the next save and poll", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    let source = "# Notes\nParagraph\n";
    let mtimeMs = 1;

    await Promise.all([loadTextLanguageExtensions("notes.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(markdownSnapshot()), read_project_file: () => source, stat_project_file: () => ({ exists: true, mtimeMs }),
      write_project_file: (args) => {
        source = (args as { content: string }).content;
        mtimeMs += 1;
      },
    });
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Split");
    const view = await expectEditorText(source, ".source-editor .cm-editor", { timeout: 10_000 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stat_project_file", { path: "notes.md" }), { timeout: 3_500 });

    const externalSource = "# Notes\n\nParagraph\n";
    source = externalSource;
    mtimeMs = 2;
    await waitFor(() => expect(view.state.doc.toString()).toBe(externalSource), { timeout: 3_500 });
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    const statCallsAfterExternalEdit = invokeCalls("stat_project_file").length;
    await waitFor(() => expect(invokeCalls("stat_project_file").length).toBeGreaterThan(statCallsAfterExternalEdit), { timeout: 3_500 });
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
    expect(source).toBe(externalSource);
    expect(view.state.doc.toString()).toBe(externalSource);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "More.\n" } }));
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({
      path: "notes.md", content: `${externalSource}More.\n`,
    })), { timeout: 3_500 });
    expect(source).toBe(`${externalSource}More.\n`);
  }, 60_000);

  it("lists a work that is only cited but does not offer to open it", async () => {
    const paperFetch = deferred<unknown>();
    renderApp({
      // Importing refreshes the project afterwards.
      ...refreshableProject(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        attentionPaper(),
        // Added through bibcite: in the bibliography, never fetched.
        { arxivId: "1412.6980", title: "Adam: A Method for Stochastic Optimization", citationKey: "kingma2015adam", hasFullText: false },
        // A book: cited, but there is no preprint to fetch.
        { arxivId: "", title: "The TeXbook", citationKey: "knuth1984texbook", hasFullText: false },
      ],
      fetch_paper: paperFetch.promise,
    });
    // Let the lazy workspace finish mounting before switching its sidebar.
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
    await switchSidebarMode("Papers");
    const papers = within(await screen.findByRole("list", { name: "Papers" }));
    // Its preprint is known, so the row offers to fetch rather than going dead.
    const citedOnly = await papers.findByTitle("Download arXiv 1412.6980");
    expect(citedOnly).toBeEnabled();
    expect(citedOnly.closest(".paper-row")).toHaveClass("cited-only");
    expect(citedOnly).toHaveTextContent("arXiv 1412.6980");

    // A work with no preprint has nothing to fetch, so it stays inert.
    expect(papers.getByTitle(/The TeXbook.*no local reading available/)).toBeDisabled();

    // The fetched one still opens in the reader.
    expect(papers.getByTitle("Attention Is All You Need")).toBeEnabled();

    fireEvent.click(citedOnly);
    await expectInvoked("fetch_paper", { arxivId: "1412.6980" });
    const input = screen.getByRole("searchbox", { name: "Search or import papers" });
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".paper-import-track")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => {
      paperFetch.resolve({ paperPath: ".research/papers/1412.6980/paper.md", arxivId: "1412.6980", reused: false });
    });
    await waitFor(() => expect(input).toHaveAttribute("aria-busy", "false"));
    expect(document.querySelector(".paper-import-track")).toBeNull();
  }, 60_000);

  it("warns about DOI-exact citation updates and opens the Crossref notice", async () => {
    const work = { arxivId: "", hasFullText: false, hasBlog: false };
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{
        ...work, doi: "10.1234/example", title: "A historically important result", citationKey: "example2020",
        citationHealth: {
          kind: "retracted", updateType: "retraction", source: "retraction-watch", date: "2023-09-17",
          link: "https://doi.org/10.5555/retraction-notice", checkedAt: "2026-08-13T12:00:00Z",
        },
      }, {
        ...work, doi: "10.1234/no-updates", title: "No registered update", citationKey: "current2024",
        citationHealth: { kind: "unknown", source: "crossref", checkedAt: "2026-08-13T12:00:00Z" },
      }],
    });
    await switchSidebarMode("Papers");
    expect(await screen.findByRole("status")).toHaveTextContent("Retracted · Retraction Watch · 2023-09-17");
    expect(screen.queryByText(/No Crossref update metadata found/, { selector: ".paper-citation-health" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retracted · Retraction Watch · 2023-09-17. Open notice" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://doi.org/10.5555/retraction-notice"));
  });

  it("filters the current Papers library by metadata without starting an import", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", citationKey: "vaswani2017attention", hasBlog: false }),
        {
          arxivId: "1412.6980", title: "Adam: A Method for Stochastic Optimization", authors: "Diederik P. Kingma and Jimmy Ba",
          citationKey: "kingma2015adam", hasFullText: true, hasBlog: false,
        },
      ],
      search_paper_library: (args) => (args as { query?: string } | undefined)?.query === "scaled dot-product" ? [{
        kind: "paper", path: ".research/papers/1706.03762/paper.md", title: "Attention Is All You Need",
        snippet: "The scaled dot-product attention mechanism.", line: 42, arxivId: "1706.03762",
      }] : [],
    });
    await switchSidebarMode("Papers");
    const search = await screen.findByRole("searchbox", { name: "Search or import papers" });
    const list = within(await screen.findByRole("list", { name: "Papers" }));
    const [attention, adam] = ["Attention Is All You Need", "Adam: A Method for Stochastic Optimization"];

    fireEvent.change(search, { target: { value: "diederik 1412" } });
    expect(list.getByTitle(adam)).toBeInTheDocument();
    expect(list.queryByTitle(attention)).not.toBeInTheDocument();
    expect(list.getByText("1 of 2 papers")).toBeInTheDocument();

    for (const query of ["https://arxiv.org/pdf/1706.03762", "vaswani attention"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(list.getByTitle(attention)).toBeInTheDocument();
      expect(list.queryByTitle(adam)).not.toBeInTheDocument();
    }

    fireEvent.change(search, { target: { value: "scaled dot-product" } });
    await waitFor(() => {
      expect(list.getByTitle(attention)).toBeInTheDocument();
      expect(list.getByText("The scaled dot-product attention mechanism.")).toBeInTheDocument();
    });
    expect(list.queryByTitle(adam)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing paper" } });
    expect(list.getByText("No matching papers")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
  });

  it.each([false, true])("downloads the resolved title snapshot without a second search (ambiguous: %s)", async (ambiguous) => {
    const title = "An Unambiguous Research Report";
    const bibtex = "@misc{report2026, title={An Unambiguous Research Report}, author={Ada Smith}, year={2026}, eprint={2601.01234}, archivePrefix={arXiv}}";
    const draft = { key: "report2026", title, author: "Ada Smith", year: "2026", journal: "", booktitle: "", publisher: "", url: "https://arxiv.org/abs/2601.01234", doi: "", entryType: "misc", bibtex, extraFields: { eprint: "2601.01234", archivePrefix: "arXiv" } };
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-title-import", projectId: "title-import", name: "Title import", rootDocuments: [], trusted: true, files: [],
    });
    let imported = false;
    renderApp({
      ...refreshableProject(snapshot, ""),
      list_papers: () => imported
        ? [{ arxivId: "2601.01234", title, hasFullText: true, hasBlog: true, citationKey: draft.key }] : [],
      resolve_citation_query: () => ambiguous
        ? { candidates: [{ ...draft, key: "other", year: "2025", extraFields: { eprint: "2501.05678" } }, draft] }
        : draft,
      import_reference: () => {
        imported = true;
        return { arxivId: "2601.01234", title, citationKey: draft.key, alreadyImported: false, paperPath: ".research/papers/2601.01234/paper.md" };
      },
    });
    await switchSidebarMode("Papers");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search or import papers" }), { target: { value: title } });
    fireEvent.click(screen.getByTitle("Import paper"));
    if (ambiguous) {
      await screen.findByRole("region", { name: "Citation candidates" });
      expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
      fireEvent.click(screen.getAllByRole("button", { name: "Select this record" })[1]);
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    }
    await expectInvoked("import_reference", {
      input: ambiguous ? expect.stringContaining("eprint = {2601.01234}") : bibtex, requestId: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save entry" })).not.toBeInTheDocument());
    expect(invokeCalls("resolve_citation_query")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
  });

  it.each([false, true])("reviews title candidates without importing and opens DOI-only sources externally (cancel: %s)", async (cancelled) => {
    const title = "Visual object processing in optic aphasia: A case of semantic access agnosia";
    const doi = "10.1093/neucas/3.3.209-w";
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-title-review", projectId: "title-review", name: "Title review", rootDocuments: [], trusted: true, files: [],
    });
    const draft = { key: "riddoch1997visual", title, author: "Riddoch, M. J.", year: "1997", journal: "Neurocase", booktitle: "", publisher: "", url: `https://doi.org/${doi}`, doi, entryType: "article" };
    const resolution = deferred<unknown>();
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, list_history: () => [],
      list_papers: () => [{ ...draft, arxivId: "", citationKey: draft.key, hasFullText: false, hasBlog: false }],
      resolve_citation_query: () => resolution.promise, cancel_reference_import: false,
    });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Open source page — no downloadable full text found"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(draft.url));
    expect(invoke).not.toHaveBeenCalledWith("fetch_web_reference", expect.anything());
    const box = screen.getByRole("searchbox", { name: "Search or import papers" });
    fireEvent.change(box, { target: { value: title } });
    // Enter opens an existing local match; + explicitly resolves a new import.
    fireEvent.click(screen.getByTitle("Import paper"));
    await expectInvoked("resolve_citation_query", { query: title });
    if (cancelled) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const alternative = { ...draft, year: "1987", journal: "Cognitive Neuropsychology", doi: "10.1080/02643298708252038" };
    await act(async () => { resolution.resolve({ ...draft, candidates: [draft, alternative] }); });
    if (cancelled) {
      expect(screen.queryByRole("region", { name: "Citation candidates" })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByRole("region", { name: "Citation candidates" })).toHaveTextContent("Cognitive Neuropsychology");
      expect(screen.getByRole("button", { name: "Save entry" })).toBeDisabled();
    }
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
  });

  it("adds a work with no preprint through the same box, and says there is nothing to open", async () => {
    const snapshot = projectSnapshot({ rootDocuments: MAIN_DOCUMENT, trusted: true, files: [fileNode("main.tex", "file")] });
    const title = "Deep Residual Learning for Image Recognition";
    let imported = false;
    renderApp({
      ...refreshableProject(snapshot),
      list_papers: () => imported
        ? [{ arxivId: "", title, citationKey: "he2016deep", doi: "10.1109/CVPR.2016.90", hasFullText: false, hasBlog: false }] : [],
      bibliography_audit_scan: () => ({ entries: [], issues: [] }),
      // No arXiv id anywhere in the answer: bibcite resolved a DOI and wrote
      // the entry, and there is no text on disk to point at.
      import_reference: () => {
        imported = true;
        return { paperPath: "", arxivId: "", title, citationKey: "he2016deep", citationOutput: "", alreadyImported: false };
      },
    });
    await switchSidebarMode("Papers");
    const box = await screen.findByPlaceholderText("Search or add by title, arXiv ID, DOI, or URL");
    fireEvent.change(box, { target: { value: "10.1109/CVPR.2016.90" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await expectInvoked("import_reference", { input: "10.1109/CVPR.2016.90", requestId: expect.any(String) });
    // The DOI must not be mistaken for an arXiv id, and the message has to
    // admit there is nothing to open rather than imply a paper was fetched.
    await expectNotification(/Added .Deep Residual Learning.*cite it with \\cite\{he2016deep\}.*No full text to open/);
    expect(box).toHaveValue("10.1109/CVPR.2016.90");
    expect(await screen.findByText(title, { selector: ".paper-open strong" })).toBeInTheDocument();
    const checkReferences = screen.getByRole("button", { name: "Check references" });
    expect(checkReferences.closest(".sidebar-mode-actions")).toBeInTheDocument();
    expect(checkReferences.textContent).toBe("");
    fireEvent.click(checkReferences);
    await expectInvoked("bibliography_audit_scan", { projectRoot: snapshot.root });
  });

  it.each([
    [false, false, "en"], [true, false, "en"],
    [false, false, "zh-CN"], [true, false, "zh-CN"],
    [false, true, "zh-CN"], [true, true, "zh-CN"],
  ] as const)("cancels the active import with its request id (bibliography: %s, full text: %s, locale: %s)", async (committed, fullText, locale) => {
    await setInterfaceLanguage(locale);
    const snapshot = projectSnapshot({ rootDocuments: MAIN_DOCUMENT, trusted: true, files: [] });
    const importing = deferred<unknown>();
    let requestId: string | undefined;
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, list_papers: () => [], list_history: () => [],
      import_reference: (args) => {
        requestId = (args as { requestId: string }).requestId;
        return importing.promise;
      },
      cancel_reference_import: true,
    });
    fireEvent.click(await screen.findByRole("tab", { name: /^(Papers|论文)$/ }));
    const box = await screen.findByRole("searchbox", { name: /^(Search or import papers|搜索或导入论文)$/ });
    fireEvent.change(box, { target: { value: "10.1080/02643298708252038" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const cancel = await screen.findByRole("button", { name: /^(Cancel|取消)$/ });
    expect(requestId).toBeTruthy();
    fireEvent.click(cancel);
    await expectInvoked("cancel_reference_import", { requestId });
    // Do not claim cancellation finished while the backend is still stopping.
    expect(box).toHaveAttribute("readonly");
    await act(async () => importing.resolve({
      arxivId: "", title: "A new paper", paperPath: fullText ? ".research/papers/new/paper.md" : "", alreadyImported: false,
      cancelled: true, citationKey: committed ? "new2026" : undefined,
    }));
    await waitFor(() => expect(box).not.toHaveAttribute("readonly"));
    if (locale === "en") {
      await expectNotification(committed ? /remains in the bibliography.*\\cite\{new2026\}/ : /cancelled before making changes/);
    } else {
      await expectNotification(committed
        ? fullText
          ? /收到取消请求时，《A new paper》及其全文已导入完成。可使用 \\cite\{new2026\} 引用。/
          : /已取消导入。《A new paper》仍保留在参考文献中，可使用 \\cite\{new2026\} 引用；已停止获取全文。/
        : fullText
          ? /已取消论文导入，参考文献未修改；已下载的全文仍可使用。/
          : /已取消论文导入，未作任何修改。/);
    }
    expect(box).toHaveValue("10.1080/02643298708252038");
  });

  it.each(["click", "drop"])("shows imported papers by title while keeping the arXiv id via %s", async (interaction) => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: true })],
      read_paper: "---\ntitle: Attention Is All You Need\nnotes: |\n  - [ ] Hidden metadata task\n---\n\n## Abstract\n\n- [ ] Review paper",
      read_paper_blog_local: "# Attention overview\n\nA concise explanation.", write_project_file: undefined,
    });
    await switchSidebarMode("Papers");
    const paper = await screen.findByRole("button", { name: /Attention Is All You Need.*1706\.03762/i });
    expect(screen.getByRole("button", { name: "Paper lookup" })).toBeVisible();
    if (interaction === "click") fireEvent.click(paper);
    else {
      const values = new Map<string, string>();
      const dataTransfer = {
        get types() { return [...values.keys()]; },
        setData: (type: string, value: string) => { values.set(type, value); },
        getData: (type: string) => values.get(type) ?? "",
      };
      fireEvent.dragStart(paper.closest(".paper-row")!, { dataTransfer });
      expect(values.has("application/x-lattice-paper")).toBe(true);
      fireEvent.drop(document.querySelector(".titlebar-main")!, { dataTransfer });
    }
    expect(await screen.findByText("Attention Is All You Need", { selector: ".active-document span" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
    expect(invoke).toHaveBeenCalledWith("read_paper_blog_local", { arxivId: "1706.03762" });
    expect(invoke).not.toHaveBeenCalledWith("read_paper_blog", { arxivId: "1706.03762" });
    expect(document.querySelector(".paper-reader")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Attention overview" })).toBeInTheDocument();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open PDF in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762"));

    const documentView = screen.getByRole("tablist", { name: "Document view" });
    expect(within(documentView).getByRole("tab", { name: "Edit" })).toBeInTheDocument();
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    const paperContent = screen.getByRole("tablist", { name: "Paper content" });
    expect(within(paperContent).getByRole("tab", { name: "Blog" })).toHaveAttribute("aria-selected", "true");
    expect(within(paperContent).getByRole("tab", { name: "Paper" })).toBeInTheDocument();

    // Replaces the open Paper file's source, saves it, and shows the saved preview.
    const saveAndPreview = async (view: EditorView, file: string, content: string, heading: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
      fireEvent.keyDown(window, { key: "s", metaKey: true });
      await expectInvoked("write_project_file", { path: `.research/papers/1706.03762/${file}`, content, projectRoot: ROOT });
      fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    };
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const blogEditor = editorViewAt(".source-editor .cm-editor");
    await saveAndPreview(blogEditor, "blog.md", "# Edited overview\n\nSaved from Papers.", "Edited overview");

    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    const abstractHeading = await screen.findByRole("heading", { name: "Abstract" });
    const paperHeader = document.querySelector<HTMLElement>(".paper-visual-header");
    expect(paperHeader).not.toBeNull();
    expect(within(paperHeader!).getByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(within(paperHeader!).getByText("Ashish Vaswani · Noam Shazeer")).toBeInTheDocument();
    expect(paperHeader!.compareDocumentPosition(abstractHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("title: Attention Is All You Need")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const paperEditor = await waitFor(() => editorViewAt(".source-editor .cm-editor"));
    expect(paperEditor.state.doc.toString()).toContain("- [ ] Hidden metadata task");
    expect(paperEditor.state.doc.toString()).toContain("- [x] Review paper");
    await saveAndPreview(paperEditor, "paper.md", "# Edited paper\n\nLocal notes.", "Edited paper");
    expect(paper.closest(".paper-row")).toHaveClass("active");
    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await switchSidebarMode("Papers");
    await waitFor(() => expect(screen.getByTitle("Attention Is All You Need").closest(".paper-row")).not.toHaveClass("active"));
  });

  it("splits a Paper with an editor and lets the Paper move between sides", { timeout: 60_000 }, async () => {
    persistLayout(ROOT, {
      openTabs: ["main.tex", ".research/papers/1706.03762/paper.md"], activeFile: "main.tex", canvasMode: "source",
      documentMode: "split", paperView: "fulltext",
    });
    renderApp({
      ...projectCommands(), list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: false })],
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: null,
    });
    const paperTabButton = await screen.findByRole("tab", { name: /Attention Is All You Need/ }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent("\\documentclass{article}"), { timeout: 20_000 });
    fireEvent.click(paperTabButton);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
      expect(document.querySelector(".paper-reader-shell")).not.toBeNull();
    }, { timeout: 20_000 });

    dragTabToRightEdge(/main\.tex/, () => {
      expect(document.querySelector(".editor-tab-split-drop-preview")).toHaveTextContent("Open on right");
    });

    await waitFor(() => expect(document.querySelector(".paper-pane")).toHaveAttribute("data-paper-side", "left"));
    expect(paneContent("secondary")).toHaveTextContent("\\documentclass{article}");
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");

    dragTabToRightEdge(/Attention Is All You Need/);

    await waitFor(() => expect(document.querySelector(".paper-pane")).toHaveAttribute("data-paper-side", "right"));
    expect(document.querySelector(".dual-canvas")!.lastElementChild).toBe(document.querySelector(".paper-pane"));
    expect(screen.getByRole("tab", { name: /Attention Is All You Need/ })).toHaveAttribute("aria-selected", "true");
  });

  it("does not start a full sync when an opened Overleaf project is unchanged", async () => {
    let syncCount = 0;
    renderOverleafPaper({
      overleaf_link: () => overleafLink({ projectId: "ol-unchanged", lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_probe: () => overleafProbe({ remoteVersion: 42, lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_sync: () => {
        syncCount += 1;
        return overleafSyncResult();
      },
      overleaf_rt_connect: () => overleafSession({ docs: [] }),
    });
    await expectInvoked("overleaf_probe", { projectRoot: "/tmp/lattice-overleaf-paper", checkLocal: true, live: [] });
    await act(async () => { await Promise.resolve(); });
    expect(syncCount).toBe(0);
    expect(screen.queryByRole("button", { name: "Syncing with Overleaf…" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
  });

  it("keeps a local Paper editable when its project is read-only on Overleaf", async () => {
    renderApp({
      ...refreshableProject(overleafPaperSnapshot()), list_papers: () => [attentionPaper({ hasBlog: false })],
      read_paper: "## Abstract\n\nPaper content.\n\n## Method\n\nEditable notes.",
      ...overleafCommands({
        overleaf_link: () => overleafLink({ projectId: "ol-read-only" }),
        overleaf_rt_connect: () => overleafSession({ permission: "readOnly" }),
        overleaf_status: () => overleafStatus({ email: "reader@example.com", name: "Reader" }),
      }),
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    await openPaper("Attention Is All You Need");
    const paperEditor = await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(paperEditor).toHaveAttribute("contenteditable", "true"));
    expect(document.querySelector(".ok-block-controls")).not.toBeNull();
  });

  it("routes toolbar and status comments to one Overleaf drawer while preserving local history", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    const snapshot = projectSnapshot({
      root: "/tmp/unified-comments", projectId: "unified-comments", name: "Review paper", rootDocuments: MAIN_DOCUMENT,
    });
    const comments = [false, true].map((resolved, index) => ({
      id: `local-${index}`, path: index ? "unsynced.tex" : "main.tex", from: 0, to: 5,
      quote: "alpha", prefix: "", suffix: " beta", body: index ? "Local history" : "Local review",
      authorId: "reviewer", authorName: "Reviewer", resolved, replies: [],
      createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
    }));
    renderApp({
      ...refreshableProject(snapshot, "alpha beta"), list_editor_comments: comments, save_editor_comments: undefined,
      overleaf_link: () => overleafLink({ projectId: "remote-project", projectName: "Review paper" }),
      ...OVERLEAF_EMPTY_FEEDS,
      overleaf_threads: () => [{
        id: "remote-thread", resolved: false, resolvedBy: null, resolvedAt: null,
        messages: [{ id: "message", content: "Remote review", authorName: "Collaborator", authorEmail: "", timestamp: Date.now(), mine: false }],
      }],
      overleaf_probe: () => overleafProbe(), overleaf_status: () => overleafStatus(),
    });
    const toolbar = await screen.findByRole("button", { name: "Overleaf comments and chat · 2 waiting" });
    expect(document.querySelector('.canvas-toolbar button[aria-label="Editor comments"]')).toBeNull();
    fireEvent.click(toolbar);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    expect(document.querySelectorAll(".overleaf-collab-drawer")).toHaveLength(1);
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Local comments/ }));
    expect(await screen.findByText("Local review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Include resolved" }));
    expect(screen.getByText("Local history")).toBeInTheDocument();
    expect(screen.getByText("unsynced.tex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /main.tex alpha Local review/ }));
    await waitFor(() => expect(document.querySelector(".overleaf-collab-drawer")).toBeNull());
    fireEvent.click(document.querySelector<HTMLButtonElement>(".status-comments")!);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Comments2/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("save_editor_comments", expect.anything());
    fireEvent.click(screen.getByRole("tab", { name: /Local comments/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply to Reviewer"), { target: { value: "Local-only reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await expectInvoked("save_editor_comments", {
      comments: [
        expect.objectContaining({ id: "local-0", replies: [expect.objectContaining({ body: "Local-only reply" })] }),
        comments[1],
      ],
    });
    expect(invoke).not.toHaveBeenCalledWith("overleaf_reply_to_thread", expect.anything());
  });

  it("opens the linked project on its Overleaf host and keeps the project picker available", async () => {
    renderOverleafPaper({
      // Legacy links did not persist the host, so the active account is the
      // source of truth for where their web project lives.
      overleaf_link: () => overleafLink({ projectId: "ol/project id", host: "" }),
      overleaf_status: () => overleafStatus({ host: "https://overleaf.example.edu/" }),
      overleaf_list_projects: () => [],
    }, { syncMode: "manual" });
    const actions = await screen.findByRole("button", { name: "Overleaf project actions" });
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Overleaf" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://overleaf.example.edu/project/ol%2Fproject%20id"));
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open another Overleaf project" }));
    expect(await screen.findByLabelText("Open from Overleaf")).toBeInTheDocument();
    expect(screen.queryByText("Upload this project to Overleaf")).not.toBeInTheDocument();
    expect(await screen.findByText("No projects in this account yet. Create one on Overleaf and it will appear here"))
      .toBeInTheDocument();
  });

  it("silently retries a transient automatic Overleaf outage but reports it for manual sync", async () => {
    const transportFailure = new Error("error decoding response body");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const scheduledTimeouts = vi.spyOn(window, "setTimeout");
    let syncCount = 0;
    let failSync = true;
    let probeChanged = false;
    renderOverleafPaper({
      overleaf_sync: () => {
        syncCount += 1;
        if (failSync) throw transportFailure;
        return overleafSyncResult();
      },
      overleaf_probe: (args) => overleafProbe({
        changed: probeChanged, localChanged: Boolean((args as { checkLocal?: boolean } | undefined)?.checkLocal),
        remoteVersion: probeChanged ? 77 : 1,
      }),
    }, { syncMode: "live" });
    const gitAutoCommitted = () => vi.mocked(invoke).mock.calls.some(([command]) => command === "git_auto_commit");
    await waitFor(() => expect(syncCount).toBe(1), { timeout: 30_000 });
    await waitFor(() => expect(formatAppLogs()).toMatch(/error decoding response body/));
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    failSync = false;
    vi.setSystemTime(1_030_000);
    const poll = [...scheduledTimeouts.mock.calls].reverse().find(([, delay]) => delay === 3_000)?.[0];
    scheduledTimeouts.mockRestore();
    expect(poll).toBeTypeOf("function");
    act(() => { (poll as () => void)(); });
    await waitFor(() => expect(syncCount).toBe(2));
    expect(gitAutoCommitted()).toBe(false);
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    const syncButton = await findOverleafSyncButton();
    probeChanged = true;
    vi.setSystemTime(1_060_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(syncCount).toBe(3));
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", {
      projectRoot: "/tmp/lattice-overleaf-paper", live: [], observedRemoteVersion: 77,
      diagnosticContext: { operation_id: expect.any(String), request_id: expect.any(String) },
    });
    expect(gitAutoCommitted()).toBe(false);

    await waitFor(() => expect(syncButton).not.toBeDisabled());
    probeChanged = false;
    failSync = true;
    fireEvent.click(syncButton);

    await waitFor(() => expect(syncCount).toBe(4));
    await expectNotification(/Sync failed[\s\S]*error decoding response body/);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
  });

  it("localizes confirmation and completion when removing a locally deleted Overleaf file", async () => {
    await setInterfaceLanguage("zh-CN");
    renderOverleafPaper({
      overleaf_sync: () => overleafSyncResult({ skippedRemoteDeletes: ["results.lattice-sheet.bak"] }),
      overleaf_rt_connect: () => overleafSession({ entities: [{ id: "backup-file", path: "results.lattice-sheet.bak", kind: "file" }] }),
      overleaf_delete_entity: undefined,
    }, { syncMode: "live", confirmations: true });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    fireEvent.click(await findOverleafSyncButton());
    const dialog = await screen.findByRole("dialog", { name: "从 Overleaf 项目中删除 1 个文件？" }, { timeout: 15_000 });
    expect(dialog).toHaveAccessibleDescription(
      "results.lattice-sheet.bak 已从本地项目删除，但仍保留在 Overleaf 上。即使现在删除，Overleaf 的历史记录仍会保留它",
    );
    fireEvent.click(screen.getByRole("button", { name: "同时在 Overleaf 上删除" }));
    await expectInvoked("overleaf_delete_entity", { projectRoot: "/tmp/lattice-overleaf-paper", kind: "file", entityId: "backup-file" });
    await expectNotification(/已从 Overleaf 删除 1 个文件/);
  });

  it("silently removes legacy app-owned intermediates from Overleaf", async () => {
    let syncCount = 0;
    renderOverleafPaper({
      overleaf_sync: () => {
        syncCount += 1;
        return overleafSyncResult({ automaticRemoteDeletes: syncCount > 1 ? ["lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs"] : [] });
      },
      overleaf_probe: (args) => overleafProbe({ localChanged: Boolean((args as { checkLocal?: boolean } | undefined)?.checkLocal) }),
      overleaf_rt_connect: () => overleafSession({ entities: [
        { id: "tmp-folder", path: "tmp", kind: "folder" }, { id: "pdfs-folder", path: "tmp/pdfs", kind: "folder" },
        { id: "save-error-file", path: "lambda_gpu_proposal.bbl-SAVE-ERROR", kind: "file" },
      ] }),
      overleaf_delete_entity: undefined,
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    await waitFor(() => expect(syncCount).toBe(1));
    fireEvent.click(await findOverleafSyncButton());
    const deleted = (kind: string, entityId: string) => ({ projectRoot: "/tmp/lattice-overleaf-paper", kind, entityId });
    await expectInvoked("overleaf_delete_entity", deleted("folder", "pdfs-folder"));
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", deleted("file", "save-error-file"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    { cached: false, fallback: false }, { cached: true, fallback: false }, { cached: true, fallback: true },
  ])("opens an AlphaXiv overview and routes source links (%j)", async ({ cached, fallback }) => {
    const url = "https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning";
    const citationUrl = `${url}.pdf#page=8`;
    const paper = { arxivId: "web-0123456789abcdef", url, title: "MiMo-V2.6", hasFullText: fallback, hasBlog: cached };
    renderApp({
      ...refreshableProject(), list_papers: () => [{ ...paper }],
      fetch_web_reference: () => {
        paper.hasBlog = true;
        return { arxivId: paper.arxivId, paperPath: "", blogPath: `.research/papers/${paper.arxivId}/blog.md` };
      },
      read_paper: () => {
        if (fallback) return "# Original full text\n\nWe use a large training dataset with many tokens per sequence";
        throw new Error("Full text unavailable");
      },
      paper_pdf_preview_url: () => {
        if (fallback) throw new Error("PDF unavailable");
        return "http://127.0.0.1:3456/paper.pdf?token=test";
      },
      read_paper_blog_local: () => `# MiMo overview\n\nTraining uses 1,568 prompts. [p8](${citationUrl} "We use a large training … tokens per sequence")`,
    });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: /^MiMo-V2\.6/ }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const citation = await screen.findByRole("link", { name: "p8" });
    expect(citation).toHaveAttribute("href", citationUrl);
    expect(citation).toHaveAttribute("title", "We use a large training … tokens per sequence");
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeVisible();
    const blogViewport = citation.closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(blogViewport, 600, 2400);
    blogViewport.scrollTop = 735;
    fireEvent.scroll(blogViewport);
    fireEvent.click(citation);
    await expectInvoked("paper_pdf_preview_url", { url: `${url}.pdf` });
    if (fallback) {
      expect(await screen.findByRole("heading", { name: "Original full text" })).toBeVisible();
      await waitFor(() => expect(window.getSelection()?.toString()).toBe("We use a large training dataset with many tokens per sequence"));
    }
    expect(await screen.findByRole("button", { name: "Back to Blog" })).toBeVisible();
    expect(openUrl).not.toHaveBeenCalledWith(citationUrl);
    fireEvent.click(screen.getByRole("button", { name: "Back to Blog" }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const returnedViewport = screen.getByRole("link", { name: "p8" }).closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(returnedViewport, 600, 2400);
    await waitFor(() => expect(returnedViewport.scrollTop).toBe(735));
    expect(invoke).not.toHaveBeenCalledWith("fetch_paper", expect.anything());
    if (!cached) expect(invoke).toHaveBeenCalledWith("fetch_web_reference", { url });
  });

  it("opens a captured webpage without offering it as an arXiv PDF", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{
        arxivId: "web-0123456789abcdef", url: "https://example.com/research/article", title: "A captured research article",
        hasFullText: true, hasBlog: false,
      }],
      read_paper: "# A captured research article\n\nArticle content.",
    });
    await openPaper("A captured research article");
    const paperHeader = await findElement(".paper-visual-header");
    expect(within(paperHeader).getByRole("heading", { name: "A captured research article" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View original PDF" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open article in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/research/article"));
  });

  it("streams ordinary PDFs, reuses complete bytes, and isolates failures and stale requests", async () => {
    const firstUrl = "https://mirros.ai/report/s-space.PDF?download=1#page=1";
    const secondUrl = "https://example.com/papers/second.pdf";
    const secondPreviewUrl = "http://127.0.0.1:3456/paper.pdf?token=test&url=second";
    const secondBytes = new TextEncoder().encode("%PDF second").buffer;
    const expectedSecondBytes = new Uint8Array(secondBytes.slice(0));
    const firstPreview = deferred<string>();
    let secondAttempts = 0;
    mockCommands({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        { arxivId: "web-first", url: firstUrl, title: "First PDF", hasFullText: true, hasBlog: false },
        { arxivId: "web-second", url: secondUrl, title: "Second PDF", hasFullText: true, hasBlog: false },
      ],
      read_paper: (args) => `# ${(args as { arxivId: string }).arxivId}`,
      paper_pdf_preview_url: (args) => {
        if ((args as { url: string }).url === firstUrl) return firstPreview.promise;
        secondAttempts += 1;
        if (secondAttempts === 1) throw new Error("remote PDF unavailable");
        return secondPreviewUrl;
      },
    });
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    mockPdfDocument(() => pdfDocumentStub(2, { render: () => renderTask }, {
      getData: vi.fn(async () => new Uint8Array(secondBytes)), cleanup: vi.fn(),
    }));
    const viewOriginal = async () => fireEvent.click(await screen.findByRole("button", { name: "View original PDF" }));

    renderApp();
    await openPaper("First PDF");
    await viewOriginal();
    await expectInvoked("paper_pdf_preview_url", { url: firstUrl });
    expect(screen.getByRole("status")).toHaveTextContent("Loading PDF…");
    expect(screen.getByRole("status")).toHaveClass("pdf-loading");
    expect(getDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open PDF in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(firstUrl));

    fireEvent.click(screen.getByTitle("Second PDF"));
    await screen.findByRole("heading", { name: "Second PDF" });
    await viewOriginal();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not load PDF"));
    expect(invoke).toHaveBeenCalledWith("paper_pdf_preview_url", { url: secondUrl });
    firstPreview.resolve("http://127.0.0.1:3456/paper.pdf?token=test&url=first");
    await Promise.resolve();
    expect(getDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Paper" }));
    await viewOriginal();
    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: secondPreviewUrl })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Back to Paper" }));
    await viewOriginal();
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    expect(secondAttempts).toBe(2);
    const loadedSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as { data?: ArrayBuffer; url?: string } | undefined;
    expect(loadedSource?.url).toBeUndefined();
    expect(new Uint8Array(loadedSource?.data ?? new ArrayBuffer(0))).toEqual(expectedSecondBytes);
    expect(screen.getByRole("textbox", { name: "PDF page number" })).toHaveValue("1");
  });

  it("streams an arXiv PDF and reopens its complete in-memory bytes", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 streamed arXiv paper").buffer;
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const pdf = pdfDocumentStub(1, { render: () => renderTask }, {
      getData: vi.fn(async () => new Uint8Array(pdfBytes)), cleanup: vi.fn(),
    });
    mockPdfDocument(() => pdf);
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [{ arxivId: "1706.03762v7", title: "Attention Is All You Need", hasFullText: true, hasBlog: false }],
      read_paper: PAPER_ABSTRACT,
    });
    await openPaper("Attention Is All You Need");
    const viewOriginalPdf = await screen.findByRole("button", { name: "View original PDF" });
    expect(viewOriginalPdf.closest('[data-tour="paper-actions"]')).not.toBeNull();
    fireEvent.click(viewOriginalPdf);

    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "https://arxiv.org/pdf/1706.03762v7" })));
    const backToPaper = await screen.findByRole("button", { name: "Back to Paper" });
    const openInBrowser = screen.getByRole("button", { name: "Open PDF in browser" });
    const downloadPdf = screen.getByRole("button", { name: "Download PDF" });
    const paperPdfToolbar = backToPaper.closest(".pdf-toolbar");
    expect(paperPdfToolbar).toContainElement(openInBrowser);
    expect(paperPdfToolbar).toContainElement(downloadPdf);
    expect(backToPaper.querySelector("svg")).toHaveClass("lucide-arrow-left");
    expect(backToPaper.querySelector("svg")).toHaveAttribute("stroke-width", "2");
    expect(document.querySelector(".paper-reader-header")).toBeNull();
    await waitFor(() => expect(downloadPdf).toBeEnabled());
    fireEvent.click(openInBrowser);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762v7"));

    fireEvent.click(backToPaper);
    fireEvent.click(await screen.findByRole("button", { name: "View original PDF" }));

    await waitFor(() => {
      const remoteLoads = vi.mocked(getDocument).mock.calls
        .filter(([source]) => (source as { url?: string }).url === "https://arxiv.org/pdf/1706.03762v7");
      expect(remoteLoads).toHaveLength(1);
      const reopenedSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as { data?: Uint8Array; url?: string } | undefined;
      expect(reopenedSource?.url).toBeUndefined();
      expect(new Uint8Array(reopenedSource?.data ?? new ArrayBuffer(0))).toEqual(new Uint8Array(pdfBytes));
    });
  });

  it("publishes a visually selected Markdown block as Agent context", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "pdf" });
    await loadVisualMarkdownEditorModule();
    renderApp({
      ...projectCommands(markdownSnapshot(), "## Selected context\n\nUnselected paragraph"),
      list_editor_comments: () => ["notes.md", "other.tex"].map((path) => ({
        id: path, path, from: 3, to: 19, quote: "Selected context", prefix: "## ", suffix: "",
        body: "Explain the evidence", authorId: "reviewer", authorName: "Reviewer",
        resolved: false, replies: [], createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
      })),
    });
    const { frame, postMessage } = await openAgentFrame({ ready: true });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" }, { timeout: 15_000 });
    const editor = visualEditorOf(surface);
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    });

    type HostContext = { editor?: { selection?: string } };
    const hostContexts = () => postedOfType<HostContext>(postMessage, "lattice:host-context");
    await waitFor(() => expect(hostContexts().some((context) => context.editor?.selection === "## Selected context")).toBe(true));

    const grip = document.querySelector<HTMLElement>(".ok-drag-grip");
    expect(grip).not.toBeNull();
    fireEvent.pointerDown(grip!, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerUp(grip!, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.click(grip!);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    // The grip focuses the same visual-editor surface after selecting the
    // block. That focus must not clear the context it just published.
    fireEvent.focus(surface);

    const contextCount = hostContexts().length;
    postWindowMessage(frame.contentWindow, { type: "lattice:request-host-context" });
    await waitFor(() => expect(hostContexts()).toHaveLength(contextCount + 1));
    expect(hostContexts().at(-1)?.editor?.selection).toBe("## Selected context");
    postWindowMessage(frame.contentWindow, {
      type: "lattice:request-host-context", requestId: "fresh-comments", workspaceRoot: ROOT, refreshComments: true,
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "fresh-comments",
      editorComments: expect.objectContaining({
        comments: [expect.objectContaining({ path: "notes.md", body: "Explain the evidence", anchorStatus: "exact" })],
        overleaf: { status: "not-linked" },
      }),
    }), synaraHook.runtime.origin));
    postWindowMessage(frame.contentWindow, {
      type: "synara:editor-comments-tool-request", version: 1, id: "all-comments", workspaceRoot: ROOT,
      args: {}, expiresAt: Date.now() + 10_000,
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "lattice:editor-comments-tool-result", id: "all-comments", ok: true,
      result: expect.objectContaining({ totalCount: 2, comments: expect.arrayContaining([
        expect.objectContaining({ path: "notes.md" }), expect.objectContaining({ path: "other.tex" }),
      ]) }),
    }), synaraHook.runtime.origin));
  });

  it("gives the Agent a PNG path for a selected WebP Markdown image", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "pdf" });
    renderApp({
      ...projectCommands(markdownSnapshot("notes.md", [fileNode("notes.md"), dirNode("figures", [fileNode("figures/figure.webp")])]),
        "![Figure](figures/figure.webp)"),
      read_project_asset: () => ({ path: "figures/figure.webp", mimeType: "image/webp", base64: btoa("webp-bytes") }),
      prepare_latex_figure: "figures/figure-converted.png",
    });
    const { postMessage } = await openAgentFrame({ ready: true });
    const editor = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    });
    await expectInvoked("prepare_latex_figure", { path: "figures/figure.webp", projectRoot: ROOT });
    type ImageContext = {
      editor?: { selection?: string; selectionImage?: { sourcePath?: string; agentReadablePath?: string; mimeType?: string } };
    };
    await waitFor(() => expect(postedOfType<ImageContext>(postMessage, "lattice:host-context").some(({ editor }) => (
      editor?.selection === "![Figure](figures/figure.webp)" && editor.selectionImage?.sourcePath === "figures/figure.webp"
      && editor.selectionImage.agentReadablePath === "figures/figure-converted.png" && editor.selectionImage.mimeType === "image/png"
    ))).toBe(true));
  });

  // The outgoing notes must never be saved over the Paper being opened.
  const NOTES_INTO_PAPER = expect.objectContaining({
    path: ".research/papers/2407.06438/paper.md", content: expect.stringContaining("Original notes"),
  });

  /** Opens notes.md ("Original notes") in the visual editor beside the Paper `title`, returning that editor. */
  const renderNotesBesidePaper = async (title: string, commands: Commands) => {
    renderApp({
      ...refreshableProject(markdownSnapshot(), "Original notes"),
      list_papers: () => [{ arxivId: "2407.06438", title, hasFullText: true }], ...commands,
    });
    return visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
  };

  it("publishes the current visual document before opening a Paper", async () => {
    let resolveWrite: (() => void) | null = null;
    const editor = await renderNotesBesidePaper("Paper target", {
      read_paper: "# Paper body",
      write_project_file: () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " updated"));
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: /Paper target.*2407\.06438/i }));
    expect(screen.getByText("Opening Paper target…")).toBeInTheDocument();
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    // The target Paper read is independent of writing the outgoing notes, so
    // both should be in flight rather than paying write latency first.
    expect(resolveWrite).not.toBeNull();
    act(() => resolveWrite?.());
    await waitFor(() => expect(vi.mocked(invoke).mock.calls).toContainEqual(["write_project_file", expect.objectContaining({
      path: "notes.md", content: expect.stringMatching(/Original notes[\s\S]*updated/), projectRoot: ROOT,
    })]));
    expect(await screen.findByRole("heading", { name: "Paper body" })).toBeInTheDocument();
    expect(screen.queryByText("Original notes updated")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps the current document when it is edited during a delayed Paper read", async () => {
    const paperRead = deferred<string>();
    const editor = await renderNotesBesidePaper("Delayed paper", { read_paper: () => paperRead.promise, write_project_file: undefined });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: /Delayed paper.*2407\.06438/i }));
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " late edit"));
    act(() => paperRead.resolve("# Paper must not replace the edit"));
    await act(async () => { await Promise.resolve(); });
    expect(editor.getText()).toMatch(/Original notes[\s\S]*late edit/);
    expect(screen.queryByRole("heading", { name: "Paper must not replace the edit" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", NOTES_INTO_PAPER);
  });

  it("keeps only the latest Paper when overlapping reads finish out of order", async () => {
    const paperResolvers = new Map<string, (value: string) => void>();
    renderApp({
      ...refreshableProject(projectSnapshot(), "\\documentclass{main}"),
      list_papers: () => [
        { arxivId: "2407.06438", title: "First paper", hasFullText: true },
        { arxivId: "2103.00020", title: "Second paper", hasFullText: true },
      ],
      read_paper: (args) => new Promise<string>((resolve) => { paperResolvers.set((args as { arxivId: string }).arxivId, resolve); }),
    });
    await openPaper("First paper");
    await waitFor(() => expect(paperResolvers.has("2407.06438")).toBe(true));
    fireEvent.click(screen.getByTitle("Second paper"));
    await waitFor(() => expect(paperResolvers.has("2103.00020")).toBe(true));
    act(() => paperResolvers.get("2103.00020")?.("# Second body"));
    expect(await screen.findByRole("heading", { name: "Second body" })).toBeInTheDocument();
    act(() => paperResolvers.get("2407.06438")?.("# First body"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Second paper", { selector: ".active-document span" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second body" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First body" })).toBeNull();
  });

  it("cancels a pending Paper when the user opens a local file in the secondary pane", async () => {
    persistLayout(ROOT, {
      openTabs: ["main.tex", "right.tex"], activeFile: "main.tex", activeTab: "right.tex", secondaryFile: "right.tex",
      focusedPane: "secondary", canvasMode: "dual", tabRecency: ["right.tex", "main.tex"],
    });
    const paperRead = deferred<string>();
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "right.tex", "notes.md") })), read_project_file: readPathContent,
      list_papers: () => [{ arxivId: "2407.06438", title: "Delayed paper", hasFullText: true }],
      read_paper: () => paperRead.promise, read_paper_blog_local: null,
    });
    await waitFor(() => expect(document.querySelectorAll(".dual-canvas .source-editor")).toHaveLength(2));
    await openPaper("Delayed paper");
    await expectInvoked("read_paper", { arxivId: "2407.06438" });
    expect(screen.getByText("Opening Delayed paper…")).toBeInTheDocument();
    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:notes.md"));
    expect(screen.queryByText("Opening Delayed paper…")).toBeNull();
    act(() => paperRead.resolve("# Paper must stay closed"));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelectorAll(".dual-canvas .source-editor")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { name: "Paper must stay closed" })).toBeNull();
  });

  it("remembers the selected paper content when reopening an article", async () => {
    renderApp({
      ...projectCommands(projectSnapshot(), "\\documentclass{main}"), list_papers: () => [attentionPaper({ hasBlog: true })],
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: "# Attention overview\n\nBlog content.",
    });
    await openPaper("Attention Is All You Need");
    const paperContent = await screen.findByRole("tablist", { name: "Paper content" });
    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    await waitFor(() => expect(within(paperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await switchSidebarMode("Papers");
    const paper = await screen.findByTitle("Attention Is All You Need");
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
    fireEvent.click(paper);
    await waitFor(() => expect(invokeCalls("read_paper")).toHaveLength(2));
    const reopenedPaperContent = await screen.findByRole("tablist", { name: "Paper content" });
    await waitFor(() => expect(within(reopenedPaperContent).getByRole("tab", { name: "Paper" })).toHaveAttribute("aria-selected", "true"));
  });

  /** A full-text search hit in a project file. */
  const fileHit = (path: string, line: number, snippet: string, fileKind = "tex") => ({
    kind: "file", path, title: path, snippet, line, fileKind,
  });

  it("opens indexed full-text search from the Project sidebar and opens file and Blog hits", async () => {
    const paper = { ...SINGLE_TRANSFORMER, hasBlog: true };
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "references.bib") })),
      read_project_file: readFiles({
        "references.bib": "Bibliography\n@article{chen2024single, title={A Single Transformer}}\n",
      }, "Main document\n"),
      list_papers: () => [paper], read_paper: "# Full paper\n\nTransformer details.",
      read_paper_blog_local: "# Chen overview\n\nA residual stream explanation.",
      search_project: () => [
        fileHit("references.bib", 2, "@article{chen2024single, title={A Single Transformer}}", "bib"),
        {
          kind: "paper", path: ".research/papers/2407.06438/blog.md", title: paper.title,
          snippet: "A residual stream explanation.", line: 3, arxivId: paper.arxivId,
        },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Find in project" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find in project" }), { target: { value: "chen" } });
    await expectInvoked("search_project", { query: "chen" });
    expect(await screen.findByText(/@article\{chen2024single/, { selector: ".project-replace-hit-preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("references.bib:2"));
    await waitFor(() => {
      const view = editorViewAt();
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open paper result: A Single Transformer" }));
    await expectInvoked("read_paper_blog_local", { arxivId: "2407.06438" });
    expect(await screen.findByRole("heading", { name: "Chen overview" })).toBeInTheDocument();
  });

  it("ignores full-text search results that arrive after a newer query", async () => {
    type Hits = Array<Record<string, unknown>>;
    const [older, newer] = [deferred<Hits>(), deferred<Hits>()];
    renderApp({
      ...refreshableProject(),
      search_project: (args) => ((args as { query?: string } | undefined)?.query === "older" ? older : newer).promise,
    });
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in project" });
    fireEvent.change(input, { target: { value: "older" } });
    await expectInvoked("search_project", { query: "older" });
    fireEvent.change(input, { target: { value: "newer" } });
    await expectInvoked("search_project", { query: "newer" });
    await act(async () => {
      newer.resolve([fileHit("newer.tex", 2, "The current result.")]);
      await newer.promise;
    });
    expect(await screen.findByText("newer.tex:2")).toBeInTheDocument();
    await act(async () => {
      older.resolve([fileHit("older.tex", 7, "A stale result.")]);
      await older.promise;
    });
    expect(screen.queryByText("older.tex:7")).not.toBeInTheDocument();
    expect(screen.getByText("newer.tex:2")).toBeInTheDocument();
  });

  it("renames project items but keeps bibliography titles authoritative for papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      ROOT: { "main.tex": { text: { cursor: 12, scrollTop: 80 } } },
    }));
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    renderApp({ ...refreshableProject(), list_papers: () => [paper], rename_project_entry: "paper.tex" });
    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    const fileMenu = await screen.findByRole("menu");
    expect(fileMenu.parentElement).toBe(document.body);
    expect(fileMenu).toHaveStyle({ position: "fixed" });
    fireEvent.click(within(fileMenu).getByRole("menuitem", { name: "Rename" }));
    const renameInput = await findProjectTreeRenameInput();
    fireEvent.input(renameInput, { target: { value: "paper" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await expectInvoked("rename_project_entry", { path: "main.tex", newName: "paper", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /paper\.tex/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /main\.tex/ })).not.toBeInTheDocument();
    expect(await findProjectTreeItem("paper.tex")).toBeInTheDocument();
    await waitFor(() => {
      expect(storedFileViews()[ROOT]?.["main.tex"]).toBeUndefined();
      expect(storedFileViews()[ROOT]?.["paper.tex"]).toBeDefined();
    });
    await switchSidebarMode("Papers");
    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  /** Expands `directories` in the project tree, as a previous session left them. */
  const expandDirectories = (...directories: string[]) => (
    localStorage.setItem("lattice:expanded-directories:/tmp/lattice-paper", JSON.stringify(directories))
  );

  it("tracks each pointer row as the drop target and persists the move", async () => {
    expandDirectories("sections");
    const beforeMove = projectSnapshot({
      files: [...fileNodes("main.tex", "draft.tex"), dirNode("figures"), dirNode("notes"), dirNode("sections")],
    });
    const afterMove = {
      ...beforeMove,
      manifest: { ...beforeMove.manifest, rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }] },
      files: [fileNode("main.tex"), dirNode("figures"), dirNode("notes"), dirNode("sections", [fileNode("sections/draft.tex")])],
    };
    let moved = false;
    const move = deferred<string>();
    renderApp({ ...projectCommands(beforeMove), refresh_project: () => moved ? afterMove : beforeMove, move_project_entry: move.promise });
    const source = await findProjectTreeItem("draft.tex");
    const figures = await findProjectTreeItem("figures/");
    const notes = await findProjectTreeItem("notes/");
    const target = await findProjectTreeItem("sections/");
    const backgroundScans = () => vi.mocked(invoke).mock.calls.filter(([command]) => [
      "refresh_project", "list_papers", "list_citation_keys", "list_citations", "list_references", "list_unused_symbols", "list_history",
    ].includes(command));
    const backgroundCallsBeforeMove = backgroundScans().length;
    const dropTarget = (path: string) => queryProjectTreeItem(path);
    const pointer = { pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(source, { button: 0, clientX: 1, clientY: 1, ...pointer });
    fireEvent.pointerMove(figures, { clientX: 20, clientY: 20, ...pointer });
    await waitFor(() => {
      expect(projectTreeRoot()?.host).toHaveAttribute("data-lattice-pointer-drag-active", "true");
      const preview = projectTreeRoot()?.querySelector<HTMLElement>('[data-lattice-pointer-drag-preview="true"]');
      expect(preview).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview?.style.transform).toContain("translate3d");
      expect(preview?.style.opacity).toBe("0.76");
      expect(dropTarget("figures/")).toHaveAttribute("data-lattice-pointer-drop-target", "true");
    });
    fireEvent.pointerMove(notes, { clientX: 20, clientY: 35, ...pointer });
    await waitFor(() => expect(dropTarget("notes/")).toHaveAttribute("data-lattice-pointer-drop-target", "true"));
    fireEvent.pointerMove(target, { clientX: 20, clientY: 50, ...pointer });
    await waitFor(() => expect(dropTarget("sections/")).toHaveAttribute("data-lattice-pointer-drop-target", "true"));
    expect(dropTarget("figures/")).not.toHaveAttribute("data-lattice-pointer-drop-target");
    expect(dropTarget("notes/")).not.toHaveAttribute("data-lattice-pointer-drop-target");
    fireEvent.pointerUp(target, { clientX: 20, clientY: 50, ...pointer });

    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
    // Pierre's local model must move immediately, before filesystem persistence finishes.
    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    moved = true;
    move.resolve("sections/draft.tex");
    await waitFor(() => {
      expect(projectTreeRoot()?.host).not.toHaveAttribute("data-lattice-pointer-drag-active");
      expect(projectTreeRoot()?.querySelector('[data-lattice-pointer-drag-preview="true"]')).toBeNull();
    });
    expect(backgroundScans()).toHaveLength(backgroundCallsBeforeMove);
  });

  it("rebases image paths when an open Markdown file is moved into a folder", async () => {
    expandDirectories("figures");
    renderApp({
      ...refreshableProject(markdownSnapshot("notes.md", [fileNode("notes.md"), dirNode("figures", [fileNode("figures/plot.png")])])),
      read_project_file: '# Notes\n\n<img src="figures/plot.png" alt="Plot" width={223} />\n', move_project_entry: "figures/notes.md",
    });
    await screen.findByRole("textbox", { name: "Markdown document editor" });
    dragTreeItem(await findProjectTreeItem("notes.md"), await findProjectTreeItem("figures/plot.png"));
    await expectInvoked("move_project_entry", { path: "notes.md", targetDirectory: "figures", projectRoot: ROOT });
    await expectInvoked("write_project_file", {
      path: "figures/notes.md", content: '# Notes\n\n<img src="plot.png" alt="Plot" width={223} />\n', projectRoot: ROOT,
    });
  });

  it("treats a same-directory drop as a no-op", async () => {
    renderApp(refreshableProject(projectSnapshot({ files: [dirNode("notes"), ...fileNodes("main.tex", "references.bib")] })));
    const source = await findProjectTreeItem("main.tex");
    const target = await findProjectTreeItem("references.bib");
    const pointer = { clientX: 20, clientY: 20, pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(source, { ...pointer, button: 0, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(target, pointer);
    expect(queryProjectTreeItem("references.bib")).not.toHaveAttribute("data-lattice-pointer-drop-target");
    await act(async () => { fireEvent.pointerUp(queryProjectTreeItem("references.bib")!, pointer); });
    expect(invoke).not.toHaveBeenCalledWith("move_project_entry", expect.anything());
  });

  it("rolls an optimistic tree move back when persistence fails", async () => {
    expandDirectories("sections");
    const move = deferred<string>();
    const snapshot = projectSnapshot({ files: [...fileNodes("main.tex", "draft.tex"), dirNode("sections")] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: move.promise });
    dragTreeItem(await findProjectTreeItem("draft.tex"), await findProjectTreeItem("sections/"));
    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
    move.reject(new Error("Move failed"));
    expect(await findProjectTreeItem("draft.tex")).toBeInTheDocument();
    await waitFor(() => expect(queryProjectTreeItem("sections/draft.tex")).toBeNull());
  });

  it("moves a nested file to the root when it is dropped on a root file", async () => {
    expandDirectories("sections");
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), dirNode("sections", [fileNode("sections/draft.tex")])] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: "draft.tex" });
    const source = await findProjectTreeItem("sections/draft.tex");
    await findProjectTreeItem("main.tex");
    dragTreeItem(source, () => queryProjectTreeItem("main.tex")!);
    await expectInvoked("move_project_entry", { path: "sections/draft.tex", targetDirectory: "", projectRoot: ROOT });
  });

  it("drops onto the exact segment of a flattened directory", async () => {
    const snapshot = projectSnapshot({ files: [...fileNodes("main.tex", "draft.tex"), dirNode("sections", [dirNode("sections/drafts")])] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: "sections/draft.tex" });
    const source = await findProjectTreeItem("draft.tex");
    dragTreeItem(source, await findInProjectTree('[data-item-flattened-subitem="sections/"]'));
    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
  });

  it("reveals project files and imported papers in Finder from the context menu", async () => {
    renderApp({ ...projectCommands(), list_papers: () => [attentionPaper()] });
    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));
    await switchSidebarMode("Papers");
    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/.research/papers/1706.03762/paper.md"));
  });

  it("imports image files into the figures directory", async () => {
    vi.mocked(open).mockResolvedValue(["/tmp/result.png"]);
    renderApp({ ...refreshableProject(projectSnapshot({ files: [dirNode("figures")] })), import_project_assets: () => ["figures/result.png"] });
    fireEvent.contextMenu(await findProjectTreeItem("figures/"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import images here" }));
    await expectInvoked("import_project_assets", { paths: ["/tmp/result.png"], targetDirectory: "figures", projectRoot: ROOT });
  });

  it("opens a project source file when it is dropped onto the editor", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "references.bib") })),
      read_project_file: readFiles({ "references.bib": BIB_SOURCE }),
    });
    const editorContent = await findElement(".source-editor .cm-content");
    stubCanvasRect(200, 40, 800, 600);
    stubElementFromPoint(editorContent);
    const bibliography = await findProjectTreeItem("references.bib");
    const pointer = { clientY: 300, pointerId: 41, pointerType: "mouse" };
    const dropZone = () => document.querySelector(".editor-tab-split-drop-preview");
    fireEvent.pointerDown(bibliography, { ...pointer, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { ...pointer, clientX: 250 });
    expect(projectTreeRoot()?.querySelector('[data-lattice-pointer-drag-preview="true"]')).not.toBeNull();
    expect(document.querySelector(".source-editor")).toHaveClass("file-drop-active");
    expect(dropZone()).toHaveAttribute("data-drop-zone", "left");
    fireEvent.pointerMove(window, { ...pointer, clientX: 600 });
    expect(dropZone()).toHaveAttribute("data-drop-zone", "center");
    fireEvent.pointerMove(window, { ...pointer, clientX: 850 });
    expect(dropZone()).toHaveAttribute("data-drop-zone", "right");
    fireEvent.pointerUp(window, { ...pointer, clientX: 850 });
    await expectInvoked("read_project_file", { path: "references.bib", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /references\.bib/ })).toHaveAttribute("aria-selected", "true");
    const bibliographyEditor = editorViewAt(".source-editor[data-editor-pane='secondary'] .cm-editor");
    expect(syntaxTree(bibliographyEditor.state).toString()).toContain("Entry(EntryType");
    expect(document.querySelector(".source-editor")).not.toHaveClass("file-drop-active");
    expect(dropZone()).toBeNull();
  });

  it("opens a dropped project file in the editor pane under the pointer", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "draft.tex", "references.bib") })),
      read_project_file: readFiles({ "draft.tex": "\\section{Draft}", "references.bib": BIB_SOURCE }),
    });
    await openTreeFile("draft.tex");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    selectDocumentView("Edit");
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Dual source view/ }));
    const secondaryEditor = await findElement(".source-editor[data-editor-pane='secondary']");
    const secondaryContent = secondaryEditor.querySelector<HTMLElement>(".cm-content")!;
    stubRect(document.querySelector<HTMLElement>(".dual-canvas")!, 0, 0, 1000, 700);
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize dual source panes" }), { clientX: 460 });
    fireEvent.pointerMove(window, { clientX: 700 });
    fireEvent.pointerUp(window, { clientX: 700 });
    const expectSeventyThirty = () => {
      expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.7");
      expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns).toContain("0.7fr");
    };
    expectSeventyThirty();
    stubCanvasRect(0, 0, 1000, 700);
    stubElementFromPoint(secondaryContent);

    dragToPoint(await findProjectTreeItem("references.bib"), [850, 100], {
      pointerId: 42, whileOver: () => expect(secondaryEditor).toHaveClass("file-drop-active"),
    });

    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("@article{lattice"));
    expectSeventyThirty();
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    const paneText = (pane: "primary" | "secondary") => editorViewAt(`.source-editor[data-editor-pane='${pane}'] .cm-editor`)
      .state.doc.toString();
    expect(paneText("primary")).toContain("\\documentclass{article}");

    dragToPoint(await findProjectTreeItem("draft.tex"), [100, 100], { pointerId: 43 });
    await waitFor(() => {
      expect(paneText("primary")).toContain("\\section{Draft}");
      expect(paneText("secondary")).toContain("@article{lattice");
      expect(document.querySelectorAll(".dual-canvas .source-editor[data-editor-pane]")).toHaveLength(2);
    });

    dragToPoint(await findProjectTreeItem("main.tex"), [500, 100], { pointerId: 44 });
    await waitFor(() => {
      expect(document.querySelector(".dual-canvas")).toBeNull();
      expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("imports a Finder source file into the project before opening it", async () => {
    const beforeImport = projectSnapshot();
    const afterImport = { ...beforeImport, files: [...beforeImport.files, fileNode("method.tex")] };
    let imported = false;
    renderApp({
      ...projectCommands(beforeImport), refresh_project: () => imported ? afterImport : beforeImport,
      import_project_sources: () => {
        imported = true;
        return ["method.tex"];
      },
      read_project_file: readFiles({ "method.tex": "\\section{Method}" }),
    });
    stubElementFromPoint(await findElement(".source-editor .cm-content"));
    await dropFinderPaths(["/tmp/method.tex"]);
    await expectInvoked("import_project_sources", { paths: ["/tmp/method.tex"], targetDirectory: "", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /method\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(await findProjectTreeItem("method.tex")).toBeInTheDocument();
  });

  it("imports and opens a Finder asset dropped onto an asset preview", async () => {
    renderApp({
      ...refreshableProject(projectSnapshot({ files: [dirNode("figures", [fileNode("figures/existing.svg")]), fileNode("main.tex")] })),
      read_project_asset: (args) => {
        const path = argPath(args);
        const png = path.endsWith(".png");
        return { path, mimeType: png ? "image/png" : "image/svg+xml", base64: png ? "iVBORw0KGgo=" : "PHN2Zy8+" };
      },
      import_project_assets: () => ["figures/new.png"], build_project: buildResult(),
    });
    fireEvent.click(await findProjectTreeItem("figures/"));
    fireEvent.click(await findProjectTreeItem("figures/existing.svg"));
    const preview = await screen.findByAltText("Preview of figures/existing.svg");
    const zoomPercentage = screen.getByLabelText("Image zoom percentage");
    expect(zoomPercentage).toHaveValue("100");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomPercentage).toHaveValue("110");
    expect(preview).toHaveStyle({ zoom: "1.1" });
    fireEvent.change(zoomPercentage, { target: { value: "999" } });
    fireEvent.blur(zoomPercentage);
    expect(zoomPercentage).toHaveValue("500");
    expect(preview).toHaveStyle({ zoom: "5" });
    stubElementFromPoint(preview);
    await dropFinderPaths(["/tmp/new.png"]);

    await expectInvoked("import_project_assets", { paths: ["/tmp/new.png"], targetDirectory: "figures", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /new\.png/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByAltText("Preview of figures/new.png")).toHaveStyle({ zoom: "1" });
    expect(screen.getByLabelText("Image zoom percentage")).toHaveValue("100");
    expect(invoke).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());
  });

  it("relays image and PDF drops on the agent panel into the composer", async () => {
    renderApp({
      ...projectCommands(),
      read_agent_composer_files: () => [
        { name: "plot.png", mimeType: "image/png", bytesBase64: btoa("png-bytes") },
        { name: "notes.md", mimeType: "text/markdown", bytesBase64: btoa("# Notes") },
      ],
    });
    const { frame, postMessage } = await openAgentFrame({ ready: true });
    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    stubElementFromPoint(frame);
    // A mixed figure + text-source drop: both are agent-readable, so the
    // panel takes precedence over the project source/mixed branches.
    await dropFinderPaths(["/tmp/plot.png", "/tmp/notes.md"]);

    await expectInvoked("read_agent_composer_files", { paths: ["/tmp/plot.png", "/tmp/notes.md"] });
    type ComposerFiles = { version?: number; files?: { name: string; mimeType: string; bytes: ArrayBuffer }[] };
    const message = await waitFor(() => {
      const [posted] = postedOfType<ComposerFiles>(postMessage, "lattice:composer-files");
      expect(posted).toBeDefined();
      return posted;
    });
    expect(message.version).toBe(1);
    expect(message.files?.map(({ name, mimeType, bytes }) => [name, mimeType, new TextDecoder().decode(bytes)])).toEqual([
      ["plot.png", "image/png", "png-bytes"], ["notes.md", "text/markdown", "# Notes"],
    ]);
    expect(invoke).not.toHaveBeenCalledWith("import_project_assets", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("import_project_sources", expect.anything());
  });

  it("duplicates a project file with Command-C/V and shows the new tree entry", async () => {
    const snapshot = projectSnapshot();
    vi.mocked(readText).mockResolvedValue("/tmp/lattice-paper/main.tex");
    renderApp({
      ...projectCommands(null), initial_project: () => structuredClone(snapshot), refresh_project: () => structuredClone(snapshot),
      import_project_files: () => {
        snapshot.files.push(fileNode("main-2.tex"));
        return [{ path: "main-2.tex", kind: "text" }];
      },
    });
    fireEvent.click(await findProjectTreeItem("main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "v", metaKey: true });
    await expectInvoked("import_project_files", {
      paths: ["/tmp/lattice-paper/main.tex"], targetDirectory: "", projectRoot: ROOT, copyExisting: true,
    });
    expect(await findProjectTreeItem("main-2.tex")).toBeInTheDocument();
    expect(queryProjectTreeItem("main.tex")).not.toBeNull();
  });

  it.each<[string, string, string[], Array<{ path: string; kind: string }>]>([
    [
      "imports a Finder image into the folder of the file it is dropped on", "sections",
      ["/tmp/plot.png"], [{ path: "sections/plot.png", kind: "binary" }],
    ],
    [
      // Markdown + a data file the old classifier rejected + an image + a
      // folder, all in one drop: the tree takes any mix.
      "imports a mixed Finder file and folder drop where it lands without opening files", "sections",
      ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png", "/tmp/tables"],
      [
        { path: "sections/notes.md", kind: "text" }, { path: "sections/data.csv", kind: "text" },
        { path: "sections/plot.png", kind: "binary" }, { path: "sections/tables/results.csv", kind: "text" },
      ],
    ],
    [
      "imports a Finder image dropped on the Project pane background into the project root", "",
      ["/tmp/plot.png"], [{ path: "plot.png", kind: "binary" }],
    ],
  ])("%s", async (_name, targetDirectory, paths, imported) => {
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), dirNode("sections", [fileNode("sections/intro.tex")])] });
    renderApp({ ...refreshableProject(snapshot), import_project_files: () => imported });
    if (targetDirectory) {
      fireEvent.click(await findProjectTreeItem("sections/"));
      stubElementFromPoint(await findProjectTreeItem("sections/intro.tex"));
    } else {
      await findProjectTreeItem("main.tex");
      stubElementFromPoint(await findElement(".project-section"));
    }
    await dropFinderPaths(paths);

    await expectInvoked("import_project_files", { paths, targetDirectory, projectRoot: ROOT });
    // Filing into the tree does not open the file; editor drops do that.
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "sections/notes.md" }));
  });

  it.each([false, true])("uploads external file bytes only in an ordinary browser (bundled: %s)", async (bundled) => {
    Object.assign(browserRuntime, { hosted: true, bundled });
    const snapshot = () => projectSnapshot({ name: "Paper", rootDocuments: MAIN_DOCUMENT, files: [fileNode("main.tex"), dirNode("sections")] });
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, import_project_files: () => [{ path: "sections/notes.md", kind: "text" }],
    });
    const row = await findProjectTreeItem("sections/");
    stubElementFromPoint(row);
    const file = new File(["hello"], "notes.md");
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("hello").buffer });
    const drop = new MouseEvent("drop", { bubbles: true, composed: true, cancelable: true, clientX: 90, clientY: 120 });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file], items: [], getData: () => "" } });
    fireEvent(row, drop);
    if (bundled) {
      expect(drop.defaultPrevented).toBe(false);
      expect(invoke).not.toHaveBeenCalledWith("import_project_files", expect.anything());
      return;
    }
    await expectInvoked("import_project_files", {
      paths: [], targetDirectory: "sections", projectRoot: ROOT, uploads: [{ name: "notes.md", base64: "aGVsbG8=" }],
    });
    expect(drop.defaultPrevented).toBe(true);
  });

  it.each([false, true])("keeps text-classified SVG tabs as images after switching files (bottom assistant: %s)", async (bottomAssistant) => {
    const snapshot = projectSnapshot({
      files: [
        fileNode("main.tex"),
        // Some scanners classify SVG as text. Opening is extension-based,
        // so Quick Open must still route it to the image preview.
        dirNode("figures", [fileNode("figures/diagram.svg", "text", { contentKind: "text" })]),
        { ...dirNode("empty"), contentKind: "directory" },
      ],
    });
    if (bottomAssistant) {
      await import("./app/app-agent-panel");
      showAgentSidebar();
    }
    renderApp({
      ...refreshableProject(snapshot),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/svg+xml", base64: "PHN2Zy8+" }),
    });
    await screen.findByRole("tab", { name: /main\.tex/ });
    if (bottomAssistant) {
      fireEvent.click(await screen.findByRole("button", { name: "Move assistant below editor" }));
      expect(document.querySelector(".agent-dock-header")).not.toBeNull();
    }
    fireEvent.keyDown(window, { key: "p", metaKey: true });

    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: "figures" })).toBeNull();
    expect(within(list).queryByRole("option", { name: "empty" })).toBeNull();
    fireEvent.click(within(list).getByRole("option", { name: "figures/diagram.svg" }));

    const svgReadAsText = expect.objectContaining({ path: "figures/diagram.svg" });
    expect(await screen.findByAltText("Preview of figures/diagram.svg")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/diagram.svg" });
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", svgReadAsText);

    fireEvent.click(screen.getByRole("tab", { name: /main\.tex/ }));
    await waitFor(() => expect(screen.queryByAltText("Preview of figures/diagram.svg")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /diagram\.svg/ }));
    expect(await screen.findByAltText("Preview of figures/diagram.svg")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", svgReadAsText);
    if (bottomAssistant) expect(document.querySelector(".agent-dock-header")).not.toBeNull();
  });

  it("previews SVG and PDF figures and lets their drops replace split panes", async () => {
    const pdf = pdfDocumentStub(1, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    });
    mockPdfDocument(() => pdf);
    renderApp({
      ...refreshableProject(projectSnapshot({
        files: [
          dirNode("figures", fileNodes("figures/native-umm.svg", "figures/result.pdf")), fileNode("main.tex"), fileNode("method.md", "text"),
        ],
      })),
      read_project_file: readFiles({ "method.md": "# Method" }, "\\documentclass{article}\n\\begin{document}\n\\end{document}"),
      read_project_asset: (args) => {
        const path = argPath(args);
        return path.endsWith(".pdf")
          ? { path, mimeType: "application/pdf", base64: "JVBERi0xLjQ=" }
          : { path, mimeType: "image/svg+xml", base64: "PHN2Zy8+" };
      },
      prepare_latex_figure: "figures/native-umm-converted.pdf", write_project_file: undefined,
      build_project: buildResult(),
    });
    expect(queryProjectTreeItem("figures/native-umm.svg")).toBeNull();
    fireEvent.click(await findProjectTreeItem("figures/"));
    expect(await findProjectTreeItem("figures/native-umm.svg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    const svgRow = await findProjectTreeItem("figures/native-umm.svg");
    const at10 = { pointerType: "mouse", clientX: 10, clientY: 10 };
    expect(fireEvent.pointerDown(svgRow, { ...at10, button: 0, pointerId: 1 })).toBe(true);
    fireEvent.pointerUp(window, { ...at10, pointerId: 1 });
    fireEvent.click(svgRow);
    expect(await screen.findByAltText("Preview of figures/native-umm.svg")).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zy8+");
    const assetTab = screen.getByRole("tab", { name: /native-umm\.svg/ });
    expect(assetTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("figures/native-umm.svg").length).toBeGreaterThanOrEqual(1);
    expect(await findProjectTreeItem("figures/native-umm.svg")).toHaveAttribute("data-item-selected", "true");
    expect(await findProjectTreeItem("main.tex")).not.toHaveAttribute("data-item-selected", "true");

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(assetTab).toHaveAttribute("aria-selected", "false"));
    fireEvent.click(assetTab);
    expect(await screen.findByAltText("Preview of figures/native-umm.svg")).toBeInTheDocument();

    const pdfRow = await findProjectTreeItem("figures/result.pdf");
    stubCanvasRect(0, 0, 1000, 700);
    stubElementFromPoint(screen.getByAltText("Preview of figures/native-umm.svg"));
    const at100 = { pointerType: "mouse", clientX: 100, clientY: 100 };
    expect(fireEvent.pointerDown(pdfRow, { ...at10, button: 0, pointerId: 2 })).toBe(true);
    fireEvent.pointerMove(window, { ...at100, pointerId: 2 });
    expect(document.querySelector(".figure-drag-ghost")).toBeInTheDocument();
    fireEvent.pointerUp(window, { ...at100, pointerId: 2 });
    expect(await screen.findByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({ disableFontFace: true, useSystemFonts: false }));
    expect(screen.queryByLabelText("Show document outline")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();
    expect(await screen.findByRole("separator", { name: "Resize dual source panes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /main\.tex/ }));
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    stubElementFromPoint(document.querySelector<HTMLElement>(".cm-content")!);
    fireEvent.pointerDown(await findProjectTreeItem("figures/native-umm.svg"), { ...at10, button: 0 });
    fireEvent.pointerMove(window, at100);
    expect(document.querySelector(".figure-drag-ghost")).toHaveTextContent("native-umm.svg");
    expect(document.querySelector(".editor-tab-split-drop-preview")).toHaveAttribute("data-drop-zone", "left");
    fireEvent.pointerUp(window, at100);
    await waitFor(() => expect(assetTab).toHaveAttribute("aria-selected", "true"));
    expect(paneContent("secondary")).toHaveTextContent("\\documentclass{article}");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());
  });

  it("renders every PDF page in one continuous themed reader", async () => {
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const renderPdfPage = vi.fn(() => renderTask);
    const getPdfPageText = vi.fn(async () => ({ items: [{ str: "Attention is all you need" }] }));
    const pdf = pdfDocumentStub(2, {
      render: renderPdfPage,
      getTextContent: getPdfPageText,
      getAnnotations: async () => [{ id: "link-1", subtype: "Link", rect: [10, 20, 80, 40], url: "https://example.com/paper" }],
    });
    mockPdfDocument(() => pdf);
    let pdfUrlSequence = 0;
    stubObjectUrls(() => `blob:lattice-pdf-${++pdfUrlSequence}`);
    vi.mocked(save).mockResolvedValue("/tmp/exported-paper.pdf");
    let forwardSyncFailure: string | null = null;
    let reverseSyncTarget: { path: string; line: number } = { path: "main.tex", line: 1 };
    let delayForwardSync = false;
    let resolveForwardSync!: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
    renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), build_project: buildResult({ hasPdf: true, durationMs: 100 }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      save_compiled_pdf: "/tmp/exported-paper.pdf", synctex_edit: () => reverseSyncTarget,
      synctex_view: (args) => {
        const syncArgs = args as Record<string, unknown> | undefined;
        if (delayForwardSync && syncArgs?.path === "main.tex") {
          delayForwardSync = false;
          return new Promise((resolve) => { resolveForwardSync = resolve; });
        }
        if (forwardSyncFailure && syncArgs?.path === "main.tex" && syncArgs?.line === 1) throw new Error(forwardSyncFailure);
        return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      },
    });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
    await expectInvoked("read_compiled_pdf", { projectRoot: ROOT });
    // The production PDF viewer is a heavy lazy chunk. Let Vitest transform it
    // before asserting on PDFSlick's document source.
    await waitFor(() => expect(document.querySelector(".pdf-preview")).not.toBeNull(), { timeout: 30_000 });
    await waitFor(() => expect(pdfSlickTestApi.sources.map((source) => (
      typeof source === "string" ? source : `${source.constructor.name}:${source.byteLength}`
    ))).toContain("ArrayBuffer:8"), { timeout: 5_000 });
    const savePdf = await screen.findByRole("button", { name: "Save PDF as…" });
    expect(document.querySelector(".pdf-scroll-area [data-slot='scroll-area-viewport']")).not.toHaveClass("scroll-fade-both");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("PDF page 2")).toBeInTheDocument();
    // PDFSlick owns the virtualized render queue and paints each visible page
    // directly at its output scale rather than replacing a blurry preview.
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalledTimes(2));
    expect(renderTask.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".pdf-text-layer span")).toHaveTextContent("Attention is all you need"));
    expect(getPdfPageText).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTitle("https://example.com/paper").length).toBeGreaterThan(0));
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2));
    for (const name of ["Zoom out", "Zoom in"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    const fitWidth = screen.getByRole("button", { name: "Fit page to width" });
    const fitHeight = screen.getByRole("button", { name: "Fit page to height" });
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(fitHeight);
    expect(fitWidth).toHaveAttribute("aria-pressed", "false");
    expect(fitHeight).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(localStorage.getItem("lattice.pdf-view-preference.v1")).toContain('"fitMode":"height"'));
    fireEvent.click(fitHeight);
    expect(fitHeight).toHaveAttribute("aria-pressed", "false");
    const pageInput = screen.getByLabelText("PDF page number");
    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "2" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });
    expect(pageInput).toHaveValue("2");
    const searchInput = screen.getByLabelText("Search PDF");
    const searchIcon = () => searchInput.closest(".pdf-search")!.querySelector(":scope > svg");
    expect(searchIcon()).not.toBeNull();
    fireEvent.change(searchInput, { target: { value: "attention" } });
    expect(searchIcon()).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(getPdfPageText).not.toHaveBeenCalled();
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next search result" }));
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll(".pdf-text-layer .highlight").length).toBe(2);
      expect(document.querySelectorAll(".pdf-text-layer .highlight.selected").length).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear PDF search" }));
    expect(searchInput).toHaveValue("");
    expect(searchIcon()).not.toBeNull();
    const revealCursor = screen.getByRole("button", { name: /Reveal cursor in PDF/i });
    const pdfZoomControls = fitWidth.closest(".pdf-zoom-controls");
    expect(pdfZoomControls).toContainElement(revealCursor);
    expect(pdfZoomControls?.querySelectorAll(".pdf-fit-divider")).toHaveLength(2);
    const pdfButtons = Array.from(pdfZoomControls!.querySelectorAll<HTMLElement>("button"));
    expect(pdfButtons.indexOf(revealCursor)).toBeLessThan(pdfButtons.indexOf(fitWidth));
    const editorView = editorViewAt(".source-editor .cm-editor");
    let revealReconfigurations = 0;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          revealReconfigurations += transaction.effects.filter((effect) => effect.is(StateEffect.reconfigure)).length;
        }
      })),
    });
    expect(fireEvent.mouseDown(revealCursor)).toBe(false);
    delayForwardSync = true;
    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 1, column: 0 });
    editorView.dispatch({ selection: { anchor: 5 } });
    resolveForwardSync({ page: 1, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    expect(screen.queryByLabelText("Source location in PDF")).not.toBeInTheDocument();

    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 1, column: 5 });
    expect(await screen.findByLabelText("Source location in PDF")).toBeInTheDocument();
    expect(revealReconfigurations).toBe(0);
    await waitFor(() => expect(revealCursor).toBeEnabled());
    forwardSyncFailure = "This bibliography entry is not included in the compiled PDF.";
    fireEvent.click(revealCursor);
    // A failed reverse-sync is a warning, not an error: the click did nothing,
    // but nothing broke either. `app-log.test.tsx` covers how it is drawn.
    await expectNotification(new RegExp(`\\[WARNING\\].*\\n?.*${forwardSyncFailure.replace(/[.]/g, "\\.")}`));
    expect(formatAppLogs()).not.toMatch(/\[ERROR\]/);
    expect(revealReconfigurations).toBe(0);
    forwardSyncFailure = null;
    const zoomInput = screen.getByLabelText("PDF zoom percentage") as HTMLInputElement;
    fireEvent.click(fitWidth);
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    const fitZoom = Number(zoomInput.value);
    fireEvent.wheel(zoomInput.parentElement!, { deltaY: -1 });
    expect(zoomInput).toHaveValue(String(fitZoom + 10));
    expect(fitWidth).toHaveAttribute("aria-pressed", "false");
    const zoomBefore = Number(zoomInput.value);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomInput).toHaveValue(String(zoomBefore + 10));
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    interfaceSounds.play.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
    // Identical PDF bytes must not thrash pdf.js — keep the same document + zoom.
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
    expect(zoomInput).toHaveValue(String(zoomBefore + 10));
    fireEvent.click(savePdf);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "paper.pdf" })));
    await expectInvoked("save_compiled_pdf", expect.objectContaining({ byteLength: 8 }), {
      headers: { "x-pdf-destination": "L3RtcC9leHBvcnRlZC1wYXBlci5wZGY=" },
    });
    await expectNotification(/Saved to \/tmp\/exported-paper\.pdf/);
    // Double-click (not single click) jumps from the PDF back to the source.
    fireEvent.doubleClick(screen.getByLabelText("PDF page 1"), { clientX: 110, clientY: 220 });
    await expectInvoked("synctex_edit", { page: 1, x: 91.667, y: 183.333 });
    // A citation resolves into the bibliography, which has no preview of its
    // own. The jump must not close the PDF it was made from.
    reverseSyncTarget = { path: "references.bib", line: 4 };
    fireEvent.doubleClick(screen.getByLabelText("PDF page 1"), { clientX: 110, clientY: 220 });
    await expectInvoked("read_project_file", { path: "references.bib", projectRoot: ROOT });
    // Still the same viewer instance, at the page the jump was made from: the
    // preview column follows the project's build, not the file in the editor.
    expect(screen.getByLabelText("PDF page 1")).toBeInTheDocument();
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);

    // An included TeX file is also part of this build, not a new PDF. The first
    // reverse jump must move the editor without resetting the reader's place.
    const pageBeforeJump = screen.getByLabelText("PDF page 2");
    const viewportBeforeJump = pageBeforeJump.closest<HTMLElement>(".pdf-scroll-area-viewport")!;
    viewportBeforeJump.scrollTop = 950;
    reverseSyncTarget = { path: "chapters/results.tex", line: 1 };
    fireEvent.doubleClick(pageBeforeJump, { clientX: 110, clientY: 220 });
    await waitForSelectedTab("results.tex");
    expect(screen.getByLabelText("PDF page 2")).toBe(pageBeforeJump);
    expect(viewportBeforeJump.scrollTop).toBe(950);
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
  });

  it("jumps out of a dual-pane preview into the pane that still holds an editor", async () => {
    persistLayout(ROOT, {
      openTabs: ["main.tex", "chapter.tex"], activeFile: "main.tex", secondaryFile: "chapter.tex", canvasMode: "source",
      tabRecency: ["chapter.tex", "main.tex"],
    });
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const pdf = pdfDocumentStub(1, { render: vi.fn(() => renderTask), getTextContent: async () => ({ items: [] }) });
    mockPdfDocument(() => pdf);
    stubObjectUrls(() => "blob:lattice-dual-pdf");
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "chapter.tex") })), read_project_file: readPathContent,
      build_project: buildResult({ hasPdf: true, durationMs: 1, rootDocument: "main.tex" }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      synctex_edit: () => ({ path: "chapter.tex", line: 2 }),
      synctex_view: () => ({ page: 1, x: 72, y: 96, width: 120, height: 14 }),
    });
    // Two editors side by side, then turn one of them into the PDF preview.
    fireEvent.click(await screen.findByRole("button", { name: "Split editor right" }));
    await waitFor(() => expect(paneContent("secondary")).toHaveTextContent("content:chapter.tex"));
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Preview");
    const pdfPage = await screen.findByLabelText("PDF page 1");
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();

    fireEvent.doubleClick(pdfPage, { clientX: 110, clientY: 220 });
    // The double-click is live here: the other pane is an editor to land in.
    await expectInvoked("synctex_edit", expect.objectContaining({ page: 1 }));
    // And the layout the reader arranged survives the jump.
    expect(document.querySelector(".dual-canvas")).toBeInTheDocument();
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();
    expect(document.querySelector(".source-editor")).toBeInTheDocument();
  });

  it.each([
    { docked: true, sidebarOpen: false }, { docked: true, sidebarOpen: true }, { docked: false, sidebarOpen: false },
  ])("opens a compile repair in the existing Agent placement ($docked, sidebar $sidebarOpen)", async ({ docked, sidebarOpen }) => {
    await Promise.all([import("./build/compile-diagnostics-panel"), import("./canvas/document-canvas"), import("./app/app-agent-panel")]);
    localStorage.setItem("lattice.agent-docked.v1", docked ? "1" : "0");
    localStorage.setItem("lattice.sidebar-open.v1", sidebarOpen ? "1" : "0");
    localStorage.setItem("lattice.sidebar-mode.v1", "project");
    renderApp({
      ...projectCommands(projectSnapshot({
        root: "/tmp/repair-placement", projectId: "repair-placement", name: "Repair placement", rootDocuments: MAIN_DOCUMENT,
      })),
      build_project: buildResult({
        durationMs: 1, rootDocument: "main.tex",
        diagnostics: [{ file: "main.tex", line: 1, level: "warning", message: "Undefined reference." }],
      }),
      compile_repair: (args) => (args as { action: string }).action === "start"
        ? { threadId: "repair-placement-task" } : { status: "running" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 warning/i }));
    const originalFrame = document.querySelector('iframe[title="Agent"]');
    fireEvent.click(await screen.findByRole("button", { name: "Fix all" }));
    fireEvent.click(await screen.findByRole("button", { name: "View repair" }));
    await waitFor(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(frame).not.toBeNull();
      expect(new URL(frame!.src).pathname).toBe("/repair-placement-task");
      expect(frame!.closest(".agent-panel-surface")).toHaveAttribute("aria-hidden", "false");
      if (docked) expect(frame).toBe(originalFrame);
    });
    expect(Boolean(document.querySelector(".agent-dock-header"))).toBe(docked);
    expect(document.querySelector(".workspace")?.classList.contains("sidebar-hidden")).toBe(docked && !sidebarOpen);
    expect(localStorage.getItem("lattice.sidebar-mode.v1")).toBe(docked ? "project" : "agent");
  });

  it("repairs all compile errors and warnings with panel permissions and reloads before recompiling", async () => {
    await import("./build/compile-diagnostics-panel");
    await import("./canvas/document-canvas");
    let repaired = false;
    const warning = { file: "main.tex", line: 3, level: "warning", message: "Reference `old-label' undefined." };
    const error = { file: "main.tex", line: 9, level: "error", message: "Undefined control sequence." };
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-repair", projectId: "repair-paper", name: "Repair paper", rootDocuments: MAIN_DOCUMENT,
    });
    renderApp({
      ...refreshableProject(snapshot),
      read_project_file: () => `\\documentclass{article}\n\\begin{document}\n${repaired ? "Fixed reference" : "\\ref{old-label}"}\n\\end{document}`,
      build_project: () => buildResult({
        durationMs: 10, rootDocument: "main.tex", log: repaired ? "" : warning.message, diagnostics: repaired ? [] : [warning, error],
      })(),
      compile_repair: (args) => {
        if ((args as { action: string }).action === "start") return { threadId: "repair-task" };
        repaired = true;
        return { status: "completed" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 warning/i }));
    const fix = await screen.findByRole("button", { name: "Fix all" });
    await waitFor(() => expect(fix).toBeEnabled());
    const previousBuilds = invokeCalls("build_project").length;
    fireEvent.click(fix);
    await expectInvoked("compile_repair", {
      action: "start", projectRoot: snapshot.root, rootDocument: "main.tex", diagnostics: [warning, error], runtimeMode: "full-access",
    });
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(previousBuilds + 1));
    await waitFor(() => expect(screen.getByText("Repair finished")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".cm-content")).toHaveTextContent("Fixed reference"));
    expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
  });

  it("lists successful-build diagnostics and jumps to the reported source line", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: [fileNode("main.tex"), dirNode("chapters", [fileNode("chapters/intro.tex")])] })),
      read_project_file: readFiles({
        "main.tex": "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
        "chapters/intro.tex": "\\section{Intro}\none\ntwo\nthree\nfour\n",
      }, ""),
      build_project: buildResult({
        log: "chapters/intro.tex:4: Overfull hbox.\n", durationMs: 80,
        diagnostics: [{ file: "/tmp/lattice-paper/./chapters/intro.tex", line: 4, level: "warning", message: "Overfull hbox." }],
      }),
    });
    const diagnosticsPanel = await screen.findByLabelText("Compile diagnostics");
    expect(visibleToasts("Build")).toEqual([]);
    // Initial and autosave builds are intentionally silent.
    expect(interfaceSounds.play).not.toHaveBeenCalled();
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
    expect(visibleToasts("Build")).toEqual([]);
    expect(diagnosticsPanel.closest(".pdf-column")).toBeInTheDocument();
    expect(diagnosticsPanel.parentElement).not.toHaveClass("workspace");
    expect(screen.getByText("1 warning")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 warning/i }));
    fireEvent.click(screen.getByRole("button", { name: "Copy error message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("chapters/intro.tex:4 Overfull hbox."));
    fireEvent.click(screen.getByRole("tab", { name: /Log/i }));
    expect(screen.getByLabelText("Raw build log")).toHaveTextContent("Overfull hbox.");
    fireEvent.click(screen.getByRole("tab", { name: /Messages/i }));
    fireEvent.click(screen.getByRole("button", { name: /chapters\/intro\.tex:4/i }));
    await expectInvoked("read_project_file", { path: "chapters/intro.tex", projectRoot: ROOT });
    await waitFor(() => {
      const view = editorViewAt();
      expect(view.state.doc.toString()).toContain("\\section{Intro}");
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    });
  });

  it("keeps the caret during repeated failed autosave builds but still navigates on manual Build", async () => {
    setAutoBuildMode("automatic");
    let diskSource = "\\documentclass{article}\n\\begin{document}\n\\label{intro\nNext line\n\\end{document}\n";
    let buildCount = 0;
    renderApp({
      ...projectCommands(), read_project_file: () => diskSource,
      write_project_file: (args) => {
        diskSource = (args as { content: string }).content;
        return { content: diskSource, hadConflicts: false };
      },
      build_project: () => {
        buildCount += 1;
        return buildResult({
          success: false, log: "Runaway argument!", durationMs: 80,
          diagnostics: [{ file: "main.tex", line: 4, level: "error", message: "Runaway argument!" }],
        })();
      },
    });
    await screen.findByLabelText("Compile diagnostics");
    const view = editorViewAt();

    for (const insert of ["中文", "修改"]) {
      const previousBuilds = buildCount;
      const from = view.state.doc.line(3).to;
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from, insert }, selection: { anchor: from + insert.length }, annotations: Transaction.userEvent.of("input.type"),
        });
      });
      const expectedText = view.state.doc.toString();
      await waitFor(() => expect(buildCount).toBe(previousBuilds + 1), { timeout: 3_000 });
      await waitFor(() => expect(screen.getByRole("button", { name: "Build" })).toBeEnabled());
      // Navigation runs on an animation frame after the build result renders.
      await act(async () => { await pause(100); });
      expect(view.state.doc.toString()).toBe(expectedText);
      expect(view.state.selection.main.head).toBe(from + insert.length);
      expect(view.hasFocus).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from));
  });

  it("shows failed build guidance once and acknowledges a manual retry", async () => {
    renderApp({
      ...projectCommands(),
      build_project: failedBuild(
        "Missing style file `iclr2026_conference.sty`. It is part of the ICLR template and belongs next to main.tex — "
          + "TeX Live cannot install it. Sync or copy it back from another copy of the project.",
        "LaTeX Error: File `iclr2026_conference.sty' not found.\n",
      ),
    });
    await waitFor(() => {
      expect(visibleToasts("Build")).toHaveLength(0);
      expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
    });
    const diagnostics = await screen.findByLabelText("Compile diagnostics", {}, { timeout: 40_000 });
    expect(within(diagnostics).getByText("1 error")).toBeInTheDocument();
    expect(within(diagnostics).getByText(/Sync or copy it back from another copy/)).toBeInTheDocument();
    fireEvent.click(within(diagnostics).getByRole("button", { name: "Dismiss diagnostics" }));
    expect(screen.queryByLabelText("Compile diagnostics")).not.toBeInTheDocument();
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(visibleToasts("Build")).toHaveLength(0));
    expect(await screen.findByLabelText("Compile diagnostics")).toBeInTheDocument();
    expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
  }, 40_000);

  it("installs a missing LaTeX package in-app and rebuilds", async () => {
    await setInterfaceLanguage("zh-CN");
    const install = deferred();
    renderApp({
      ...projectCommands(), start_tex_dependency_install: () => install.promise,
      build_project: failedBuild(
        "Missing LaTeX dependency `newtxmath.sty`. BasicTeX does not include every package available on Overleaf.",
        "LaTeX Error: File `newtxmath.sty' not found.\n",
      ),
    });
    const diagnostics = await screen.findByLabelText("Compile diagnostics");
    fireEvent.click(within(diagnostics).getByRole("button", { name: "Install" }));
    await expectInvoked("start_tex_dependency_install",
      expect.objectContaining({ missingFile: "newtxmath.sty", onProgress: expect.anything() }));
    expect(screen.getByRole("dialog", { name: "安装缺失的软件包" })).toBeInTheDocument();
    act(() => {
      tauriCoreApi.channel?.onmessage?.({ stage: "installing-dependency", progress: 0.64 });
    });
    expect(screen.getByRole("progressbar", { name: "LaTeX 软件包安装进度" })).toHaveAttribute("aria-valuenow", "64");
    const buildCallsBeforeInstall = invokeCalls("build_project").length;
    await act(async () => install.resolve());
    await waitFor(() => expect(invokeCalls("build_project").length).toBeGreaterThan(buildCallsBeforeInstall));
    expect(screen.queryByRole("dialog", { name: "安装缺失的软件包" })).not.toBeInTheDocument();
    expect(formatAppLogs()).toContain("[SUCCESS] [LaTeX 配置] LaTeX 软件包已安装");
  });

  it("does not open TeX setup when latexmk reports a missing project style", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ name: "CVPR paper" }), "\\usepackage[review]{cvpr}"),
      build_project: failedBuild(
        "Missing style file `cvpr.sty`. It is part of the CVPR template and belongs next to main.tex — TeX Live cannot install it.",
        "Latexmk: Missing input file 'cvpr.sty' message in .log file:\nLaTeX Error: File `cvpr.sty' not found.\n",
      ),
    });
    await waitFor(() => expect(formatAppLogs()).toContain("Missing style file `cvpr.sty`"));
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();
  });

  it.each([
    ["saves dirty buffers before switching project files", false],
    ["does not make file switching wait for post-save project scans", true],
  ] as const)("%s", async (_name, holdScans) => {
    setAutoBuildMode("manual");
    const files: Record<string, string> = { "main.tex": "\\documentclass{article}", "intro.tex": "\\section{Intro}" };
    let saved = false;
    const history = deferred<never[]>();
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "intro.tex") })), read_project_file: readFiles(files, ""),
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        files[path] = content;
        saved = true;
      },
      list_history: () => (holdScans && saved ? history.promise : []),
    });
    await appendToEditor("\nDraft change.");
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await expectInvoked("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nDraft change.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    });
    await expectInvoked("read_project_file", { path: "intro.tex", projectRoot: ROOT });
    await expectEditorText("\\section{Intro}");
    history.resolve([]);
  });

  it("keeps the latest file active when an earlier read resolves afterward", async () => {
    setAutoBuildMode("manual");
    const [intro, notes] = [deferred<string>(), deferred<string>()];
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "intro.tex", "notes.tex") })),
      read_project_file: readFiles({ "intro.tex": intro.promise, "notes.tex": notes.promise }, "main"),
    });
    await waitForSelectedTab("main.tex");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    fireEvent.click(await findProjectTreeItem("notes.tex"));
    await act(async () => { notes.resolve("latest notes"); });
    await waitForSelectedTab("notes.tex");
    await act(async () => { intro.resolve("stale intro"); });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /notes\.tex/ })).toHaveAttribute("aria-selected", "true");
      expect(editorViewAt().state.doc.toString()).toBe("latest notes");
    });
  });

  it.each([
    ["opens a recent project in its own window and leaves this one alone", "Overleaf paper", null, "/tmp/overleaf-paper"],
    ["gives a newly created project its own window when one is already open", "New project", "/tmp", "/tmp/new-paper"],
    ["opens a folder chosen from the picker in its own window too", "Open another folder", "/tmp/other", "/tmp/other"],
  ] as const)("%s", async (_name, menuItem, chosenFolder, path) => {
    setAutoBuildMode("manual");
    if (menuItem === "Overleaf paper") {
      localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
        { name: "Notes", path: "/tmp/notes" }, { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
      ]));
    }
    const notes = notesSnapshot();
    renderApp({
      ...projectCommands(notes, "# Private draft"), create_project: { ...notes, root: "/tmp/new-paper" },
      open_project_window: () => ({ label: "project-1", focusedExisting: false }),
    });
    await expectEditorText("# Private draft");

    vi.mocked(open).mockResolvedValue(chosenFolder);
    await chooseProjectMenuItem(menuItem);
    if (menuItem === "New project") {
      fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "New paper" } });
      fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    }

    await expectInvoked("open_project_window", { path });
    // The point of the feature: this window keeps the project and the buffer it
    // already had, rather than being taken over by the one just opened.
    expect(invoke).not.toHaveBeenCalledWith("open_project", { path });
    expect(editorViewAt().state.doc.toString()).toBe("# Private draft");
  });

  it("joins a live collaboration in the current window", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.collab.name", "Ada");
    const notes = notesSnapshot();
    const sharedSnapshot = {
      ...notes, root: "/tmp/Lattice Shares/Shared room", files: [], manifest: { ...notes.manifest, projectId: "shared-id", name: "Shared room" },
    };
    const projectInstanceId = "project_1234567890abcdef1234567890abcdef";
    const invitation = formatCollabInvitationV2({
      version: 2, deployment: "https://collab.example", projectInstanceId, guestSecret: "A".repeat(43), permission: "write",
      projectName: "Shared room",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      protocol: 2, projectInstanceId, name: "Shared room", lifecycle: "live", catalogRevision: 1, snapshotGeneration: 0,
      workspaceLeaseGeneration: 0, authorityEpoch: 1, files: [],
    }), { headers: { "content-type": "application/json" } })));
    renderApp({
      ...projectCommands(notes, "# Private draft"), put_collab_credential: undefined, create_collab_join_workspace: sharedSnapshot,
      open_project: () => { throw new Error("stop after binding the current window"); },
    });
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    await openCollaboration();
    fireEvent.click(await screen.findByRole("tab", { name: "Join" }));
    fireEvent.change(screen.getByLabelText("Collab invite"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "Join share" }));
    await expectInvoked("open_project", { path: sharedSnapshot.root });
    expect(invoke).not.toHaveBeenCalledWith("open_project_window", expect.anything());
  });

  it.each([false, true])("hides paused sharing and keeps saved rooms without autojoining (project: %s)", async (hasProject) => {
    vi.stubEnv("VITE_LATTICE_COLLAB_V2", undefined);
    const records = JSON.stringify([{
      version: 2, projectInstanceId: "project_saved_room", host: "https://collab.example",
      credentialRef: "saved-credential", permission: "host", title: "Saved room", projectRoot: "/tmp/notes", lastUsed: 1,
    }]);
    localStorage.setItem("lattice.collab.projects.v2", records);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderApp({
      ...projectCommands(null, "# Local draft"), initial_project: () => (hasProject ? notesSnapshot() : null),
      take_pending_window_action: () => JSON.stringify({
        kind: "join-collab-v2", host: "https://collab.example", projectInstanceId: "project_saved_room",
      }),
    });
    if (hasProject) {
      await expectInvoked("take_pending_window_action");
      fireEvent.keyDown(window, { key: "P", metaKey: true, shiftKey: true });
      expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
      expect(screen.queryByText("Start / join live sharing")).not.toBeInTheDocument();
    } else {
      expect(await screen.findByRole("button", { name: "Open from Overleaf" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import ZIP" })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Join share" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-tour="collaboration"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("get_collab_credential", expect.anything());
    expect(fetcher.mock.calls.filter(([input]) => String(input).includes("collab"))).toHaveLength(0);
    expect(localStorage.getItem("lattice.collab.projects.v2")).toBe(records);
  });

  it("shows share-start progress in the selected interface language", async () => {
    await setInterfaceLanguage("zh-CN");
    localStorage.setItem("lattice.collab.name", "Ada");
    const inventory = deferred<never>();
    renderApp({ ...projectCommands(notesSnapshot(), "# Private draft"), collab_project_inventory_v2: inventory.promise });
    await openCollaboration();
    // The first sharing test also loads the lazy dialog and its dependencies.
    fireEvent.click(await screen.findByRole("button", { name: "开始共享" }, { timeout: 20_000 }));
    expect(await screen.findByRole("status")).toHaveTextContent("正在扫描项目文件…");
    await act(async () => inventory.reject(new Error("stop after localized status")));
    expect(await screen.findByRole("status")).toHaveTextContent("导入失败——请重新点击“开始共享”");
    expect(await screen.findByRole("status")).toHaveTextContent("stop after localized status");
  }, 40_000);

  it("translates share exclusions before asking for confirmation", async () => {
    await setInterfaceLanguage("zh-CN");
    localStorage.setItem("lattice.collab.name", "Ada");
    renderApp({
      ...projectCommands(null, "# Private draft"), initial_project: () => notesSnapshot(),
      collab_project_inventory_v2: () => ({
        files: [],
        excluded: [
          { pathOrPattern: ".git/**", reason: "git-internals" }, { pathOrPattern: ".research/**", reason: "app-private-state" },
          { pathOrPattern: "node_modules/**", reason: "generated-directory" },
          { pathOrPattern: "linked.tex", reason: "symlink-not-followed" },
        ],
      }),
    }, { confirmations: true });
    await openCollaboration();
    fireEvent.click(await screen.findByRole("button", { name: "开始共享" }));
    const dialog = await screen.findByRole("dialog", { name: "要继续吗？" });
    for (const text of [
      "以下项目内容不会包含在此次共享中", ".git/** — Git 内部数据", ".research/** — 应用私有数据",
      "node_modules/** — 自动生成的目录", "linked.tex — 不跟随符号链接",
    ]) expect(dialog).toHaveTextContent(text);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  it("does not carry an open Markdown buffer into the next project", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: "/tmp/notes" }, { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
    ]));
    const notes = notesSnapshot();
    const overleafSnapshot = projectSnapshot({ root: "/tmp/overleaf-paper", projectId: "overleaf-id", name: "Overleaf paper" });
    let currentRoot = notes.root;
    const incomingPapers = deferred<never[]>();
    renderApp({
      ...projectCommands(notes),
      open_tutorial_project: () => {
        currentRoot = overleafSnapshot.root;
        return overleafSnapshot;
      },
      read_project_file: (args) => readFiles(currentRoot === notes.root
        ? { "draft.md": "# Private draft" } : { "main.tex": "\\documentclass{article}" }, "")(args),
      list_papers: () => currentRoot === overleafSnapshot.root ? incomingPapers.promise : [],
      write_project_file: undefined,
    });
    const initialEditor = await expectEditorText("# Private draft");
    const insertedText = "\nLocal only.";
    const savedCursor = initialEditor.state.doc.length + insertedText.length;
    initialEditor.dispatch({ changes: { from: initialEditor.state.doc.length, insert: insertedText }, selection: { anchor: savedCursor } });

    // Driven through the tutorial, which is one of the flows that still replaces the project in this window.
    // Choosing a project — from the recent list or a folder — now opens a window of its own instead, but every
    // in-place switch still runs this same save/transition/enter path.
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    await expectEditorText("");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await pause(0);
    expect(invokeCalls("write_project_file")).toEqual([["write_project_file", {
      path: "draft.md", content: "# Private draft\nLocal only.", baseContent: "# Private draft", projectRoot: "/tmp/notes",
    }]]);
    const storedViews = storedFileViews();
    expect(storedViews["/tmp/notes"]?.["draft.md"]?.text).toEqual({ cursor: savedCursor, scrollTop: 0 });
    expect(storedViews["/tmp/overleaf-paper"]?.["draft.md"]).toBeUndefined();

    incomingPapers.resolve([]);
    await expectEditorText("\\documentclass{article}");
  });

  it("does not auto-sync the next project against Overleaf when it is not linked", async () => {
    // Switching away from a linked project has one render where the new root is in but the old link state is not
    // yet cleared; auto-sync firing in that window raised "Sync failed: This project is not linked to an Overleaf
    // project." at the local project.
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Overleaf paper", path: "/tmp/overleaf-paper" }, { name: "Notes", path: "/tmp/notes" },
    ]));
    const overleafSnapshot = projectSnapshot({ root: "/tmp/overleaf-paper", projectId: "overleaf-id", name: "Overleaf paper" });
    const notes = notesSnapshot();
    let currentRoot = overleafSnapshot.root;
    renderApp({
      ...projectCommands(overleafSnapshot),
      open_tutorial_project: () => {
        currentRoot = notes.root;
        return notes;
      },
      refresh_project: () => currentRoot === overleafSnapshot.root ? overleafSnapshot : notes,
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}", "draft.md": "# Local notes" }, ""),
      write_project_file: undefined,
      ...overleafCommands({
        overleaf_link: () => {
          // The backend reads the link off the currently open project; a local project simply has no state file.
          if (currentRoot !== overleafSnapshot.root) throw new Error("This project is not linked to an Overleaf project.");
          return overleafLink({ projectId: "ol-123" });
        },
        overleaf_rt_connect: () => overleafSession({ docs: [] }),
        overleaf_status: () => overleafStatus({ email: "me@example.com", name: "Me" }),
      }),
    });
    // The linked project gets its one-time local/remote check, but neither side
    // moved, so opening it must not start a full project download.
    await expectInvoked("overleaf_probe", { projectRoot: "/tmp/overleaf-paper", checkLocal: true, live: [] });

    // The tutorial is one of the flows that still replaces the project in this
    // window; choosing a project now opens a window of its own instead.
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    await expectEditorText("# Local notes");
    // The stale-link window has passed by the time the new project renders;
    // give pending promises a beat and confirm nothing aimed at it.
    await act(async () => { await pause(0); });
    const roots = (command: string) => invokeCalls(command).map(([, args]) => (args as { projectRoot?: string } | undefined)?.projectRoot);
    expect(roots("overleaf_sync")).toEqual([]);
    expect(roots("overleaf_probe")).not.toContain("/tmp/notes");
  });

  it("shows only edit and delete actions on a Papers row", async () => {
    setAutoBuildMode("manual");
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    renderApp({ ...refreshableProject(projectSnapshot(), "See "), list_papers: () => [paper] });
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    await switchSidebarMode("Papers");
    expect(screen.queryByTitle("Insert citation for vaswani2017attention")).not.toBeInTheDocument();
    expect(await screen.findByTitle("Edit bibliography entry")).toBeInTheDocument();
    expect(await screen.findByTitle("Remove Attention Is All You Need")).toBeInTheDocument();
  });

  it("saves the visible source before checking whether a paper is still cited", async () => {
    setAutoBuildMode("manual");
    const paper = SINGLE_TRANSFORMER;
    let diskSource = "See \\cite{chen2024single}.\n";
    let sourceAtPreview = "";
    renderApp({
      ...refreshableProject(), read_project_file: (args) => argPath(args) === "main.tex" ? diskSource : "",
      write_project_file: (args) => {
        const write = args as { path: string; content: string };
        if (write.path === "main.tex") diskSource = write.content;
      },
      list_papers: () => [paper],
      remove_reference: (args) => {
        if ((args as { citationMode?: string }).citationMode === "preview") {
          sourceAtPreview = diskSource;
          return { key: paper.citationKey, removed: false, blockers: [], changedFiles: [], removedCitations: 0 };
        }
        return { key: paper.citationKey, removed: true, blockers: [], changedFiles: ["references.bib"], removedCitations: 0 };
      },
    });
    const view = await findEditorView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "The citation was removed.\n" } });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    await waitFor(() => expect(sourceAtPreview).toBe("The citation was removed.\n"));
    expect(sourceAtPreview).not.toContain("chen2024single");
  });

  it("offers cited-paper removal with and without its citation commands", async () => {
    setAutoBuildMode("manual");
    const paper = SINGLE_TRANSFORMER;
    let diskSource = "See \\cite{chen2024single}.\n";
    renderApp({
      ...refreshableProject(), read_project_file: (args) => argPath(args) === "main.tex" ? diskSource : "",
      list_papers: () => [paper],
      remove_reference: (args) => {
        const citationMode = (args as { citationMode?: string }).citationMode;
        if (citationMode === "preview") {
          return {
            key: paper.citationKey, removed: false, changedFiles: [], removedCitations: 0,
            blockers: [{ kind: "citation", symbol: paper.citationKey, role: "reference", path: "main.tex", line: 1, snippet: diskSource }],
          };
        }
        const before = diskSource;
        const removeCitations = citationMode === "remove";
        if (removeCitations) diskSource = "See .\n";
        const bibliography = { path: "references.bib", before: "@article{chen2024single}\n", after: "" };
        return {
          key: paper.citationKey, removed: true, blockers: [], transactionId: "remove-chen",
          changedFiles: removeCitations ? ["main.tex", "references.bib"] : ["references.bib"],
          removedCitations: removeCitations ? 1 : 0,
          changes: removeCitations ? [{ path: "main.tex", before, after: diskSource }, bibliography] : [bibliography],
        };
      },
    }, { confirmations: true });
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    const dialog = await screen.findByRole("dialog", { name: "Remove “A Single Transformer” from the bibliography?" });
    expect(dialog).toHaveAccessibleDescription(/cited in 1 place.*main\.tex:1.*leave them unresolved/i);
    fireEvent.click(screen.getByRole("button", { name: "Remove citations too" }));

    await expectInvoked("remove_reference", { key: "chen2024single", citationMode: "remove", projectRoot: ROOT });
    await expectEditorText("See .\n");
  });

  it("deletes a history entry without creating another one", async () => {
    let entries = [{ id: "change-1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z", files: ["main.tex"] }];
    renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), list_history: () => entries,
      get_history_entry: () => ({
        id: "change-1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z",
        changes: [{ path: "main.tex", before: "old line\n", after: "new line\n" }],
      }),
      delete_history_entry: () => { entries = []; },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Project history" }));
    // HistoryDrawer is lazy-loaded, so wait for its chunk to resolve.
    fireEvent.click(await screen.findByRole("tab", { name: "Changes" }, { timeout: 15_000 }));
    fireEvent.click(await screen.findByRole("button", { name: /Edit main\.tex/i }));
    await screen.findByLabelText("Diff for main.tex");
    fireEvent.click(await screen.findByTitle("Delete this history entry"));
    await waitFor(() => expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("delete_history_entry", { transactionId: "change-1" });
  });

  it("shows the document outline and jumps to a section", async () => {
    type SyncTarget = { page: number; x: number; y: number; width: number; height: number };
    const syncResolvers: Array<(target: SyncTarget) => void> = [];
    renderApp({
      ...projectCommands(projectSnapshot({ files: [fileNode("sections", "folder", { children: [fileNode("sections/introduction.tex")] })] })),
      read_project_file: readFiles(
        { "sections/introduction.tex": "\\subsection{Background}\ntext\n" },
        "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\input{sections/introduction}\n\\section{Results}\n\\end{document}\n",
      ),
      build_project: buildResult({ durationMs: 1 }),
      synctex_view: () => new Promise((resolve) => syncResolvers.push(resolve)),
    });
    expect(await screen.findByLabelText("Show document outline")).toBeInTheDocument();
    fireEvent.click(await screen.findByTitle("Show outline"));
    expect(await screen.findByLabelText("Document outline")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Background/i })).toBeInTheDocument();
    expect(screen.queryByText("sections/introduction.tex")).not.toBeInTheDocument();
    expect(screen.queryByText("\\input{sections/introduction.tex}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Results/i }));
    const caretLine = () => {
      const view = editorViewAt();
      return view.state.doc.lineAt(view.state.selection.main.head).number;
    };
    await waitFor(() => expect(caretLine()).toBe(5));
    const editorView = editorViewAt();
    await waitFor(() => expect(syncResolvers).toHaveLength(1));

    // Moving the caret invalidates the outstanding outline-driven SyncTeX
    // response, so it must not install a PDF navigation target.
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    editorView.dispatch({ selection: { anchor: editorView.state.doc.line(3).from } });
    const idsBeforeStaleResponse = randomUUID.mock.calls.length;
    syncResolvers[0]({ page: 1, x: 72, y: 96, width: 120, height: 14 });
    await act(async () => { await Promise.resolve(); });
    expect(randomUUID).toHaveBeenCalledTimes(idsBeforeStaleResponse);

    fireEvent.click(await screen.findByTitle("Show outline"));
    fireEvent.click(await screen.findByRole("button", { name: /Results/i }));
    await waitFor(() => expect(syncResolvers).toHaveLength(2));
    await waitFor(() => expect(caretLine()).toBe(5));
    const idsBeforeLatestResponse = randomUUID.mock.calls.length;
    syncResolvers[1]({ page: 2, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(randomUUID).toHaveBeenCalledTimes(idsBeforeLatestResponse + 1));
  });

  it("opens a rich insert palette with previews", { timeout: 20000 }, async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: [] }), "\\begin{document}\n\n\\end{document}\n"),
      build_project: buildResult({ durationMs: 1 }),
    });
    // The action is eager titlebar UI, but its palette lives in the lazy
    // document canvas. Wait for the insertion host before exercising it.
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 15_000 });
    const insertButton = { name: "Insert snippet or symbol (⌘⇧I)" };
    fireEvent.click(await screen.findByRole("button", insertButton));
    const palette = await screen.findByLabelText("Insert LaTeX snippets");
    expect(palette).toHaveClass("resizable-drawer");
    expect(within(palette).getByRole("separator", { name: "Resize right panel" })).toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: /Alpha/i })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("tab", { name: "Symbols" }));
    expect(within(palette).getByRole("tab", { name: "Symbols" })).toHaveAttribute("aria-selected", "true");
    expect(within(palette).getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");
    // The eight symbol groups share one tab and stay as headed sections inside it.
    expect(within(palette).getByRole("heading", { name: /Greek/ })).toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: /Capital omega/i })).toBeInTheDocument();
    expect(within(palette).queryByRole("button", { name: /Bulleted list/i })).not.toBeInTheDocument();

    selectDocumentView("Preview");
    await waitFor(() => {
      expect(screen.queryByRole("button", insertButton)).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Insert LaTeX snippets")).not.toBeInTheDocument();
    });

    selectDocumentView("Edit");
    expect(await screen.findByRole("button", insertButton)).toBeInTheDocument();
    expect(screen.queryByLabelText("Insert LaTeX snippets")).not.toBeInTheDocument();
  });

  it("localizes the project-file deletion confirmation", async () => {
    await setInterfaceLanguage("zh-CN");
    await import("./project/navigator");
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), fileNode("notes.tex", "text", { contentKind: "text" })] });
    renderApp(refreshableProject(snapshot), { confirmations: true });
    fireEvent.contextMenu(await findProjectTreeItem("notes.tex", 5_000));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("要从此项目中删除“notes.tex”吗？");
    expect(dialog).toHaveAccessibleDescription("此操作无法撤销");
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("localizes the imported-paper removal confirmation", async () => {
    await setInterfaceLanguage("zh-CN");
    setAutoBuildMode("manual");
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    let cited = false;
    renderApp({
      ...refreshableProject(), list_papers: () => [paper],
      remove_reference: () => ({
        key: paper.citationKey, removed: false, changedFiles: [], removedCitations: 0,
        blockers: cited ? [{ kind: "citation", symbol: paper.citationKey, role: "reference", path: "main.tex", line: 7 }] : [],
      }),
    }, { confirmations: true });
    fireEvent.click(await screen.findByRole("tab", { name: "论文" }));
    fireEvent.click(await screen.findByTitle("移除 Attention Is All You Need"));

    const dialogName = "要从参考文献中移除“Attention Is All You Need”吗？";
    const dialog = await screen.findByRole("dialog", { name: dialogName });
    expect(dialog).toHaveAccessibleDescription("已下载的论文文件将会保留");
    expect(screen.getByRole("button", { name: "移除条目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    cited = true;
    fireEvent.click(await screen.findByTitle("移除 Attention Is All You Need"));
    expect(await screen.findByRole("dialog", { name: dialogName })).toHaveAccessibleDescription(
      "此条目在 1 处被引用。 第一处位于 main.tex:7。 保留引用命令会使这些引用无法解析。 已下载的论文文件将会保留",
    );
    expect(screen.getByRole("button", { name: "同时移除引用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保留引用" })).toBeInTheDocument();
  });

  it("creates and deletes project entries and imported papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      ROOT: { "notes.tex": { text: { cursor: 8, scrollTop: 40 } } },
    }));
    const snapshot = projectSnapshot({
      rootDocuments: [
        { path: "main.tex", name: "Main paper", isDefault: true },
        // Building a standalone draft registers it here, but does not make it protected.
        { path: "notes.tex", name: "Notes", isDefault: false },
      ],
      files: fileNodes("main.tex", "notes.tex"),
    });

    await import("./project/navigator");
    renderApp({
      ...refreshableProject(snapshot, "\\section{Notes}"),
      list_papers: () => [attentionPaper({ citationKey: "vaswani2017attention" })],
      create_project_entry: (args) => {
        const entry = args as { path: string; kind: "file" | "folder" };
        return entry.kind === "file" && !entry.path.includes(".") ? `${entry.path}.tex` : entry.path;
      },
      delete_project_entry: undefined, remove_reference: () => ({ removed: true, blockers: [] }),
    });
    const projectTreeSurface = await screen.findByLabelText("Project files");
    /** Starts a new tree entry from the project context menu and returns its name input. */
    const startNewEntry = async (menuItem: "New file" | "New folder") => {
      fireEvent.contextMenu(projectTreeSurface);
      fireEvent.click(await screen.findByRole("menuitem", { name: menuItem }));
      const nameInput = await findProjectTreeRenameInput();
      expect(nameInput).toHaveValue("untitled");
      return nameInput;
    };
    const fileNameInput = await startNewEntry("New file");
    fireEvent.input(fileNameInput, { target: { value: "method" } });
    fireEvent.keyDown(fileNameInput, { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "method", kind: "file", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /method\.tex/ })).toBeInTheDocument();

    const folderNameInput = await startNewEntry("New folder");
    fireEvent.input(folderNameInput, { target: { value: "draft" } });
    fireEvent.keyDown(folderNameInput, { key: "Escape" });
    await waitFor(() => expect(projectTreeRoot()?.querySelector("[data-item-rename-input]")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "draft", kind: "folder" });
    expect(queryProjectTreeItem("draft/")).toBeNull();

    fireEvent.blur(await startNewEntry("New folder"));
    await waitFor(() => expect(queryProjectTreeItem("untitled/")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "untitled", kind: "folder" });

    fireEvent.keyDown(await startNewEntry("New file"), { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "untitled", kind: "file", projectRoot: ROOT });
    expect(await findProjectTreeItem("untitled.tex")).toBeInTheDocument();

    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();

    await openTreeFile("notes.tex");
    fireEvent.contextMenu(await findProjectTreeItem("notes.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await expectInvoked("delete_project_entry", { path: "notes.tex", projectRoot: ROOT });
    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /notes\.tex/ })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => expect(storedFileViews()[ROOT]?.["notes.tex"]).toBeUndefined());
    await switchSidebarMode("Papers");
    fireEvent.click(screen.getByTitle("Remove Attention Is All You Need"));
    await expectInvoked("remove_reference", { key: "vaswani2017attention", projectRoot: ROOT });
  });

  it.each([
    ["board", "sketch", "sketch.tldr", "board-editor-mock"],
    ["spreadsheet", "results", "results.lattice-sheet", "spreadsheet-editor-mock"],
  ])("creates a %s from the header button with an inline name", async (kind, name, path, editor) => {
    renderApp({ ...refreshableProject(projectSnapshot({ files: [fileNode("notes.tex")] }), ""), create_project_entry: (args) => argPath(args) });
    await screen.findByLabelText("Project files");
    await chooseNewDocument(`New ${kind}`);
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput).toHaveValue("untitled");
    fireEvent.input(nameInput, { target: { value: name } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await expectInvoked("create_project_entry", { path, kind: "file", projectRoot: ROOT });
    expect(await screen.findByTestId(editor)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" })).not.toBeInTheDocument();
  });

  it("creates and opens a native Open Slide presentation", { timeout: 30000 }, async () => {
    await import("./project/navigator");
    renderApp({
      ...refreshableProject(projectSnapshot(), "export default [];\n"),
      create_open_slide_deck: (args) => `slides/${(args as { deckId: string }).deckId}/index.tsx`,
    });
    await waitFor(() => expect(projectTreeRoot()).not.toBeNull(), { timeout: 15000 });
    await chooseNewDocument("New presentation");
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput.closest("[data-item-path]")).toHaveAttribute("data-item-path", "slides/untitled/");
    fireEvent.input(nameInput, { target: { value: "quarterly-review" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await expectInvoked("create_open_slide_deck", { deckId: "quarterly-review", projectRoot: ROOT });
    expect(await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15000 }))
      .toHaveAttribute("data-path", "slides/quarterly-review/index.tsx");
  });

  it("defers an active Open Slide Overleaf sync until the document is left", { timeout: 120_000 }, async () => {
    localStorage.setItem("lattice.last-file.v1", JSON.stringify({ "/tmp/lattice-slide-overleaf": "slides/native/index.tsx" }));
    const deck = "slides/native/index.tsx";
    const deckSource = "export default [{ id: 'title' }];\n";
    const editedDeckSource = "export default [{ id: 'title', title: 'Edited' }];\n";
    let probeChanged = true;
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-slide-overleaf", projectId: "slide-overleaf-id", name: "Slide Overleaf", files: fileNodes("main.tex", deck),
    });
    renderOverleafPaper({
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}\n" }, deckSource),
      write_project_file: (args) => ({ content: String((args as { content?: string } | undefined)?.content ?? ""), hadConflicts: false }),
      overleaf_link: () => overleafLink({ projectId: "ol-slide", projectName: "Slide Overleaf" }),
      overleaf_probe: () => overleafProbe({ changed: probeChanged, remoteVersion: 12 }),
      overleaf_sync: () => overleafSyncResult({ pushed: [deck] }),
      overleaf_rt_connect: () => overleafSession({ docs: [] }),
    }, { snapshot, syncMode: "live" });
    expect(await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 60_000 })).toHaveAttribute("data-path", deck);
    const diagnosticContext = { operation_id: expect.any(String), request_id: expect.any(String) };
    await expectInvoked("overleaf_probe", { projectRoot: snapshot.root, checkLocal: true, live: [deck] });
    await expectInvoked("overleaf_sync", { projectRoot: snapshot.root, live: [deck], observedRemoteVersion: 12, diagnosticContext });
    probeChanged = false;
    const syncCountBeforeMutation = invokeCalls("overleaf_sync").length;

    await act(async () => {
      await openSlideWorkspaceApi.onMutation!({ id: 17, path: deck, kind: "write", text: editedDeckSource, previousText: deckSource });
    });
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: deck, content: editedDeckSource, baseContent: deckSource, projectRoot: snapshot.root,
    });
    await act(async () => { await pause(1_200); });
    expect(invokeCalls("overleaf_sync")).toHaveLength(syncCountBeforeMutation);

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_sync", {
      projectRoot: snapshot.root, live: [], observedRemoteVersion: null, diagnosticContext,
    }), { timeout: 5000 });
  });

  it("accepts an Open Slide delete when the canonical asset is already gone", { timeout: 20000 }, async () => {
    renderApp({
      ...refreshableProject(projectSnapshot({ rootDocuments: [], files: [fileNode("slides/native/index.tsx")] }), "export default [];\n"),
      delete_project_entry: () => { throw new Error("That file or folder no longer exists."); },
      stat_project_file: () => ({ exists: false, mtimeMs: 0 }),
    });
    await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15000 });
    let operations: OpenSlideSyncOperation[] = [];
    await act(async () => {
      operations = await openSlideWorkspaceApi.onMutation!({ id: 9, path: "assets/unused.png", kind: "delete" });
    });
    expect(invoke).toHaveBeenCalledWith("delete_project_entry", { path: "assets/unused.png", projectRoot: ROOT });
    expect(invoke).toHaveBeenCalledWith("stat_project_file", { path: "assets/unused.png" });
    expect(operations).toEqual([{ path: "assets/unused.png", kind: "delete" }]);
    expect(formatAppLogs()).not.toContain("That file or folder no longer exists.");
  });

  it("lets the Agent create and open a board or spreadsheet through the host bridge", async () => {
    renderApp({ ...refreshableProject(projectSnapshot(), ""), create_project_entry: (args) => argPath(args) });
    const { frame, postMessage } = await openAgentFrame();
    const createThroughAgent = async (id: string, path: string, documentType: string) => {
      postWindowMessage(frame.contentWindow, {
        type: "synara:project-document-tool-request", version: 1, id, args: { path, documentType }, expiresAt: Date.now() + 10_000,
      });
      await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: "lattice:project-document-tool-result", id, ok: true, result: { path, documentType, opened: true },
      }), synaraHook.runtime.origin));
    };
    const unregisterBoard = registerAgentCanvasAdapter("agent-board.tldr", { execute: () => ({}) });
    await createThroughAgent("create-board", "agent-board.tldr", "board");
    expect(invoke).toHaveBeenCalledWith("create_project_entry", { path: "agent-board.tldr", kind: "file", projectRoot: ROOT });
    expect(await screen.findByTestId("board-editor-mock")).toBeInTheDocument();
    unregisterBoard();
    const spreadsheetDoc = new Y.Doc();
    const unregisterSpreadsheet = registerAgentSpreadsheetDocument("agent-data.lattice-sheet", { doc: spreadsheetDoc, canWrite: true });
    await createThroughAgent("create-spreadsheet", "agent-data.lattice-sheet", "spreadsheet");
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    unregisterSpreadsheet();
    spreadsheetDoc.destroy();
  });
});
