/**
 * The shared harness of the App integration suites in this directory: the module mocks, stubs and per-test
 * setup every suite needs, plus the render and interaction helpers they share. Each suite imports it first,
 * before anything that imports a mocked module, so its `vi.mock` calls are registered before those modules
 * load; its top-level `beforeEach`/`afterEach` then run around every test of the importing file.
 */
/* eslint-disable lingui/no-unlocalized-strings -- test-only code: the strings are the English UI the suites query by, not interface copy */
import v8 from "node:v8";
import vm from "node:vm";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EditorView } from "@codemirror/view";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { createDocument, layout as panels } from "@danfessler/trellis";
import { afterEach, beforeEach, expect, vi } from "vitest";
import App from "../App";
import { clearAppLogs, formatAppLogs, getAppLogEntry, getVisibleAppToastIds } from "../telemetry/app-log-store";
import { persistWorkspaceLayout, type WorkspaceLayout } from "../settings/app-settings";
import { activateAppLocale } from "../i18n";
import type { SynaraRuntimeInfo } from "../agent/synara-runtime";
import { ConfirmActionProvider } from "../components/ui/confirm-action-dialog";
import { openMarkdown } from "../editor/markdown/engine/markdown-document";
import { saveLayout } from "../trellis/trellis-layout";
// Keep the cold Vite transforms of these real lazy surfaces outside interaction-test deadlines; the tests
// still mount them, not doubles: the Trellis workspace every open project renders into, the visual Markdown
// editor, the file tree and paper library, the canvas and comment surfaces the comment-routing regression uses, and
// the PDF viewer source navigation needs.
import "../trellis/trellis-workspace";
import "../trellis/trellis-agent-surface";
import "../editor/markdown/engine/lattice-visual-editor";
import "../project/project-file-tree";
import "../project/paper-library";
import "../canvas/document-canvas";
import "../overleaf/overleaf-collab";
import "../editor/comments/editor-comments-panel";
import "../pdf/pdf-viewer";
import type { FileNode, ProjectManifest, ProjectSnapshot } from "../app-types";
import type { OpenSlideMutation, OpenSlideSyncOperation } from "../editor/presentation/open-slide-bridge";


const windowApi = vi.hoisted(() => ({
  label: "main", setFocus: vi.fn(async () => {}), startDragging: vi.fn(), isFullscreen: vi.fn(), setFullscreen: vi.fn(),
  setMinSize: vi.fn(), onResized: vi.fn(), close: vi.fn(async () => {}),
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
const browserRuntime = vi.hoisted(() => ({ hosted: false }));
const pdfSlickTestApi = vi.hoisted(() => ({ sources: [] as Array<string | ArrayBuffer> }));
const tauriCoreApi = vi.hoisted(() => ({ channel: null as { onmessage: ((message: unknown) => void) | null } | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(), isTauri: () => true,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
    constructor() { tauriCoreApi.channel = this; }
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi, currentMonitor: async () => null }));
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
vi.mock("../editor/board/board-editor", () => ({ BoardEditor: () => <div data-testid="board-editor-mock" /> }));
vi.mock("../editor/spreadsheet/spreadsheet-editor", () => ({ SpreadsheetEditor: () => <div data-testid="spreadsheet-editor-mock" /> }));
vi.mock("../editor/presentation/open-slide-workspace", () => ({
  OpenSlideWorkspace: ({ projectRoot, path, source, onMutation }: {
    projectRoot: string; path: string; source: string; onMutation: NonNullable<typeof openSlideWorkspaceApi.onMutation>;
  }) => {
    openSlideWorkspaceApi.onMutation = onMutation;
    return <div data-testid="open-slide-workspace-mock" data-project-root={projectRoot} data-path={path} data-source={source} />;
  },
}));
vi.mock("../agent/use-synara-runtime", () => ({
  useSynaraRuntime: (enabled: boolean) => {
    synaraHook.enabledCalls.push(enabled);
    return synaraHook;
  },
}));
vi.mock("../telemetry/interface-sounds", () => ({
  configureInterfaceSounds: interfaceSounds.configure, playInterfaceSound: interfaceSounds.play,
}));
vi.mock("../platform/browser-runtime", () => ({
  isBrowserHosted: () => browserRuntime.hosted,
  browserRuntimeDetached: () => false,
  readBrowserHostAsset: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
  PDFDataRangeTransport: class {
    length: number;
    constructor(length: number) { this.length = length; }
    onDataRange() {}
    abort() {}
  },
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
    loadingTask: { destroy: () => unknown } | null = null;
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
      const pdfjs = await import("pdfjs-dist");
      const loadingTask = pdfjs.getDocument({
        ...(typeof source === "string" ? { url: source } : { data: new Uint8Array(source) }),
        ...this.args.options?.getDocumentParams,
      });
      this.loadingTask = loadingTask;
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
export function mockAppCommand(command: string) {
  if (["list_citations", "list_references"].includes(command)) return [];
  throw new Error(`Unexpected command: ${command}`);
}

const FILE_KINDS: Record<string, string> = {
  tex: "tex", md: "markdown", bib: "bib", tldr: "board", "lattice-sheet": "spreadsheet", tsx: "tsx",
  png: "figure", pdf: "figure", svg: "figure", eps: "figure", webp: "figure",
};

/** A project tree file; `kind` follows the extension unless a test needs another. */
export function fileNode(path: string, kind = FILE_KINDS[path.split(".").pop() ?? ""] ?? "text", extra?: Partial<FileNode>): FileNode {
  return { name: path.split("/").pop() ?? path, path, kind, children: [], ...extra };
}

export const fileNodes = (...paths: string[]) => paths.map((path) => fileNode(path));

export function dirNode(path: string, children: FileNode[] = []): FileNode {
  return { name: path.split("/").pop() ?? path, path, kind: "directory", children };
}

/** A command's canned result, or a function computing it from the call's arguments. */
export type CommandResult = ((args: InvokeArgs | undefined, command: string) => unknown) | string | number | boolean | object | null | undefined;
export type Commands = Record<string, CommandResult>;

/** Answers `invoke` from `commands`: values as-is (the same instance on every call), functions per call, and
 * anything missing through mockAppCommand, which rejects commands a test did not expect. */
export function mockCommands(commands: Commands) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (!Object.hasOwn(commands, command)) return mockAppCommand(command);
    const result = commands[command];
    return typeof result === "function" ? result(args, command) : result;
  });
}

/** What opening `snapshot` reads: its root document, papers, history, and prose lints. */
export function projectCommands(snapshot: ProjectSnapshot | null = projectSnapshot(), source = "\\documentclass{article}") {
  return {
    initial_project: snapshot, read_project_file: source, list_papers: () => [], list_history: () => [], harper_lint: () => [],
  } satisfies Commands;
}

/** projectCommands, plus project-tree re-reads that find `snapshot` unchanged. */
export function refreshableProject(snapshot = projectSnapshot(), source?: string) {
  return { ...projectCommands(snapshot, source), refresh_project: snapshot } satisfies Commands;
}

/** The paper the citation-removal tests cite as `chen2024single`. */
export const SINGLE_TRANSFORMER = { arxivId: "2407.06438", title: "A Single Transformer", citationKey: "chen2024single", hasFullText: true };

/** The paper most Papers tests import, with whatever metadata a test needs. */
export function attentionPaper<T extends object>(paper: T = {} as T) {
  return { arxivId: "1706.03762", title: "Attention Is All You Need", hasFullText: true, ...paper };
}

// Overleaf responses for a linked, connected project; tests override what they exercise.
export const overleafLink = (link: object = {}) => ({
  projectId: "ol-project", projectName: "Overleaf paper", host: "https://www.overleaf.com", lastSync: null, paused: false, ...link,
});
export const overleafStatus = (status: object = {}) => ({
  connected: true, email: "writer@example.com", name: "Writer", host: "https://www.overleaf.com", ...status,
});
export const overleafProbe = (probe: object = {}) => ({
  changed: false, localChanged: false, versionKnown: true, remoteVersion: 1, lastSync: null, ...probe,
});
export const overleafSyncResult = (result: object = {}) => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [],
  automaticRemoteDeletes: [], readOnly: false, ...result,
});
export const overleafSession = (session: object = {}) => ({
  publicId: null, rootFolderId: "root", docs: [{ id: "main-doc", path: "main.tex" }], entities: [],
  permission: "readAndWrite", trackChanges: false, userId: null, ...session,
});
/** The realtime feeds an open Overleaf project polls, all empty. */
export const OVERLEAF_EMPTY_FEEDS = {
  overleaf_chat_messages: () => [], overleaf_threads: () => [], overleaf_comment_anchors: () => [],
  overleaf_change_authors: () => [], overleaf_rt_connected_users: () => [],
};
/** The commands of a linked Overleaf project whose realtime session opens with empty feeds. */
export function overleafCommands(overrides: Commands = {}): Commands {
  return {
    overleaf_link: () => overleafLink(), overleaf_status: () => overleafStatus(), overleaf_probe: () => overleafProbe(),
    overleaf_sync: () => overleafSyncResult(), overleaf_rt_connect: () => overleafSession(), overleaf_rt_disconnect: undefined,
    git_auto_commit: null, ...OVERLEAF_EMPTY_FEEDS, ...overrides,
  };
}

/** Root of the standard test project. */
export const ROOT = "/tmp/lattice-paper";

/** The standard single-document project; tests override only what they exercise. */
export function projectSnapshot({ root = ROOT, files = [fileNode("main.tex")], ...manifest }:
  Partial<ProjectManifest> & { root?: string; files?: FileNode[] } = {}): ProjectSnapshot {
  const defaults = {
    schemaVersion: 1, projectId: "paper-id", name: "Lattice paper",
    rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }], primaryBibliography: "references.bib", trusted: false,
  };
  return { root, manifest: { ...defaults, ...manifest }, files };
}

/** A project's single, default root document. */
export const rootDocument = (path: string, name = "Notes") => [{ path, name, isDefault: true }];
/** A root document registered under the short name some fixtures use. */
export const MAIN_DOCUMENT = rootDocument("main.tex", "Main");
/** A second project holding one private Markdown draft. */
export const notesSnapshot = () => projectSnapshot({
  root: "/tmp/notes", projectId: "notes-id", name: "Notes", rootDocuments: [], files: [fileNode("draft.md")],
});
/** A project whose only root document is the Markdown file `path`. */
export const markdownSnapshot = (path = "notes.md", files = [fileNode(path)]) => projectSnapshot({ rootDocuments: rootDocument(path), files });
/** The project most Overleaf tests link. */
export const overleafPaperSnapshot = () => projectSnapshot({
  root: "/tmp/lattice-overleaf-paper", projectId: "overleaf-paper-id", name: "Overleaf paper",
});
export const EMPTY_BOARD = "{\"tldrawFileFormatVersion\":1,\"records\":[]}";
export const BIB_SOURCE = "@article{lattice, title={Lattice}}";
export const PAPER_ABSTRACT = "## Abstract\n\nPaper content.";

/** A `build_project` answer: a successful build unless `result` says otherwise. */
export function buildResult(result: object = {}) {
  return () => ({ success: true, hasPdf: false, log: "", durationMs: 50, diagnostics: [], ...result });
}

/** A failed `build_project` answer reporting the single error `message`. */
export const failedBuild = (message: string, log = "") => buildResult({
  success: false, log, durationMs: 80, diagnostics: [{ level: "error", message }],
});

/** Answers `read_project_file` from `files` by path, else with `fallback`. */
export function readFiles(files: Record<string, unknown>, fallback: unknown = "\\documentclass{article}") {
  return (args: InvokeArgs | undefined) => files[argPath(args)] ?? fallback;
}

/** Answers each read with `content:<path>`, so a pane shows which file it holds. */
export const readPathContent = (args: InvokeArgs | undefined) => `content:${argPath(args)}`;

/** A promise whose settlers the test holds. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
export type Deferred<T = void> = ReturnType<typeof deferred<T>>;

export function setAutoBuildMode(autoBuildMode: "manual" | "automatic") {
  localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode }));
}

/** Switches the interface language the way a persisted user choice does. */
export async function setInterfaceLanguage(locale: "en" | "zh-CN") {
  await activateAppLocale(locale);
  localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: locale }));
}

// The provider/model/effort pickers are Radix Selects: options are portaled and only exist while the menu is
// open, so a native `fireEvent.change` no longer works. The trigger opens on pointerdown only for a real mouse
// press (pointerType "mouse", primary button), so spell that out.
export async function chooseOption(selectLabel: string, optionName: string | RegExp) {
  fireEvent.pointerDown(await screen.findByLabelText(selectLabel), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

/**
 * Brings the Project or the Agent forward: the two share the default layout's left panel as tabs. Papers needs no
 * such step — it has a panel of its own, always on screen below them.
 */
export const selectPanelTab = async (tab: "Project" | "Agent") => fireEvent.click(await screen.findByRole("tab", { name: tab }));

/** The Papers panel's list; an open Paper's tab carries its title too, so rows are looked up in here. */
export const papersList = async () => within(await screen.findByRole("list", { name: "Papers" }));

/** Opens the paper titled `title` from the Papers panel. */
export async function openPaper(title: string) {
  fireEvent.click(await (await papersList()).findByTitle(title));
}

/** The Build button in the active .tex document panel's header; it stays labelled Build while a build runs. */
export const buildButton = () => screen.getByRole("button", { name: "Build" });

/** Waits until no build is running: the Build button drops its busy state when one finishes. */
export const waitForBuildIdle = () => waitFor(() => expect(buildButton()).not.toHaveAttribute("aria-busy"));

/** Switches the active document between its Edit, Preview, and Split views. */
export function selectDocumentView(view: "Edit" | "Preview" | "Split") {
  fireEvent.click(within(screen.getByRole("tablist", { name: "Document view" })).getByRole("tab", { name: view }));
}

export const projectTreeRoot = () => document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
export const queryProjectTreeItem = (path: string) => projectTreeRoot()?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null;

/** Waits for `selector` inside the project tree's shadow root. */
export function findInProjectTree<T extends HTMLElement = HTMLElement>(selector: string, timeout?: number): Promise<T> {
  return waitFor(() => {
    const element = projectTreeRoot()?.querySelector<T>(selector) ?? null;
    expect(element, `Project tree: ${selector}`).not.toBeNull();
    return element!;
  }, { timeout });
}

export const findProjectTreeItem = (path: string, timeout = 1000) => findInProjectTree(`[data-item-path="${path}"]`, timeout);
export const findProjectTreeRenameInput = () => findInProjectTree<HTMLInputElement>("[data-item-rename-input]");

/**
 * jsdom has no layout, and Trellis sizes its camera from its host's client box: at 0×0 every panel is off screen,
 * so each one renders `display: none` and nothing inside it — tabs, header tools, the editor — is reachable by role.
 * Give the workspace host a desktop window's box so its panels lay out as they do in the app.
 */
for (const [axis, size] of [["clientWidth", 1440], ["clientHeight", 900]] as const) {
  const native = Object.getOwnPropertyDescriptor(Element.prototype, axis)!;
  Object.defineProperty(Element.prototype, axis, {
    configurable: true,
    get(this: Element) { return this.hasAttribute("data-trellis-host") ? size : native.get!.call(this); },
  });
}
// Trellis places each panel with an inline transform and size; read its box back from those, so code that hit-tests a
// panel sees where it is. (A tree drag stays the tree's own — a move between folders — until it leaves the Project
// panel, and only then becomes a Trellis drag of the file.)
const nativeBoundingRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  if (!(this instanceof HTMLElement) || this.dataset.trellisPart !== "panel") return nativeBoundingRect.call(this);
  const [, x = "0", y = "0"] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(this.style.transform) ?? [];
  return new DOMRect(Number(x), Number(y), Number.parseFloat(this.style.width) || 0, Number.parseFloat(this.style.height) || 0);
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lattice.tutorial-seen.v1", "1");
  Object.assign(browserRuntime, { hosted: false });
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
export function renderApp(commands?: Commands, { confirmations = false } = {}) {
  if (commands) mockCommands(commands);
  return render(confirmations ? <ConfirmActionProvider><App /></ConfirmActionProvider> : <App />);
}

/** Renders a linked Overleaf project — the Overleaf paper unless `snapshot` says otherwise — with manual builds
 * and, when given, a persisted Overleaf sync mode. */
export function renderOverleafPaper(overrides: Commands, { snapshot = overleafPaperSnapshot(), syncMode, confirmations }:
  { snapshot?: ProjectSnapshot; syncMode?: "live" | "manual"; confirmations?: boolean } = {}) {
  setAutoBuildMode("manual");
  if (syncMode) localStorage.setItem("lattice.overleaf.sync-mode.v1", syncMode);
  return renderApp({ ...refreshableProject(snapshot), ...overleafCommands(overrides) }, { confirmations });
}

/** Opens `snapshot` with automatic builds, waits for its initial build, then forgets the calls made so far. */
export async function openWithAutomaticBuilds(commands: Commands, snapshot = projectSnapshot({ files: [] })) {
  setAutoBuildMode("automatic");
  renderApp({ ...projectCommands(snapshot), build_project: buildResult(), ...commands });
  await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
  vi.mocked(invoke).mockClear();
}

/** Opens Settings from the titlebar button, then `section` when given. */
export async function openSettings(section?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  if (section) fireEvent.click(await screen.findByRole("button", { name: section }));
}

/** A full GC for retention tests; WeakRef targets survive until the job ends. */
export function exposeGarbageCollector(): () => Promise<void> {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  };
}

// `main.tsx` mounts the toast stack beside `<App />`, so a test rendering the app alone cannot see its
// notifications. Every notification goes through `app-notify`, which always logs, so assert against the store
// the toasts read from — the same contract, without a second React tree. `app-log.test.tsx` covers the rendering.
export const expectNotification = (pattern: RegExp) => waitFor(() => expect(formatAppLogs()).toMatch(pattern));

export function emitTauriEvent(event: string, payload: unknown) {
  act(() => { tauriEventApi.handlers.get(event)?.forEach((handler) => handler({ payload })); });
}

/** Waits for `selector` to match and returns the element. */
export function findElement<T extends Element = HTMLElement>(selector: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const element = document.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
  }, options);
}

export const findFrame = (title = "Agent") => findElement<HTMLIFrameElement>(`iframe[title="${title}"]`);

/** The CodeMirror view mounted at `selector` right now. */
export function editorViewAt(selector = ".cm-editor") {
  const element = document.querySelector<HTMLElement>(selector);
  const view = element && EditorView.findFromDOM(element);
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view mounted at `selector`. */
export async function findEditorView(selector = ".cm-editor", options?: Parameters<typeof waitFor>[1]) {
  const view = EditorView.findFromDOM(await findElement(selector, options));
  if (!view) throw new Error(`No CodeMirror view at ${selector}`);
  return view;
}

/** Waits for the CodeMirror view at `selector` and types `text` at its end. */
export async function appendToEditor(text: string, selector?: string) {
  const view = await findEditorView(selector);
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  return view;
}

/** Waits until the CodeMirror view at `selector` holds exactly `text`, and returns it. */
export function expectEditorText(text: string, selector?: string, options?: Parameters<typeof waitFor>[1]) {
  return waitFor(() => {
    const view = editorViewAt(selector);
    expect(view.state.doc.toString()).toBe(text);
    return view;
  }, options);
}

/** Delivers a window message from `source`, by default as the Synara origin. */
export function postWindowMessage(source: MessageEventSource | null, data: unknown, origin = synaraHook.runtime.origin!) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { source, origin, data })); });
}

/** Waits until the app has invoked `command` with these arguments. */
export function expectInvoked(command: string, ...args: unknown[]) {
  return waitFor(() => expect(invoke).toHaveBeenCalledWith(command, ...args));
}

export function invokeCalls(command: string, matches: (args: InvokeArgs | undefined) => boolean = () => true) {
  return vi.mocked(invoke).mock.calls.filter(([called, args]) => called === command && matches(args));
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves after `count` nested animation frames. */
export function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => (remaining ? window.requestAnimationFrame(() => step(remaining - 1)) : resolve());
    step(count);
  });
}

/** jsdom has no layout; give `element` a fixed box. */
export function stubRect(element: Element, left: number, top: number, width: number, height: number) {
  return vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}),
  } as DOMRect);
}

export function stubElementFromPoint(element: Element | null) {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => element) });
}

/** The per-file editor view states the app persisted, by project root and path. */
export function storedFileViews() {
  return JSON.parse(localStorage.getItem("lattice.file-view-states.v1") ?? "{}") as
    Record<string, Record<string, { text?: { cursor: number; scrollTop: number } }>>;
}

/** Delivers a Finder drop through the native webview drag-and-drop handler. */
export async function dropFinderPaths(paths: string[]) {
  await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
  act(() => { webviewApi.dragDropHandler?.({ payload: { type: "drop", paths, position: { x: 100, y: 100 } } }); });
}

/** Persists the layout a test restores; omitted fields take a single-pane default. */
export function persistLayout(root: string, layout: Pick<WorkspaceLayout, "openTabs" | "activeFile" | "canvasMode"> & Partial<WorkspaceLayout>) {
  persistWorkspaceLayout(root, {
    activeTab: layout.activeFile,
    documentMode: layout.canvasMode as WorkspaceLayout["documentMode"], paperView: "blog", ...layout,
  });
}

/**
 * Persists the Trellis layout of a writer who closed the Agent panel: Project above Papers, and the PDF. The default
 * layout keeps the Agent as a tab behind Project, and a present Agent panel starts Synara as soon as it mounts.
 */
export function persistLayoutWithoutAgent(root = ROOT) {
  saveLayout(root, { document: createDocument(panels.row([
    panels.column([
      panels.panel({ id: "panel-project" }, panels.view("project", { id: "project" })),
      panels.panel({ id: "panel-papers" }, panels.view("papers", { id: "papers" })),
    ], [0.62, 0.38]),
    panels.panel({ id: "panel-pdf" }, panels.view("pdf", { id: "pdf" })),
  ], [0.36, 0.64]), { version: 3 }) });
}

export const paneContent = (pane: "primary" | "secondary") => (
  document.querySelector<HTMLElement>(`.source-editor[data-editor-pane='${pane}'] .cm-content`)
);
export const visualEditorOf = (surface: HTMLElement) => (surface as HTMLElement & { editor: TiptapEditor }).editor;
/** `text` read as the visual editor's own document, for replacing what it shows the way a reader's edit would. */
export function visualDocument(editor: TiptapEditor, text: string) {
  const opened = openMarkdown(text, editor.schema);
  if ("unavailable" in opened) throw new Error(`The visual editor cannot open this Markdown: ${opened.unavailable}`);
  return opened.doc.toJSON() as Record<string, unknown>;
}
export const argPath = (args: InvokeArgs | undefined) => (args as { path: string }).path;

/** Matches the editor tab of a project file by its file name. */
const fileTabName = (path: string) => new RegExp(path.split("/").at(-1)!.replace(/[.]/g, "\\."));

/** Waits until the editor tab for `path` is the selected one. */
export function waitForSelectedTab(path: string) {
  const tab = () => screen.getByRole("tab", { name: fileTabName(path) });
  return waitFor(() => expect(tab()).toHaveAttribute("aria-selected", "true"));
}

/** Opens `path` from the Project tree and waits for its tab to take focus. */
export async function openTreeFile(path: string) {
  fireEvent.click(await findProjectTreeItem(path));
  await waitForSelectedTab(path);
}

export function stubScrollBox(element: Element, clientHeight: number, scrollHeight: number) {
  const box = (value: number) => ({ configurable: true, value });
  Object.defineProperties(element, { clientHeight: box(clientHeight), scrollHeight: box(scrollHeight) });
}

/** Brings the Agent tab forward and returns its frame, spying on what the host posts to it. */
export async function openAgentFrame({ ready = false } = {}) {
  await selectPanelTab("Agent");
  const frame = await findFrame();
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  if (ready) postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
  return { frame, postMessage };
}

/** Posts the Agent's project-history snapshot for `activeThreadId`. */
export function postProjectHistory(frame: HTMLIFrameElement, activeThreadId: string, entries: unknown[], origin?: string) {
  postWindowMessage(frame.contentWindow, { type: "lattice:project-history", activeThreadId, entries }, origin);
}

/** An Agent checkpoint `cp-<id>` on thread `thread-<id>` that modified one file. */
export function agentCheckpoint(id: string, file: { path?: string; additions: number; deletions: number }, extra = {}) {
  return {
    id: `cp-${id}`, label: "Edited files", timestamp: "2026-08-07T10:00:00.000Z", threadId: `thread-${id}`,
    threadTitle: "Agent task", turnId: `turn-${id}`, turnCount: 1, checkpointRef: `ref-${id}`,
    files: [{ path: "sections/intro.tex", kind: "modified", ...file }], ...extra,
  };
}

/** The messages of `type` the host posted through a `postMessage` spy, oldest first. */
export function postedOfType<T extends object>(postMessage: { mock: { calls: unknown[][] } }, type: string) {
  return postMessage.mock.calls.map(([message]) => message as T & { type?: string }).filter((message) => message?.type === type);
}

/** The toasts currently on screen from `source`. */
export const visibleToasts = (source: string) => getVisibleAppToastIds().map(getAppLogEntry).filter((entry) => entry?.source === source);


/** Waits for the Overleaf sync control to accept a manual sync. */
export function findOverleafSyncButton() {
  return waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>("button[data-tour='overleaf']");
    expect(button).not.toBeNull();
    expect(button).not.toBeDisabled();
    return button!;
  });
}

/** Drags a project-tree row over `target` and drops it there; a function target is re-queried for the drop. */
export function dragTreeItem(source: Element, target: Element | (() => Element)) {
  const at = () => (typeof target === "function" ? target() : target);
  const pointer = { pointerId: 1, pointerType: "mouse" };
  fireEvent.pointerDown(source, { button: 0, clientX: 1, clientY: 1, ...pointer });
  fireEvent.pointerMove(at(), { clientX: 20, clientY: 20, ...pointer });
  fireEvent.pointerUp(at(), { clientX: 20, clientY: 20, ...pointer });
}

/** A loaded pdf.js document of identical stub pages; `pages` overrides the page stub. */
export function pdfDocumentStub(numPages: number, pages: object = {}, extra: object = {}) {
  return { numPages, getPage: vi.fn(async () => pdfPageStub(pages)), getDestination: vi.fn(), getPageIndex: vi.fn(), ...extra };
}

/** Makes every pdf.js load resolve to `document()`. */
export function mockPdfDocument(load: () => unknown) {
  vi.mocked(getDocument).mockImplementation(() => ({ promise: Promise.resolve(load()), destroy: vi.fn() }) as never);
}

/** Stubs blob URLs; `url` names each one created. */
export function stubObjectUrls(url: () => string) {
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

export async function chooseNewDocument(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "New…" }), { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

export async function chooseProjectMenuItem(name: string) {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
export { windowApi, tauriEventApi, synaraHook, interfaceSounds, openSlideWorkspaceApi, browserRuntime, pdfSlickTestApi, tauriCoreApi };
