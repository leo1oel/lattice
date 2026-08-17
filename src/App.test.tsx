import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { clearAppLogs, formatAppLogs, getAppLogEntry, getVisibleAppToastIds } from "./app-log-store";
import { persistWorkspaceLayout } from "./app-settings";
import { mapCollabProjectStatusV2 } from "./collab-status";
import { formatCollabInvitationV2 } from "./collab-invitation-v2";
import { loadTextLanguageExtensions } from "./editor-languages";
import { activateAppLocale } from "./i18n";
import { referenceAssetPreviewDataUrl } from "./reference-preview";
import { usePanelLayout } from "./use-panel-layout";
import { parseVisualMarkdown } from "./visual-markdown-schema";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { ConfirmActionProvider } from "./confirm-action-dialog";
import type { CollabProjectStatusV2 } from "./collab-project-v2";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn(),
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  setMinSize: vi.fn(),
  onResized: vi.fn(),
}));
const webviewApi = vi.hoisted(() => ({
  dragDropHandler: null as null | ((event: {
    payload:
      | { type: "enter"; paths: string[]; position: { x: number; y: number } }
      | { type: "over"; position: { x: number; y: number } }
      | { type: "drop"; paths: string[]; position: { x: number; y: number } }
      | { type: "leave" };
  }) => void),
}));
const synaraHook = vi.hoisted(() => ({
  runtime: {
    state: "ready",
    origin: "http://127.0.0.1:4173",
    authToken: "test-token" as string | null,
    message: null as string | null,
    startupMs: 1 as number | null,
    version: "test" as string | null,
    revision: "test" as string | null,
  } as SynaraRuntimeInfo,
  retry: vi.fn(),
  enabledCalls: [] as boolean[],
}));
const interfaceSounds = vi.hoisted(() => ({
  configure: vi.fn(),
  play: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof webviewApi.dragDropHandler) => {
      webviewApi.dragDropHandler = handler;
      return () => {};
    },
  }),
}));
// Unmocked, every `listen` reaches for Tauri's IPC bridge and rejects, which
// jsdom reports as an unhandled rejection for each runtime listener.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
// The board creation flow opens the .tldr in the canvas; mounting the real
// Tldraw editor needs browser canvas APIs jsdom doesn't have.
vi.mock("./board-editor", () => ({ BoardEditor: () => <div data-testid="board-editor-mock" /> }));
vi.mock("./spreadsheet-editor", () => ({ SpreadsheetEditor: () => <div data-testid="spreadsheet-editor-mock" /> }));
vi.mock("./use-synara-runtime", () => ({
  useSynaraRuntime: (enabled: boolean) => {
    synaraHook.enabledCalls.push(enabled);
    return synaraHook;
  },
}));
vi.mock("./interface-sounds", () => ({
  configureInterfaceSounds: interfaceSounds.configure,
  playInterfaceSound: interfaceSounds.play,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
  TextLayer: class {
    container: HTMLElement;
    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }
    render() {
      const span = document.createElement("span");
      span.textContent = "Attention is all you need";
      this.container.append(span);
      return Promise.resolve();
    }
    cancel() {}
  },
}));

function mockAppCommand(command: string, ..._args: unknown[]) {
  void _args;
  // Every window asks for its one-shot instruction at startup; only a window
  // opened to join a share is given one.
  if (command === "take_pending_window_action") return null;
  if (command === "list_citation_keys") return [];
  if (command === "list_citations") return [];
  if (command === "list_references") return [];
  throw new Error(`Unexpected command: ${command}`);
}

// The provider/model/effort pickers are Radix Selects: options are portaled
// and only exist while the menu is open, so a native `fireEvent.change` no
// longer works. The trigger opens on pointerdown only for a real mouse press
// (pointerType "mouse", primary button), so spell that out.
function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}
async function chooseOption(selectLabel: string, optionName: string | RegExp) {
  openSelect(await screen.findByLabelText(selectLabel));
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

async function switchSidebarMode(mode: "Project" | "Papers" | "Agent") {
  fireEvent.click(await screen.findByRole("tab", { name: mode }));
}

function projectTreeRoot(): ShadowRoot | null {
  return document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
}

function queryProjectTreeItem(path: string): HTMLElement | null {
  return Array.from(projectTreeRoot()?.querySelectorAll<HTMLElement>("[data-item-path]") ?? [])
    .find((item) => item.dataset.itemPath === path) ?? null;
}

async function findProjectTreeItem(path: string, timeout = 1000): Promise<HTMLElement> {
  return waitFor(() => {
    const item = queryProjectTreeItem(path);
    expect(item).not.toBeNull();
    return item!;
  }, { timeout });
}

async function findProjectTreeRenameInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const input = projectTreeRoot()?.querySelector<HTMLInputElement>("[data-item-rename-input]");
    expect(input).not.toBeNull();
    return input!;
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lattice.tutorial-seen.v1", "1");
  webviewApi.dragDropHandler = null;
  synaraHook.runtime = {
    state: "ready",
    origin: "http://127.0.0.1:4173",
    authToken: "test-token",
    message: null,
    startupMs: 1,
    version: "test",
    revision: "test",
  };
  synaraHook.retry.mockReset();
  synaraHook.enabledCalls.length = 0;
  // The app asks through the dialog plugin, not the global — see confirmAction.
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(revealItemInDir).mockResolvedValue(undefined);
  vi.mocked(writeText).mockResolvedValue(undefined);
  windowApi.isFullscreen.mockResolvedValue(false);
  windowApi.setFullscreen.mockResolvedValue(undefined);
  windowApi.setMinSize.mockResolvedValue(undefined);
  windowApi.onResized.mockResolvedValue(() => undefined);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "initial_project") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  clearAppLogs();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderApp() {
  return render(<App />);
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

/**
 * `main.tsx` mounts the toast stack beside `<App />`, not inside it, so a test
 * that renders the app alone cannot see the notifications it raises. Assert
 * against the store the toasts read from instead: it is the same contract —
 * every notification goes through `app-notify`, which always logs — and it
 * keeps a second React tree out of an already heavy suite. `app-log.test.tsx`
 * covers the rendering.
 */
async function expectNotification(pattern: RegExp) {
  await waitFor(() => expect(formatAppLogs()).toMatch(pattern));
}

describe("panel layout", () => {
  it("applies a newly measured sidebar minimum during an active drag", () => {
    const { result, rerender } = renderHook(
      ({ minimum }) => usePanelLayout(minimum),
      { initialProps: { minimum: 220 } },
    );
    const target = document.createElement("div");
    vi.spyOn(target, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(target, "hasPointerCapture").mockReturnValue(false);
    vi.spyOn(target, "releasePointerCapture").mockImplementation(() => undefined);

    act(() => {
      result.current.beginSidebarResize({
        preventDefault: vi.fn(),
        clientX: 320,
        pointerId: 1,
        currentTarget: target,
      } as never);
    });
    rerender({ minimum: 300 });
    const move = new Event("pointermove") as PointerEvent;
    Object.defineProperties(move, {
      clientX: { value: 100 },
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
      promise: Promise.resolve({
        getPage: vi.fn(() => Promise.resolve({ getViewport, render })),
      }),
      destroy,
    } as never);
    const image = "data:image/png;base64,preview";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(image);

    await expect(referenceAssetPreviewDataUrl({
      path: "figures/result.pdf",
      mimeType: "application/pdf",
      base64: "JVBERi0xLjQ=",
    })).resolves.toBe(image);

    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      disableFontFace: true,
      useSystemFonts: false,
    }));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "#F9F9FA" }));
    expect(destroy).toHaveBeenCalled();
  });

  it("offers project creation and existing folder import", () => {
    renderApp();
    expect(screen.getByRole("heading", { name: "Research, written with evidence." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guided tutorial" })).toBeInTheDocument();
  });

  it("starts the guided tutorial from the welcome screen", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return null;
      if (command === "open_tutorial_project") throw new Error("Tutorial fixture stopped after invocation.");
      throw new Error(`Unexpected command: ${command}`);
    });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Guided tutorial" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_tutorial_project"));
  });

  it("does not start the tutorial before a project has opened", async () => {
    localStorage.removeItem("lattice.tutorial-seen.v1");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return null;
      throw new Error(`Unexpected command: ${command}`);
    });
    renderApp();
    expect(screen.getByRole("heading", { name: "Research, written with evidence." })).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("initial_project"));
    expect(invoke).not.toHaveBeenCalledWith("open_tutorial_project");
  });

  it("opens the project creation dialog", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Untitled research");
    expect(screen.getByLabelText("Venue template")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /NeurIPS/i })).toBeChecked();
  });

  it("keeps duplicate project errors inside the creation dialog", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/research");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return null;
      if (command === "create_project") throw new Error("That folder already exists and is not empty.");
      throw new Error(`Unexpected command: ${command}`);
    });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder already exists and is not empty.");
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
  });

  it("automatically offers the tutorial after an unseen user opens a project", async () => {
    localStorage.removeItem("lattice.tutorial-seen.v1");
    const snapshot = {
      root: "/tmp/research/First paper",
      manifest: {
        schemaVersion: 1,
        projectId: "first-paper-id",
        name: "First paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "open_tutorial_project") throw new Error("Tutorial fixture stopped after invocation.");
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_tutorial_project"));
    expect(open).not.toHaveBeenCalled();
  });

  it("starts the first build as soon as a new project opens", async () => {
    const snapshot = {
      root: "/tmp/research/New paper",
      manifest: {
        schemaVersion: 1,
        projectId: "new-paper-id",
        name: "New paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(open).mockResolvedValue("/tmp/research");
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return null;
      if (command === "create_project") return snapshot;
      // Creation no longer binds a window; the caller places the project.
      if (command === "open_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.click(screen.getByRole("radio", { name: /ICML/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project", {
      parent: "/tmp/research",
      name: "New paper",
      venue: "icml",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/research/New paper",
    })));
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("New paper");
  });

  it("preserves a forced build queued behind an ordinary build", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const success = { success: true, hasPdf: false, log: "", durationMs: 1, diagnostics: [] };
    let resolveOrdinaryBuild!: (result: typeof success) => void;
    const ordinaryBuild = new Promise<typeof success>((resolve) => {
      resolveOrdinaryBuild = resolve;
    });
    let buildCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        buildCalls += 1;
        return buildCalls === 1 ? ordinaryBuild : success;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Stop" });
    await waitFor(() => expect(buildCalls).toBe(1));

    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Clean rebuild/i }));
    expect(buildCalls).toBe(1);
    resolveOrdinaryBuild(success);

    await waitFor(() => expect(vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project")).toHaveLength(2));
    expect(vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project")[1]?.[1])
      .toEqual(expect.objectContaining({ force: true }));
  });

  it("shows an existing compiled PDF without waiting for the initial build", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const build = new Promise<never>(() => undefined);
    const NativeURL = globalThis.URL;
    class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:cached-pdf");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return build;
      if (command === "read_compiled_pdf") {
        return new TextEncoder().encode("%PDF-1.4 cached").buffer;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_compiled_pdf", {
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(TestURL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("uses fixed application fonts while preserving editor size controls", async () => {
    localStorage.setItem("lattice.appearance.v4", JSON.stringify({
      uiFont: "-apple-system, BlinkMacSystemFont, sans-serif",
      interfaceScale: 1.1,
      editorFont: "Menlo, ui-monospace, monospace",
      editorFontSize: 14,
    }));
    renderApp();
    expect(screen.queryByTitle("Toggle theme")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settingsNavigation = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    expect(within(settingsNavigation).getByRole("button", { name: "Appearance" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/latex editor font/i)).not.toBeInTheDocument();
    await chooseOption("Color theme", "Dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("lattice.theme-preference.v1")).toBe("dark");
    expect(screen.queryByLabelText("Interface font")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--ui-font")).toBe(
        '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif',
      );
      expect(document.documentElement.style.getPropertyValue("--editor-font")).toBe(
        '"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace',
      );
    });
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveValue("14");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(within(settingsNavigation).getByRole("button", { name: "Appearance" }))
      .not.toHaveAttribute("aria-current");
    expect(within(settingsNavigation).getByRole("button", { name: "Editor & builds" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent("Automatic");
    expect(screen.getByText(/leave the editor or stop typing for 1.2 seconds/i)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("lattice.build-preferences.v2")).toContain("automatic"));
    expect(synaraHook.enabledCalls).not.toContain(true);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(screen.getByText("Open a project to manage Agent settings.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
  });

  it("keeps successful TeX checks compact while retaining failure details", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return null;
      if (command === "run_doctor") {
        return {
          ok: true,
          summary: "ready",
          checks: [
            {
              name: "latexmk",
              detail: "LaTeX build driver: /Library/TeX/texbin/latexmk",
              ok: true,
            },
            {
              name: "texlab",
              detail: "TexLab language server: not found on PATH",
              ok: false,
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "TeX doctor" }));
    fireEvent.click(screen.getByRole("button", { name: "Run TeX doctor" }));

    const checklist = await waitFor(() => {
      const list = document.querySelector<HTMLElement>(".doctor-checklist");
      expect(list).not.toBeNull();
      return list!;
    });
    const latexmk = within(checklist).getByText("latexmk").closest("li");
    const texlab = within(checklist).getByText("texlab").closest("li");
    expect(latexmk).toHaveClass("ok");
    expect(latexmk).not.toHaveTextContent("LaTeX build driver");
    expect(texlab).toHaveClass("bad");
    expect(texlab).toHaveTextContent("not found on PATH");
  });

  it("uses the doctor button for progress and hides setup actions when tools are ready", async () => {
    const readyReport = {
      ok: true,
      summary: "ready",
      checks: [
        { name: "latexmk", detail: "ok", ok: true },
        { name: "pdflatex", detail: "ok", ok: true },
        { name: "synctex", detail: "ok", ok: true },
        { name: "bibtex", detail: "ok", ok: true },
        { name: "conference-fonts", detail: "ok", ok: true },
        { name: "uv", detail: "ok", ok: true },
        { name: "uvx", detail: "ok", ok: true },
      ],
    };
    let finishDoctor!: (report: typeof readyReport) => void;
    const doctor = new Promise<typeof readyReport>((resolve) => {
      finishDoctor = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return null;
      if (command === "run_doctor") return doctor;
      throw new Error(`Unexpected command: ${command}`);
    });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "TeX doctor" }));

    const runButton = screen.getByRole("button", { name: "Run TeX doctor" });
    await waitFor(() => expect(runButton).toBeDisabled());
    expect(screen.queryByText("Checking local tools…")).not.toBeInTheDocument();

    await act(async () => finishDoctor(readyReport));
    await waitFor(() => expect(document.querySelector(".doctor-status"))
      .toHaveTextContent("Ready to compile"));
    expect(screen.queryByRole("button", { name: "Install required tools" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy summary" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" }))
      .not.toBeInTheDocument();
  });

  it("resets the settings page scroll position when leaving Logs", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));

    const settingsViewport = document.querySelector<HTMLDivElement>(
      ".settings-content [data-slot='scroll-area-viewport']",
    );
    expect(settingsViewport).not.toBeNull();
    settingsViewport!.scrollTop = 400;

    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    await waitFor(() => expect(settingsViewport).toHaveProperty("scrollTop", 0));
  });

  it("switches the app chrome and settings to Simplified Chinese and persists the choice", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByLabelText("Interface language")).toHaveTextContent("Follow system (default)");
    await chooseOption("Interface language", "Simplified Chinese");

    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "设置分区" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByText("选择菜单、设置和帮助文字所使用的语言。")).toBeInTheDocument();
    expect(localStorage.getItem("lattice.appearance.v5")).toContain('"interfaceLanguage":"zh-CN"');

    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(await screen.findByRole("heading", { name: "以证据书写研究。" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
  });

  it("keeps Settings draggable from its header and the top window strip", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
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

  it("persists the editor spellcheck setting when it is turned off", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    const spellcheck = screen.getByLabelText("Check spelling in prose");
    expect(spellcheck).toBeChecked();
    fireEvent.click(spellcheck);
    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v5")).toContain('"editorSpellcheck":false'));
  });

  it("lets the user mute the small set of interface sounds", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const soundToggle = await screen.findByLabelText("Interface sounds");
    expect(soundToggle).toBeChecked();
    fireEvent.click(soundToggle);

    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v5"))
      .toContain('"interfaceSounds":false'));
    expect(interfaceSounds.configure).toHaveBeenLastCalledWith(false);
  });

  it("keeps an explicitly selected manual build preference", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent("Manual only");
  });

  it("migrates the legacy manual default to automatic build", async () => {
    localStorage.setItem("lattice.build-preferences.v1", JSON.stringify({ autoBuildMode: "manual" }));
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Automatic build")).toHaveTextContent("Automatic");
  });

});

describe("project workspace", () => {
  it.each([
    ["scripts/train.py", "def train(steps):\n    return steps + 1", "FunctionDefinition"],
    ["config/settings.toml", "[tool]\nname = \"research-writer\"\nenabled = true", "propertyName"],
    [".gitignore", "# Build output\ndist/\n*.log\n!important.log", "comment"],
  ])("loads syntax highlighting for %s", async (path, source, expectedNode) => {
    const extensions = await loadTextLanguageExtensions(path);
    const state = EditorState.create({ doc: source, extensions });

    expect(syntaxTree(state).toString()).toContain(expectedNode);
  });

  it("hands a re-opened file the language it already resolved", async () => {
    // Opening a file whose language loads asynchronously used to mount the
    // editor bare and reconfigure it once the language arrived, which parses
    // the document a second time on every visit. Resolving to the same array
    // for a second file of the same type is what lets the editor be created
    // with its language instead.
    for (const [first, second] of [
      ["notes.md", "chapters/intro.md"],
      ["scripts/train.py", "tools/eval.py"],
    ]) {
      const initial = await loadTextLanguageExtensions(first);
      expect(initial.length).toBeGreaterThan(0);
      expect(await loadTextLanguageExtensions(second)).toBe(initial);
      expect(await loadTextLanguageExtensions(first)).toBe(initial);
    }
  });

  it("temporarily reveals auxiliary sources without forgetting the selected document view", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "introduction.tex", path: "introduction.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
        { name: "conference.sty", path: "conference.sty", kind: "text", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        const path = (args as { path: string }).path;
        if (path === "references.bib") return "@article{lattice, title={Lattice}}";
        if (path === "conference.sty") return "\\ProvidesPackage{conference}";
        return "\\documentclass{article}";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    fireEvent.click(await findProjectTreeItem("introduction.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /introduction\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
    expect(document.querySelector(".source-editor")).toBeNull();

    fireEvent.click(await findProjectTreeItem("references.bib"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /references\.bib/ }))
      .toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.querySelector(".source-editor")).not.toBeNull());
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    fireEvent.click(within(screen.getByRole("tablist", { name: "Document view" }))
      .getByRole("tab", { name: "Split" }));
    fireEvent.click(await findProjectTreeItem("conference.sty"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /conference\.sty/ }))
      .toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.querySelector(".source-editor")).not.toBeNull());
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();

    fireEvent.click(await findProjectTreeItem("main.tex"));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" }))
      .toBeInTheDocument();
  });

  it("opens the most recently used other file before a stale secondary or a TeX fallback", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "old.tex", name: "Old paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "old.tex", path: "old.tex", kind: "tex", children: [] },
        { name: "recent.md", path: "recent.md", kind: "markdown", children: [] },
        { name: "current.bib", path: "current.bib", kind: "bib", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["old.tex", "recent.md", "current.bib"],
      activeFile: "current.bib",
      activeTab: "current.bib",
      secondaryFile: "old.tex",
      focusedPane: "primary",
      canvasMode: "source",
      documentMode: "source",
      paperView: "blog",
      tabRecency: ["current.bib", "recent.md", "old.tex"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Split editor right" }));

    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:recent.md"));
  });

  it("uses document modes for previewable files and accepts a tab on the canvas edge", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    localStorage.setItem("lattice.split-ratio.v1", "0.7");

    renderApp();
    await screen.findByRole("tablist", { name: "Document view" });
    const documentView = () => within(screen.getByRole("tablist", { name: "Document view" }));
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();

    fireEvent.click(documentView().getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();
    fireEvent.click(documentView().getByRole("tab", { name: "Split" }));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();

    fireEvent.click(documentView().getByRole("tab", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Split editor right" })).toBeInTheDocument();
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /intro\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /main\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));

    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    const mainTab = screen.getByRole("tab", { name: /main\.tex/ }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(mainTab, {
      button: 0,
      pointerType: "mouse",
      clientX: 120,
      clientY: 16,
    });
    fireEvent.pointerMove(window, { clientX: 850, clientY: 300 });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveTextContent("Open on right");
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });

    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:main.tex"));
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toBe("minmax(220px, 0.5fr) 1px minmax(220px, 0.5fr)");
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.5");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();
    expect(documentView().getByRole("tab", { name: "Edit" }))
      .toHaveAttribute("aria-selected", "true");

    fireEvent.click(documentView().getByRole("tab", { name: "Split" }));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" }))
      .toBeInTheDocument();
    fireEvent.click(documentView().getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    fireEvent.click(documentView().getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:main.tex"));
    expect(documentView().getByRole("tab", { name: "Edit" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("previews a document focused in the right pane and restores the dual layout", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        const path = (args as { path: string }).path;
        return path === "main.tex"
          ? "\\documentclass{article}"
          : "@article{lattice, title={Lattice}}";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await findProjectTreeItem("references.bib"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /references\.bib/ }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));

    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    const mainTab = screen.getByRole("tab", { name: /main\.tex/ }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(mainTab, {
      button: 0,
      pointerType: "mouse",
      clientX: 120,
      clientY: 16,
    });
    fireEvent.pointerMove(window, { clientX: 850, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });

    await waitFor(() => {
      expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
        .toHaveTextContent("@article{lattice");
      expect(document.querySelector(".source-editor[data-editor-pane='secondary'] .cm-content"))
        .toHaveTextContent("\\documentclass{article}");
    });
    const dualCanvas = document.querySelector<HTMLElement>(".dual-canvas")!;
    vi.spyOn(dualCanvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1000,
      width: 1000,
      top: 0,
      bottom: 700,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize dual source panes" }));
    fireEvent.pointerMove(window, { clientX: 650 });
    fireEvent.pointerUp(window, { clientX: 650 });
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.65");
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Document view" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".dual-pane-preview .pdf-column"))
      .toBeInTheDocument());
    expect(within(document.querySelector(
      ".dual-pane-preview[data-editor-pane='secondary']",
    ) as HTMLElement).getByLabelText("Show document outline")).toBeInTheDocument();
    expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
      .toHaveTextContent("@article{lattice");
    expect(document.querySelector(".source-editor[data-editor-pane='secondary']"))
      .toBeNull();
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toContain("0.65fr");
    expect(document.querySelector(".active-document")).toHaveTextContent("main.tex");
    expect(screen.getByRole("tab", { name: "Preview" }))
      .toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => {
      expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
        .toHaveTextContent("@article{lattice");
      expect(document.querySelector(".source-editor[data-editor-pane='secondary'] .cm-content"))
        .toHaveTextContent("\\documentclass{article}");
      expect(screen.getByRole("tab", { name: /main\.tex/ }))
        .toHaveAttribute("aria-selected", "true");
    });
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toContain("0.65fr");

    fireEvent.click(screen.getByRole("tab", { name: "Split" }));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" }))
      .toBeInTheDocument();
    expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
      .toHaveTextContent("\\documentclass{article}");

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => {
      expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
        .toHaveTextContent("@article{lattice");
      expect(document.querySelector(".source-editor[data-editor-pane='secondary'] .cm-content"))
        .toHaveTextContent("\\documentclass{article}");
    });
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
  });

  it("splits a TeX preview without replacing it with the source editor", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /notes\.md/ }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /main\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Split editor right" }));

    await waitFor(() => expect(document.querySelector(".dual-pane-preview[data-editor-pane='primary'] .pdf-column"))
      .toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:notes.md"));

    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeNull());
    expect(document.querySelector(".pdf-column")).toBeInTheDocument();
    expect(document.querySelector(".source-editor")).toBeNull();
    expect(within(documentView).getByRole("tab", { name: "Preview" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("does not forward-sync a stale TeX cursor when the visible split peer is a spreadsheet", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "results.lattice-sheet",
          path: "results.lattice-sheet",
          kind: "spreadsheet",
          children: [],
        },
      ],
    };
    const NativeURL = globalThis.URL;
    class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:lattice-pdf");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    vi.mocked(getDocument).mockReturnValue({
      promise: new Promise(() => undefined),
      destroy: vi.fn(),
    } as never);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "main.tex"
          ? "\\documentclass{article}"
          : "{}";
      }
      if (command === "read_compiled_pdf") {
        return new TextEncoder().encode("%PDF-1.4").buffer;
      }
      if (command === "build_project") {
        return {
          success: true,
          hasPdf: true,
          log: "",
          durationMs: 1,
          diagnostics: [],
          rootDocument: "main.tex",
        };
      }
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "synctex_view") {
        return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: /Reveal cursor in PDF/i });
    fireEvent.click(await findProjectTreeItem("results.lattice-sheet"));
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    fireEvent.click(await findProjectTreeItem("main.tex"));
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Split editor right" }));

    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    const revealCursor = await screen.findByRole("button", { name: /Reveal cursor in PDF/i });
    await waitFor(() => expect(revealCursor).toBeDisabled());
    const syncCallsBeforeClick = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "synctex_view").length;
    fireEvent.click(revealCursor);

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "synctex_view"))
      .toHaveLength(syncCallsBeforeClick);
    expect(document.querySelector(".dual-canvas")).toBeInTheDocument();
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();
    expect(screen.getByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
  });

  it("previews each Markdown pane independently and allows both previews", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "left.md", path: "left.md", kind: "markdown", children: [] },
        { name: "right.md", path: "right.md", kind: "markdown", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["left.md", "right.md"],
      activeFile: "left.md",
      activeTab: "left.md",
      secondaryFile: "right.md",
      focusedPane: "primary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["left.md", "right.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "left.md"
          ? "# Left notes"
          : "# Right notes";
      }
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2));

    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Markdown document editor" }))
      .toHaveLength(1));
    expect(Array.from(document.querySelectorAll<HTMLElement>(".visual-markdown-editor"))
      .map((editor) => editor.dataset.activePath)).toEqual(["left.md"]);
    const rightSource = document.querySelector<HTMLElement>(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    );
    expect(rightSource).toHaveTextContent("# Right notes");

    fireEvent.focus(rightSource!);
    await waitFor(() => expect(within(documentView).getByRole("tab", { name: "Edit" }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));

    await waitFor(() => expect(Array.from(
      document.querySelectorAll<HTMLElement>(".visual-markdown-editor"),
    ).map((editor) => editor.dataset.activePath)).toEqual(["left.md", "right.md"]));
    expect(screen.getAllByRole("textbox", { name: "Markdown document editor" }))
      .toHaveLength(2);
    expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(0);

    const rightPreview = screen.getAllByRole("textbox", { name: "Markdown document editor" })[1];
    const rightVisualEditor = (rightPreview as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      rightVisualEditor.commands.setContent(parseVisualMarkdown("# Right preview edit"));
    });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(Array.from(
      document.querySelectorAll<HTMLElement>(".visual-markdown-editor"),
    ).map((editor) => editor.dataset.activePath)).toEqual(["left.md"]));
    expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("# Right preview edit");
  });

  it("closes a two-file split while keeping the focused file open", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "left.md", path: "left.md", kind: "markdown", children: [] },
        { name: "right.md", path: "right.md", kind: "markdown", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["left.md", "right.md"],
      activeFile: "left.md",
      activeTab: "right.md",
      secondaryFile: "right.md",
      focusedPane: "secondary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["right.md", "left.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `# ${(args as { path: string }).path}`;
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));

    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeNull());
    expect(document.querySelector(".source-editor .cm-content")).toHaveTextContent("# right.md");
    expect(screen.getByRole("tab", { name: /right\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /left\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close split" })).toBeNull();
  });

  it.each([
    ["left.md", "right.md"],
    ["right.md", "left.md"],
  ])("collapses a split after closing %s and promotes %s", async (closingPath, survivingPath) => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "left.md", name: "Left", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "left.md", path: "left.md", kind: "markdown", children: [] },
        { name: "right.md", path: "right.md", kind: "markdown", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["left.md", "right.md"],
      activeFile: "left.md",
      activeTab: "right.md",
      secondaryFile: "right.md",
      focusedPane: "secondary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["right.md", "left.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `# ${(args as { path: string }).path}`;
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelectorAll(".source-editor .cm-editor")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: `Close ${closingPath}` }));

    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeNull());
    expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent(`# ${survivingPath}`);
    expect(screen.queryByRole("tab", { name: new RegExp(closingPath.replace(".", "\\.")) }))
      .toBeNull();
    expect(screen.getByRole("tab", { name: new RegExp(survivingPath.replace(".", "\\.")) }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("renders a board canvas rather than its JSON in the secondary split pane", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "sketch.tldr", path: "sketch.tldr", kind: "board", children: [] },
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["sketch.tldr", "notes.md"],
      activeFile: "notes.md",
      activeTab: "sketch.tldr",
      secondaryFile: "sketch.tldr",
      focusedPane: "secondary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["sketch.tldr", "notes.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path.endsWith(".tldr")
          ? "{\"tldrawFileFormatVersion\":1,\"records\":[]}"
          : "# Notes";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const secondaryBoard = await screen.findByTestId("board-editor-mock");
    expect(secondaryBoard.closest("[data-editor-pane='secondary']")).not.toBeNull();
    expect(document.querySelector(".dual-canvas")).not.toBeNull();
    expect(document.querySelector(".source-editor[data-editor-pane='primary'] .cm-content"))
      .toHaveTextContent("# Notes");
  });

  it("keeps a Markdown preview on the right when a board is dropped on the left", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
        { name: "sketch.tldr", path: "sketch.tldr", kind: "board", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["notes.md"],
      activeFile: "notes.md",
      activeTab: "notes.md",
      secondaryFile: null,
      focusedPane: "primary",
      canvasMode: "split",
      documentMode: "split",
      paperView: "blog",
      tabRecency: ["notes.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "sketch.tldr"
          ? "{\"tldrawFileFormatVersion\":1,\"records\":[]}"
          : "# Notes";
      }
      if (command === "harper_lint") return [];
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("separator", { name: "Resize editor and Markdown preview" });
    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);

    const board = await findProjectTreeItem("sketch.tldr");
    fireEvent.pointerDown(board, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 45,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, {
      clientX: 250,
      clientY: 300,
      pointerId: 45,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(window, {
      clientX: 250,
      clientY: 300,
      pointerId: 45,
      pointerType: "mouse",
    });

    const boardCanvas = await screen.findByTestId("board-editor-mock");
    expect(boardCanvas.closest("[data-editor-pane='primary']")).not.toBeNull();
    expect(document.querySelector(
      ".dual-pane-preview[data-editor-pane='secondary'] .secondary-markdown-preview",
    )).not.toBeNull();
    expect(document.querySelector(".source-editor[data-editor-pane='secondary']")).toBeNull();
  });

  it("keeps the current editor when an active-tab split loses a race with a late edit", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    let resolveSplitRead: ((content: string) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        const path = (args as { path: string }).path;
        if (path === "intro.tex") {
          return new Promise<string>((resolve) => {
            resolveSplitRead = resolve;
          });
        }
        return `content:${path}`;
      }
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    const introTab = await findProjectTreeItem("intro.tex");
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));

    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(introTab, {
      button: 0,
      pointerId: 9,
      pointerType: "mouse",
      clientX: 120,
      clientY: 16,
    });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 850, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 850, clientY: 300 });
    await waitFor(() => expect(resolveSplitRead).not.toBeNull());

    const editorElement = document.querySelector<HTMLElement>(
      ".source-editor[data-editor-pane='primary'] .cm-editor",
    );
    const editor = editorElement ? EditorView.findFromDOM(editorElement) : null;
    if (!editor) throw new Error("Primary CodeMirror view was not available");
    act(() => editor.dispatch({
      changes: { from: editor.state.doc.length, insert: "\nEdited while splitting." },
    }));
    act(() => resolveSplitRead?.("content:intro.tex"));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /intro\.tex/ })).toHaveAttribute("aria-selected", "true");
      expect(editor.state.doc.toString()).toContain("Edited while splitting.");
      expect(document.querySelector(".dual-canvas")).not.toBeNull();
    });
  });

  it("restores tab order and active pane while migrating the old three-column layout", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
        { name: "method.tex", path: "method.tex", kind: "tex", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["intro.tex", "main.tex", "method.tex"],
      activeFile: "main.tex",
      activeTab: "method.tex",
      secondaryFile: "method.tex",
      focusedPane: "secondary",
      canvasMode: "columns",
      documentMode: "columns",
      paperView: "blog",
      tabRecency: ["method.tex", "main.tex", "intro.tex"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return `content:${(args as { path: string }).path}`;
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();

    await waitFor(() => expect(document.querySelector(".dual-canvas")).toBeInTheDocument());
    expect(document.querySelector(".columns-canvas")).toBeNull();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".editor-tab"))
      .map((tab) => tab.dataset.tabPath)).toEqual(["intro.tex", "main.tex", "method.tex"]);
    expect(screen.getByRole("tab", { name: /method\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".source-editor[data-editor-pane='secondary'] .cm-content"))
      .toHaveTextContent("content:method.tex");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "main.tex",
      projectRoot: "/tmp/lattice-paper",
    });
    expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "method.tex",
      projectRoot: "/tmp/lattice-paper",
    });
  });

  it("overlaps the pre-switch save with the next file's read and gates the commit on it", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    const writeResolvers: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") {
        await new Promise<void>((resolve) => writeResolvers.push(resolve));
        return undefined;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nEdited." } });

    fireEvent.click(await findProjectTreeItem("intro.tex"));
    // The read of the next file starts while the previous file's write is
    // still pending — they used to run serially.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "intro.tex" }),
    ));
    expect(writeResolvers.length).toBeGreaterThan(0);
    // But the switch must not commit until the save confirms.
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    writeResolvers.splice(0).forEach((resolve) => resolve());
    await waitFor(() => expect(screen.getByRole("tab", { name: /intro\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
  });

  it("keeps the current document when the pre-switch save fails", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") throw new Error("disk full");
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nEdited." } });

    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await expectNotification(/Could not save main\.tex/);
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /intro\.tex/ })).toBeNull();
  });

  it("serializes the switch when the target is the dirty secondary file", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "method.tex", path: "method.tex", kind: "tex", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["main.tex", "method.tex"],
      activeFile: "main.tex",
      activeTab: "main.tex",
      secondaryFile: "method.tex",
      focusedPane: "primary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["main.tex", "method.tex"],
    });
    const writeResolvers: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") {
        await new Promise<void>((resolve) => writeResolvers.push(resolve));
        return undefined;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const secondaryEditor = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        ".source-editor[data-editor-pane='secondary'] .cm-editor",
      );
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(secondaryEditor);
    if (!view) throw new Error("Secondary CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nEdited." } });
    vi.mocked(invoke).mockClear();

    fireEvent.click(await findProjectTreeItem("method.tex"));
    await waitFor(() => expect(writeResolvers.length).toBeGreaterThan(0));
    // save() rewrites method.tex itself, so the read may not start until the
    // write has finished — otherwise the editor would load pre-save contents.
    expect(invoke).not.toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "method.tex" }),
    );
    writeResolvers.splice(0).forEach((resolve) => resolve());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "method.tex" }),
    ));
  });

  it("opens relative project files from Markdown previews", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "notes",
          path: "notes",
          kind: "directory",
          children: [
            { name: "index.md", path: "notes/index.md", kind: "markdown", children: [] },
            { name: "native-unified-view.md", path: "notes/native-unified-view.md", kind: "markdown", children: [] },
          ],
        },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["notes/index.md"],
      activeFile: "notes/index.md",
      activeTab: "notes/index.md",
      secondaryFile: "",
      focusedPane: "primary",
      canvasMode: "split",
      documentMode: "split",
      paperView: "blog",
      tabRecency: ["notes/index.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "notes/index.md"
          ? "---\ntitle: Exact metadata\n---\n[Native unified view](native-unified-view.md)\n\n-\n  [ ] Review preview"
          : "# Native unified view";
      }
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorDom = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".source-editor .cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const editor = EditorView.findFromDOM(editorDom);
    if (!editor) throw new Error("Markdown editor was not created.");
    await waitFor(() => expect(syntaxTree(editor.state).toString()).toContain("Link("));
    const documentView = screen.getByRole("tablist", { name: "Document view" });
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(await screen.findByTestId("editor-scroll-container")).toHaveStyle({ overflowAnchor: "none" });
    const visualSurface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    const visualEditor = (visualSurface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      visualEditor.commands.setContent(
        parseVisualMarkdown("[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview"),
      );
    });
    await waitFor(() => expect(editor.state.doc.toString())
      .toContain("[Visually edited view](native-unified-view.md)"));
    expect(editor.state.doc.toString()).toBe(
      "---\ntitle: Exact metadata\n---\n[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview",
    );
    await waitFor(() => expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(editor.state.doc.toString()).toContain("- [x] Review preview"));

    // An edit the preview published is handed back to it immediately rather
    // than settled, so the preview's accepted document never trails the source
    // it just wrote. Outlast the idle budget: both surfaces still agree.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(editor.state.doc.toString()).toContain("- [x] Review preview");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument();

    // Source edits reach the preview on an idle budget rather than per
    // keystroke. An edit the preview itself published must skip that wait:
    // handing it back a document older than what it last emitted reads as a
    // remote revert, and it would roll the user's typing back once the window
    // elapsed. Outlast the budget and confirm both surfaces still agree.
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("checkbox")).toBeChecked();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(editor.state.doc.toString()).toContain("- [x] Review preview");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument();

    const initialSplitPreview = screen.getByTestId("editor-scroll-container");
    editor.scrollDOM.scrollTop = 360;
    initialSplitPreview.scrollTop = 520;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const editEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    expect(editEditorDom).not.toBeNull();
    expect(document.querySelector(".markdown-preview")).toBeNull();
    const editEditor = editEditorDom ? EditorView.findFromDOM(editEditorDom) : null;
    if (!editEditor) throw new Error("Markdown edit-only editor was not created.");
    await waitFor(() => expect(editEditor.scrollDOM.scrollTop).toBe(360));

    editEditor.scrollDOM.scrollTop = 420;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const splitEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    expect(splitEditorDom).not.toBeNull();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(screen.getByTestId("editor-scroll-container")).toHaveStyle({ overflowAnchor: "none" });
    const splitEditor = splitEditorDom ? EditorView.findFromDOM(splitEditorDom) : null;
    if (!splitEditor) throw new Error("Markdown split editor was not created.");
    await waitFor(() => expect(splitEditor.scrollDOM.scrollTop).toBe(420));
    await waitFor(() => expect(screen.getByTestId("editor-scroll-container").scrollTop).toBe(420));
    splitEditor.dispatch({
      changes: {
        from: 0,
        to: splitEditor.state.doc.length,
        insert: "[Updated native view](native-unified-view.md)",
      },
    });
    // Re-rendering the preview costs a full parse of the document, so source
    // keystrokes reach it on an idle budget instead of one parse per key. The
    // edit is still pending on the commit that follows the dispatch, and lands
    // once typing stops.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("link", { name: "Updated native view" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Updated native view" })).toBeInTheDocument();

    screen.getByTestId("editor-scroll-container").scrollTop = 540;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const previewViewport = screen.getByTestId("editor-scroll-container");
    expect(previewViewport.style.overflowAnchor).toBe("");
    await waitFor(() => expect(previewViewport.scrollTop).toBe(540));

    // Preview and Split mount separate visual-editor roots. Ordinary toolbar
    // switches must hand the viewport to the replacement just like the
    // explicit View in Source action below does.
    await act(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    }));
    const ordinaryPreviewViewport = screen.getByTestId("editor-scroll-container");
    let ordinaryPreviewScrollTop = 560;
    Object.defineProperty(ordinaryPreviewViewport, "scrollTop", {
      configurable: true,
      get: () => ordinaryPreviewViewport.isConnected ? ordinaryPreviewScrollTop : 0,
      set: (value: number) => { ordinaryPreviewScrollTop = value; },
    });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const ordinarySplitViewport = screen.getByTestId("editor-scroll-container");
    await waitFor(() => expect(ordinarySplitViewport.scrollTop).toBe(560));
    ordinarySplitViewport.scrollTop = 570;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("editor-scroll-container").scrollTop).toBe(570));

    const previewSurface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const previewEditor = (previewSurface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      previewEditor.commands.setTextSelection({ from: 1, to: 8 });
    });
    const viewSourceButton = await screen.findByRole("button", { name: "View in source Markdown" });
    const explicitPreviewViewport = screen.getByTestId("editor-scroll-container");
    explicitPreviewViewport.scrollTop = 480;
    fireEvent.click(viewSourceButton);
    expect(await screen.findByRole("separator", { name: "Resize editor and Markdown preview" }))
      .toBeInTheDocument();
    const splitPreviewViewport = screen.getByTestId("editor-scroll-container");
    expect(splitPreviewViewport).not.toBe(explicitPreviewViewport);
    const revealedEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    const revealedEditor = revealedEditorDom ? EditorView.findFromDOM(revealedEditorDom) : null;
    if (!revealedEditor) throw new Error("View in source did not mount CodeMirror.");
    // The visual selection starts on the link's first visible character. Its
    // exact Markdown position is after the opening `[`, rather than the old
    // block-level fallback at offset zero.
    await waitFor(() => expect(revealedEditor.state.selection.main.head).toBe(1));

    // Exercise the settled Split geometry directly: the selected source-backed
    // block has content center 920, while its source range has center 610.
    // View in Source must put both at the center of their 400px viewports.
    await act(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => (
        window.requestAnimationFrame(() => resolve())
      )));
    }));
    Object.defineProperties(splitPreviewViewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    Object.defineProperties(revealedEditor.scrollDOM, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 3_000 },
    });
    splitPreviewViewport.scrollTop = 300;
    const previewRectSpy = vi.spyOn(splitPreviewViewport, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      bottom: 500,
      left: 0,
      right: 500,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    const sourceBackedBlock = splitPreviewViewport.querySelector<HTMLElement>("[data-source-offset='0']");
    if (!sourceBackedBlock) throw new Error("Split Preview did not publish a source-backed block.");
    const sourceBackedBlockRectSpy = vi.spyOn(sourceBackedBlock, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 1_000 - splitPreviewViewport.scrollTop,
      top: 1_000 - splitPreviewViewport.scrollTop,
      bottom: 1_040 - splitPreviewViewport.scrollTop,
      left: 0,
      right: 500,
      width: 500,
      height: 40,
      toJSON: () => ({}),
    }));
    const lineBlockSpy = vi.spyOn(revealedEditor, "lineBlockAt").mockReturnValue({
      top: 600,
      bottom: 620,
    } as never);
    const splitVisualSurface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const splitVisualEditor = (splitVisualSurface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => splitVisualEditor.commands.setTextSelection({ from: 1, to: 8 }));
    fireEvent.click(await screen.findByRole("button", { name: "View in source Markdown" }));
    await waitFor(() => expect(revealedEditor.scrollDOM.scrollTop).toBe(410));
    await waitFor(() => expect(splitPreviewViewport.scrollTop).toBe(720));
    await act(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => (
        window.requestAnimationFrame(() => resolve())
      )));
    }));

    // The first tiny source scroll must not perform a deferred correction.
    fireEvent.scroll(revealedEditor.scrollDOM);
    await act(() => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    }));
    expect(splitPreviewViewport.scrollTop).toBe(720);
    lineBlockSpy.mockRestore();
    previewRectSpy.mockRestore();
    sourceBackedBlockRectSpy.mockRestore();

    splitPreviewViewport.scrollTop = 580;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const restoredPreviewViewport = screen.getByTestId("editor-scroll-container");
    await waitFor(() => expect(restoredPreviewViewport.scrollTop).toBe(580));

    restoredPreviewViewport.scrollTop = 640;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const restoredEditEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    const restoredEditEditor = restoredEditEditorDom ? EditorView.findFromDOM(restoredEditEditorDom) : null;
    if (!restoredEditEditor) throw new Error("Markdown edit-only editor was not restored.");
    await waitFor(() => expect(restoredEditEditor.scrollDOM.scrollTop).toBe(640));

    Object.defineProperties(restoredEditEditor.scrollDOM, {
      scrollHeight: { configurable: true, value: 3_000 },
      clientHeight: { configurable: true, value: 1_000 },
    });
    restoredEditEditor.scrollDOM.scrollTop = 1_000;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    const sourceMappedPreviewViewport = screen.getByTestId("editor-scroll-container");
    // Keep the handoff pending beyond the old two-frame window, as happens
    // while the lazy visual-editor chunk or its scroll geometry is settling.
    await act(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    });
    Object.defineProperties(sourceMappedPreviewViewport, {
      scrollHeight: { configurable: true, value: 5_000 },
      clientHeight: { configurable: true, value: 1_000 },
    });
    await waitFor(() => expect(sourceMappedPreviewViewport.scrollTop).toBe(2_000));
    fireEvent.click(await screen.findByRole("link", { name: "Updated native view" }), { metaKey: true });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "notes/native-unified-view.md",
    }));
    expect(await screen.findByRole("tab", { name: /native-unified-view\.md/ }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("opens HTML documents in an interactive sandboxed preview with Edit and Split views", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "report.html", name: "Results", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "report.html", path: "report.html", kind: "html", children: [] },
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "report.html"
          ? "<!doctype html><html><head><base href='https://example.com/'><style>h1{color:tomato}</style></head><body><h1 id='results'>Results</h1><button onclick='this.textContent=&quot;Done&quot;'>Run</button><a href='./details.html'>Details</a><a href='#results'>Jump</a><script>window.previewReady=true</script></body></html>"
          : "# Notes";
      }
      if (command === "write_project_file") return undefined;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    expect(screen.queryByTitle("HTML preview for report.html")).not.toBeInTheDocument();
    fireEvent.pointerDown(documentView);
    const preview = await screen.findByTitle<HTMLIFrameElement>("HTML preview for report.html");
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(preview.getAttribute("srcdoc")).toContain('<h1 id="results">Results</h1>');
    expect(preview.getAttribute("srcdoc")).toContain("h1{color:tomato}");
    expect(preview.getAttribute("srcdoc")).toContain("<script>window.previewReady=true</script>");
    expect(preview.getAttribute("srcdoc")).toContain("onclick=");
    expect(preview.getAttribute("srcdoc")).toContain('<base href="about:blank">');
    expect(preview.getAttribute("srcdoc")).not.toContain("https://example.com/");
    expect(preview.getAttribute("srcdoc")).not.toContain("href=\"./details.html\"");
    expect(preview.getAttribute("srcdoc")).toContain("href=\"#results\"");
    expect(preview.getAttribute("srcdoc")).toContain('data-lattice-preview="fragment-navigation"');
    expect(preview.getAttribute("srcdoc")).toContain("target.scrollIntoView()");
    expect(preview.getAttribute("srcdoc")).toContain("lattice:html-preview-open-external");

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: preview.contentWindow,
        data: {
          type: "lattice:html-preview-open-external",
          href: "https://arxiv.org/abs/2110.04366",
        },
      }));
    });
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(new URL("https://arxiv.org/abs/2110.04366")));

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(screen.queryByTitle("HTML preview for report.html")).not.toBeInTheDocument();

    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(await screen.findByTitle("HTML preview for report.html")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize editor and HTML preview" })).toBeInTheDocument();

    const editorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    const editor = editorDom ? EditorView.findFromDOM(editorDom) : null;
    if (!editor) throw new Error("HTML editor was not created.");
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: "<!doctype html><html><body><h2>Updated results</h2></body></html>",
      },
    });
    await waitFor(() => expect(screen.getByTitle("HTML preview for report.html").getAttribute("srcdoc"))
      .toContain("<h2>Updated results</h2>"));

    // Republishing srcdoc reloads the frame, so the reader's position has to be
    // carried across it — otherwise every pause in typing threw the author back
    // to the top of their own document.
    const reloaded = screen.getByTitle<HTMLIFrameElement>("HTML preview for report.html");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: reloaded.contentWindow,
        data: {
          type: "lattice:html-preview-scroll",
          clientHeight: 600,
          scrollHeight: 4000,
          scrollTop: 420,
        },
      }));
    });
    const postMessage = vi.spyOn(reloaded.contentWindow!, "postMessage");
    fireEvent.load(reloaded);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "lattice:html-preview-set-scroll-top", scrollTop: 420 },
      "*",
    );

    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(await findProjectTreeItem("notes.md"), {
      button: 0,
      pointerId: 73,
      pointerType: "mouse",
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(window, {
      pointerId: 73,
      pointerType: "mouse",
      clientX: 850,
      clientY: 300,
    });
    expect(document.body).toHaveClass("dragging-project-item");
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "right");
    fireEvent.pointerUp(window, {
      pointerId: 73,
      pointerType: "mouse",
      clientX: 850,
      clientY: 300,
    });

    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("# Notes"));
    expect(document.querySelector(".dual-pane-preview[data-editor-pane='primary'] .html-preview-frame"))
      .toBeInTheDocument();
    expect(document.body).not.toHaveClass("dragging-project-item");
  });

  it("adds and removes project dictionary terms from Editor settings", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
        spellingWords: ["VLM"],
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "set_project_spelling_words") {
        snapshot.manifest.spellingWords = (args as { words: string[] }).words;
        return snapshot.manifest;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));

    expect(screen.getByRole("list", { name: "Project dictionary terms" })).toHaveTextContent("VLM");
    fireEvent.change(screen.getByLabelText("Add project term"), { target: { value: "TexLab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_project_spelling_words", {
      words: ["VLM", "TexLab"],
    }));
    expect(await screen.findByText("TexLab")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove VLM from project dictionary" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_project_spelling_words", {
      words: ["TexLab"],
    }));
    expect(screen.queryByText("VLM")).not.toBeInTheDocument();
  });

  it("shows Synara failure states without rendering the retired Agent settings or composer", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    synaraHook.runtime = {
      state: "stopped",
      origin: null,
      authToken: null,
      message: "Synara did not start.",
      startupMs: null,
      version: null,
      revision: null,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Agent");
    const agentFailure = await screen.findByRole("alert");
    expect(agentFailure).toHaveTextContent("Agent unavailable");
    expect(agentFailure).toHaveTextContent("Synara did not start.");
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Conversation history")).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("alert")).toHaveTextContent("Agent unavailable");
    expect(within(settings).queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Subscriptions")).not.toBeInTheDocument();
  });

  it("defers a restored Agent frame until a post-startup interaction", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    localStorage.setItem("lattice.sidebar-mode.v1", "agent");

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector('iframe[title="Agent"]')).toBeNull();
    expect(synaraHook.enabledCalls).not.toContain(true);
    await switchSidebarMode("Agent");
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frame.closest(".synara-frame-shell")).not.toHaveAttribute("data-ready");

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:embed-ready" },
      }));
    });

    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    expect(postMessage).toHaveBeenCalledWith(
      { type: "lattice:request-agent-permission-mode" },
      synaraHook.runtime.origin,
    );

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://untrusted.example",
        data: { type: "synara:open-settings", section: "providers" },
      }));
    });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:open-settings", section: "providers" },
      }));
    });
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Providers" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("starts Synara when source control is requested", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    expect(synaraHook.enabledCalls).not.toContain(true);

    fireEvent.click(screen.getByRole("button", { name: "Git status and commit" }));

    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
  });

  it("routes agent paper, file, and review requests to their native surfaces", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "folder",
          children: [{ name: "intro.tex", path: "sections/intro.tex", kind: "tex", children: [] }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "stat_project_file") return { exists: true, mtimeMs: 1 };
      if (command === "list_papers") return [{
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        authors: "Ashish Vaswani and Noam Shazeer",
        hasFullText: true,
        hasBlog: false,
      }];
      if (command === "read_paper") return "---\ntitle: Attention Is All You Need\n---\n\n## Abstract\n\nPaper content.";
      if (command === "read_paper_blog_local") return null;
      if (command === "list_history") return [];
      if (command === "build_project") return {
        success: true,
        hasPdf: false,
        log: "",
        durationMs: 5,
        rootDocument: "/private/outside/main.tex",
        diagnostics: [],
      };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    await switchSidebarMode("Papers");
    await screen.findByTitle("Attention Is All You Need");
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: {
          type: "synara:open-file",
          filePath: "/tmp/lattice-paper/notes/detailed%20distillation.md",
        },
      }));
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "notes/detailed distillation.md" }),
    ));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: {
          type: "synara:open-file",
          filePath: "/tmp/lattice-paper/.research/papers/1706.03762/paper.md",
        },
      }));
    });
    expect(await screen.findByRole("heading", { name: "Attention Is All You Need" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:open-review", filePath: "sections/intro.tex" },
      }));
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "sections/intro.tex" }),
    ));
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:open-review", threadId: "thread-1", turnId: "turn-9" },
      }));
    });
    expect(await screen.findByRole("tab", { name: "Agent turn" })).toBeInTheDocument();
    const gitWorkspaceTabs = screen.getByRole("tablist", { name: "Git workspace" });
    expect(gitWorkspaceTabs).toHaveClass("drawer-view-tabs");
    expect(screen.getByRole("tab", { name: "Changes" }))
      .toHaveClass("drawer-view-tab");
    expect(screen.getByRole("tab", { name: "Changes" }))
      .not.toHaveClass("ui-compact-selectable");
    const reviewFrame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent turn review"]');
    expect(reviewFrame).not.toBeNull();
    expect(reviewFrame!.src).toContain("threadId=thread-1");
    expect(reviewFrame!.src).toContain("turnId=turn-9");

    // Tabbing back to the working tree drops the pinned turn.
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Agent turn" })).not.toBeInTheDocument());
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
  });

  it("rebuilds after fresh agent checkpoints but not for replayed history", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const tutorialSnapshot = {
      ...snapshot,
      root: "/tmp/tutorial-paper",
      manifest: {
        ...snapshot.manifest,
        projectId: "tutorial-id",
        name: "Tutorial paper",
      },
    };
    const buildResult = {
      success: true,
      hasPdf: false,
      log: "",
      durationMs: 5,
      rootDocument: "/private/outside/main.tex",
      diagnostics: [],
    };
    let deferNextBuild = false;
    let nextBuildHasPdf = false;
    let deferNextPdfRead = false;
    const deferredBuild: { settle: ((reason?: Error) => void) | null } = { settle: null };
    const deferredPdfRead: { settle: ((reason?: Error) => void) | null } = { settle: null };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "open_tutorial_project") return tutorialSnapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "stat_project_file") return { exists: true, mtimeMs: 1 };
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        const result = nextBuildHasPdf ? { ...buildResult, hasPdf: true } : buildResult;
        nextBuildHasPdf = false;
        if (deferNextBuild) {
          deferNextBuild = false;
          await new Promise<void>((resolveBuild, rejectBuild) => {
            deferredBuild.settle = (reason) => (reason ? rejectBuild(reason) : resolveBuild());
          });
          deferredBuild.settle = null;
        }
        return result;
      }
      if (command === "read_compiled_pdf" && deferNextPdfRead) {
        deferNextPdfRead = false;
        await new Promise<void>((resolveRead, rejectRead) => {
          deferredPdfRead.settle = (reason) => (reason ? rejectRead(reason) : resolveRead());
        });
        deferredPdfRead.settle = null;
        return new ArrayBuffer(8);
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    const buildCalls = () =>
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "build_project").length;
    const checkpoint = (files: { path: string; additions: number; deletions: number }[]) => ({
      id: "cp-1",
      label: "Edited files",
      timestamp: "2026-08-07T10:00:00.000Z",
      threadId: "thread-1",
      threadTitle: "Agent task",
      turnId: "turn-1",
      turnCount: 1,
      checkpointRef: "ref-1",
      files: files.map((file) => ({ ...file, kind: "modified" })),
    });
    const postSnapshot = (frame: HTMLIFrameElement, entries: unknown[]) => {
      act(() => {
        window.dispatchEvent(new MessageEvent("message", {
          source: frame.contentWindow,
          origin: synaraHook.runtime.origin!,
          data: { type: "lattice:project-history", activeThreadId: "thread-1", entries },
        }));
      });
    };

    const view = renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    // The first snapshot for a thread replays its existing history; it must
    // prime the fingerprints without scheduling a rebuild.
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 1, deletions: 0 }])]);
    const baseline = buildCalls();
    await new Promise((resolvePause) => setTimeout(resolvePause, 2_200));
    expect(buildCalls()).toBe(baseline);

    // The same checkpoint growing new file work is fresh agent editing.
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 5, deletions: 2 }])]);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 1), { timeout: 4_000 });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lattice:agent-compile-result",
        version: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        checkpointRef: "ref-1",
        success: true,
        durationMs: 5,
        rootDocument: null,
        diagnostics: { errors: 0, warnings: 0 },
      }),
      synaraHook.runtime.origin,
    ));
    const agentCompileRelays = () => postMessage.mock.calls.filter(([message]) => (
      (message as { type?: string }).type === "lattice:agent-compile-result"
    )).length;
    const relaysAfterFirstCheckpoint = agentCompileRelays();

    // A manual build during the checkpoint debounce must not consume its
    // association. The dedicated automatic pass still runs and owns the relay.
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 9, deletions: 2 }])]);
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Build" })).toBeEnabled());
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 3), { timeout: 4_000 });
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1));

    // A checkpoint that arrives during an in-flight manual build queues its
    // own pass; it must not be credited to the older output.
    deferNextBuild = true;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 4));
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 13, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 1_800));
    expect(buildCalls()).toBe(baseline + 4);
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1);
    deferredBuild.settle?.();
    await waitFor(() => expect(buildCalls()).toBe(baseline + 5));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 2));

    // A rejected backend build used to skip the loop condition and strand the
    // checkpoint pass forever. The queued owner must still run and relay.
    deferNextBuild = true;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 6));
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 15, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 1_800));
    deferredBuild.settle?.(new Error("build rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 7));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 3));

    // Reading a newly compiled PDF can reject independently of compilation.
    // That failure must not prevent a checkpoint queued during the read.
    nextBuildHasPdf = true;
    deferNextPdfRead = true;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(deferredPdfRead.settle).not.toBeNull());
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 16, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 1_800));
    deferredPdfRead.settle?.(new Error("PDF read rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 9));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 4));

    // Queued work and its associations belong to an immutable project scope.
    // Switching while the old manual build is in flight must cancel the queued
    // checkpoint instead of compiling the incoming project under the old turn.
    deferNextBuild = true;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 10));
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 17, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 1_800));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Guided tutorial" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_tutorial_project"));
    deferredBuild.settle?.();
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === "build_project"
      && (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root))
      .toHaveLength(1));
    await new Promise((resolvePause) => setTimeout(resolvePause, 2_000));
    expect(vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === "build_project"
      && (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root))
      .toHaveLength(1);

    const tutorialFrame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    postSnapshot(tutorialFrame, [checkpoint([{ path: "sections/intro.tex", additions: 10, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 2_000));
    expect(vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === "build_project"
      && (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root))
      .toHaveLength(1);

    // Unmount is another ownership boundary: resolving an old build afterward
    // must not launch its queued checkpoint pass against a dead window.
    deferNextBuild = true;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === "build_project"
      && (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root))
      .toHaveLength(2));
    postSnapshot(tutorialFrame, [checkpoint([{ path: "sections/intro.tex", additions: 14, deletions: 2 }])]);
    await new Promise((resolvePause) => setTimeout(resolvePause, 1_800));
    view.unmount();
    deferredBuild.settle?.();
    await new Promise((resolvePause) => setTimeout(resolvePause, 100));
    expect(vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === "build_project"
      && (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root))
      .toHaveLength(2);
  }, 90_000);

  it("opens a project switcher with recent and folder actions", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    expect(screen.queryByText("/tmp/lattice-paper")).not.toBeInTheDocument();
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
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Guided tutorial" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /open another folder/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize workspace sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize writing agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize Project and Papers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add file or folder" })).not.toBeInTheDocument();
    expect(document.querySelector(".source-editor > .code-editor-root")).toBeInTheDocument();
    const titlebar = document.querySelector(".titlebar")!;
    const titlebarSidebar = titlebar.querySelector<HTMLElement>(".titlebar-sidebar")!;
    const titlebarMain = titlebar.querySelector(".titlebar-main")!;
    const canvasPanel = document.querySelector(".canvas-panel")!;
    const titlebarTabs = titlebar.querySelector(".editor-tabs")!;
    const titlebarTools = titlebar.querySelector(".canvas-toolbar")!;
    expect(titlebarSidebar).toHaveStyle({ width: "321px" });
    expect(titlebarTabs).toBeInTheDocument();
    expect(titlebarTools).toBeInTheDocument();
    expect([...titlebarMain.children].indexOf(titlebarTabs)).toBeLessThan([...titlebarMain.children].indexOf(titlebarTools));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Project history" }));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Git status and commit" }));
    expect(canvasPanel.querySelector(".editor-tabs")).not.toBeInTheDocument();
    expect(canvasPanel.querySelector(".canvas-toolbar")).not.toBeInTheDocument();
    await switchSidebarMode("Agent");
    expect(document.querySelector('iframe[title="Agent"]')).toHaveAttribute(
      "src",
      expect.stringContaining("127.0.0.1:4173"),
    );
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
  });

  it("moves the navigator control to the left edge in fullscreen", async () => {
    windowApi.isFullscreen.mockResolvedValue(true);
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Hide sidebar" });
    await waitFor(() => expect(document.querySelector(".app-shell")).toHaveClass("fullscreen"));
  });

  it("toggles fullscreen when double-clicking the titlebar drag area", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.doubleClick(document.querySelector(".titlebar-drag-area")!);
    await waitFor(() => expect(windowApi.setFullscreen).toHaveBeenCalledWith(true));
  });

  it("resizes panels with the accessible divider controls", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const divider = await screen.findByRole("separator", { name: "Resize workspace sidebar" });
    expect(divider).toHaveAttribute("aria-valuenow", "320");
    expect(document.querySelector<HTMLElement>(".workspace")?.style.gridTemplateAreas)
      .toContain("sidebar sidebar-resizer canvas");
    expect(screen.queryByRole("separator", { name: "Resize writing agent" })).not.toBeInTheDocument();
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "336");
    expect(document.querySelector(".titlebar-sidebar")).toHaveStyle({ width: "337px" });

    fireEvent.pointerDown(divider, { clientX: 336 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window);
    expect(divider).toHaveAttribute("aria-valuenow", "400");
    expect(document.querySelector(".titlebar-sidebar")).toHaveStyle({ width: "401px" });

    fireEvent.pointerDown(divider, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 440 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    expect(document.body).not.toHaveClass("resizing-panels");

    fireEvent.pointerDown(divider, { clientX: 440 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.blur(window);
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(divider).toHaveAttribute("aria-valuenow", "384");
    expect(document.body).not.toHaveClass("resizing-panels");

    fireEvent.pointerDown(divider, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 700 });
    fireEvent.pointerUp(window);
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    expect(document.querySelector(".titlebar-sidebar")).toHaveStyle({ width: "425px" });

    await switchSidebarMode("Papers");
    expect(divider).toHaveAttribute("aria-valuenow", "424");
    await switchSidebarMode("Agent");
    expect(divider).toHaveAttribute("aria-valuenow", "424");

    const splitDivider = screen.getByRole("separator", { name: "Resize editor and PDF preview" });
    expect(splitDivider.closest(".split-canvas")).toHaveAttribute(
      "data-minimum-workspace-width",
      "901",
    );
    await waitFor(() => expect(windowApi.setMinSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1222, height: 680 }),
    ));
    expect(splitDivider).toHaveAttribute("aria-valuenow", "46");
    fireEvent.keyDown(splitDivider, { key: "ArrowRight" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");

    const splitCanvas = splitDivider.closest<HTMLElement>(".split-canvas")!;
    vi.spyOn(splitCanvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1201,
      bottom: 800,
      left: 0,
      width: 1201,
      height: 800,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(splitDivider, { clientX: 588 });
    fireEvent.pointerMove(window, { clientX: 600.4 });
    expect(splitCanvas.style.gridTemplateColumns)
      .toBe("600px 1px minmax(500px, 1fr)");
    // The live drag stays out of React so the PDF toolbar is not re-rendered
    // for every pointer event; the accessible value commits on pointer-up.
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");
    fireEvent.pointerUp(window);
    expect(splitDivider).toHaveAttribute("aria-valuenow", "50");
  });

  it("automatically refreshes the project tree when files appear on disk", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const refreshed = {
      ...snapshot,
      files: [...snapshot.files, { name: "notes.md", path: "notes.md", kind: "markdown", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "refresh_project") return refreshed;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    expect(queryProjectTreeItem("notes.md")).toBeNull();
    expect(await findProjectTreeItem("notes.md", 3500)).toBeInTheDocument();
  });

  it("uses Pierre's default density, flattened folders, and Git decorations", async () => {
    localStorage.setItem(
      "lattice:expanded-directories:/tmp/lattice-paper",
      JSON.stringify(["chapters", "chapters/method"]),
    );
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "chapters/method/main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        {
          name: "chapters",
          path: "chapters",
          kind: "directory",
          children: [{
            name: "method",
            path: "chapters/method",
            kind: "directory",
            children: [{
              name: "main.tex",
              path: "chapters/method/main.tex",
              kind: "tex",
              children: [],
            }],
          }],
        },
        {
          name: "component.tsx",
          path: "component.tsx",
          kind: "text",
          children: [],
        },
        { name: "references.bib", path: "references.bib", kind: "text", children: [] },
        { name: "paper.pdf", path: "paper.pdf", kind: "figure", children: [] },
        { name: "conference.sty", path: "conference.sty", kind: "text", children: [] },
        { name: "plain.bst", path: "plain.bst", kind: "text", children: [] },
        { name: "figure.eps", path: "figure.eps", kind: "figure", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "git_status") {
        return {
          available: true,
          repository: true,
          branch: "main",
          files: [{
            path: "chapters/method/main.tex",
            status: "modified",
            staged: false,
            unstaged: true,
          }],
        };
      }
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const file = await findProjectTreeItem("chapters/method/main.tex");
    await waitFor(() => expect(file).toHaveAttribute("data-item-git-status", "modified"));

    const host = document.querySelector<HTMLElement>("file-tree-container.lattice-file-tree");
    expect(host?.style.getPropertyValue("--trees-item-height")).toBe("32px");
    expect(host).toHaveAttribute("data-file-tree-virtualized", "true");
    expect((await findProjectTreeItem("component.tsx")).querySelector("[data-icon-token='react']"))
      .not.toBeNull();
    expect((await findProjectTreeItem("chapters/method/main.tex")).querySelector("use"))
      .toHaveAttribute("href", "#lattice-material-tex");
    expect((await findProjectTreeItem("references.bib")).querySelector("use"))
      .toHaveAttribute("href", "#lattice-material-bibliography");
    expect((await findProjectTreeItem("paper.pdf")).querySelector("use"))
      .toHaveAttribute("href", "#lattice-material-pdf");
    expect((await findProjectTreeItem("conference.sty")).querySelector("use"))
      .toHaveAttribute("href", "#lattice-material-tex-style");
    expect((await findProjectTreeItem("plain.bst")).querySelector("use"))
      .toHaveAttribute("href", "#lattice-material-bibtex-style");
    expect((await findProjectTreeItem("figure.eps")).querySelector("use"))
      .toHaveAttribute("href", "#file-tree-builtin-image");
    const folderRows = projectTreeRoot()?.querySelectorAll("[data-item-type='folder']");
    expect(new Set(Array.from(folderRows ?? [], (row) => (row as HTMLElement).dataset.itemPath)))
      .toEqual(new Set(["chapters/method/"]));
    for (const trigger of projectTreeRoot()?.querySelectorAll("[data-type='context-menu-trigger']") ?? []) {
      expect(trigger).toHaveAttribute("data-visible", "false");
    }
  });

  it("saves and builds changed source when the pointer leaves the editor", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "automatic" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") return undefined;
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nNew result." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nNew result.",
      projectRoot: "/tmp/lattice-paper",
    }));
    // The open file rides along so the backend can re-target the build on it
    // when it is a compilable root (Overleaf's rule).
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
      documentPath: "main.tex",
    })));
  });

  it("automatically builds after 1.2 seconds without editing", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "automatic" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") return undefined;
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })));
    vi.mocked(invoke).mockClear();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nIdle build." } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nIdle build.",
      projectRoot: "/tmp/lattice-paper",
    }), { timeout: 2_500 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })));
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it("automatically rebuilds after the active source changes on disk", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "automatic" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    let source = "\\documentclass{article}";
    let mtimeMs = 1;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return source;
      if (command === "stat_project_file") return { exists: true, mtimeMs };
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        return { success: true, hasPdf: false, log: "", durationMs: 50, diagnostics: [] };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })));
    vi.mocked(invoke).mockClear();
    source = "\\documentclass{article}\nExternal edit.";
    mtimeMs = 2;

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })), { timeout: 3_500 });
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it("lists a work that is only cited but does not offer to open it", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") {
        return [
          { arxivId: "1706.03762", title: "Attention Is All You Need", hasFullText: true },
          // Added through bibcite: in the bibliography, never fetched.
          { arxivId: "1412.6980", title: "Adam: A Method for Stochastic Optimization", citationKey: "kingma2015adam", hasFullText: false },
          // A book: cited, but there is no preprint to fetch.
          { arxivId: "", title: "The TeXbook", citationKey: "knuth1984texbook", hasFullText: false },
        ];
      }
      if (command === "list_history") return [];
      if (command === "fetch_paper") {
        return { paperPath: ".research/papers/1412.6980/paper.md", arxivId: "1412.6980", reused: false };
      }
      // Importing refreshes the project afterwards.
      if (command === "refresh_project") return snapshot;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const papers = within(await screen.findByRole("list", { name: "Papers" }));
    // Its preprint is known, so the row offers to fetch rather than going dead.
    const citedOnly = await papers.findByTitle("Download arXiv 1412.6980");
    expect(citedOnly).toBeEnabled();
    expect(citedOnly.closest(".paper-row")).toHaveClass("cited-only");
    expect(citedOnly).toHaveTextContent("arXiv 1412.6980");

    // A work with no preprint has nothing to fetch, so it stays inert.
    const noPreprint = papers.getByTitle(/The TeXbook.*no local reading available/);
    expect(noPreprint).toBeDisabled();

    // The fetched one still opens in the reader.
    expect(papers.getByTitle("Attention Is All You Need")).toBeEnabled();

    fireEvent.click(citedOnly);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fetch_paper", { arxivId: "1412.6980" }));
  });

  it("warns about DOI-exact citation updates and opens the Crossref notice", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [{
        arxivId: "",
        doi: "10.1234/example",
        title: "A historically important result",
        citationKey: "example2020",
        hasFullText: false,
        hasBlog: false,
        citationHealth: {
          kind: "retracted",
          updateType: "retraction",
          source: "retraction-watch",
          date: "2023-09-17",
          link: "https://doi.org/10.5555/retraction-notice",
          checkedAt: "2026-08-13T12:00:00Z",
        },
      }, {
        arxivId: "",
        doi: "10.1234/no-updates",
        title: "No registered update",
        citationKey: "current2024",
        hasFullText: false,
        hasBlog: false,
        citationHealth: {
          kind: "unknown",
          source: "crossref",
          checkedAt: "2026-08-13T12:00:00Z",
        },
      }];
      if (command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const warning = await screen.findByRole("status");
    expect(warning).toHaveTextContent("Retracted · Retraction Watch · 2023-09-17");
    expect(screen.queryByText(/No Crossref update metadata found/, { selector: ".paper-citation-health" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Retracted · Retraction Watch · 2023-09-17. Open notice",
    }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://doi.org/10.5555/retraction-notice"));
  });

  it("filters the current Papers library by metadata without starting an import", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") {
        return [
          {
            arxivId: "1706.03762",
            title: "Attention Is All You Need",
            authors: "Ashish Vaswani and Noam Shazeer",
            citationKey: "vaswani2017attention",
            hasFullText: true,
            hasBlog: false,
          },
          {
            arxivId: "1412.6980",
            title: "Adam: A Method for Stochastic Optimization",
            authors: "Diederik P. Kingma and Jimmy Ba",
            citationKey: "kingma2015adam",
            hasFullText: true,
            hasBlog: false,
          },
        ];
      }
      if (command === "search_paper_library") {
        const query = String((args as { query?: string } | undefined)?.query ?? "");
        return query === "scaled dot-product"
          ? [{
              kind: "paper",
              path: ".research/papers/1706.03762/paper.md",
              title: "Attention Is All You Need",
              snippet: "The scaled dot-product attention mechanism.",
              line: 42,
              arxivId: "1706.03762",
            }]
          : [];
      }
      if (command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const search = await screen.findByRole("searchbox", { name: "Search or import papers" });
    const list = within(await screen.findByRole("list", { name: "Papers" }));

    fireEvent.change(search, { target: { value: "diederik 1412" } });
    expect(list.getByTitle("Adam: A Method for Stochastic Optimization")).toBeInTheDocument();
    expect(list.queryByTitle("Attention Is All You Need")).not.toBeInTheDocument();
    expect(list.getByText("1 of 2 papers")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "https://arxiv.org/pdf/1706.03762" } });
    expect(list.getByTitle("Attention Is All You Need")).toBeInTheDocument();
    expect(list.queryByTitle("Adam: A Method for Stochastic Optimization")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "vaswani attention" } });
    expect(list.getByTitle("Attention Is All You Need")).toBeInTheDocument();
    expect(list.queryByTitle("Adam: A Method for Stochastic Optimization")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "scaled dot-product" } });
    await waitFor(() => {
      expect(list.getByTitle("Attention Is All You Need")).toBeInTheDocument();
      expect(list.getByText("The scaled dot-product attention mechanism.")).toBeInTheDocument();
    });
    expect(list.queryByTitle("Adam: A Method for Stochastic Optimization")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "missing paper" } });
    expect(list.getByText("No matching papers")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
  });

  it("adds a work with no preprint through the same box, and says there is nothing to open", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: true,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "file", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [];
      if (command === "list_history") return [];
      // No arXiv id anywhere in the answer: bibcite resolved a DOI and wrote
      // the entry, and there is no text on disk to point at.
      if (command === "import_reference") {
        return {
          paperPath: "",
          arxivId: "",
          title: "Deep Residual Learning for Image Recognition",
          citationKey: "he2016deep",
          citationOutput: "",
          alreadyImported: false,
        };
      }
      if (command === "refresh_project") return snapshot;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const box = await screen.findByPlaceholderText("Search or add by title, arXiv ID, DOI, or URL");
    fireEvent.change(box, { target: { value: "10.1109/CVPR.2016.90" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_reference", {
      input: "10.1109/CVPR.2016.90",
    }));
    // The DOI must not be mistaken for an arXiv id, and the message has to
    // admit there is nothing to open rather than imply a paper was fetched.
    await expectNotification(/Added .Deep Residual Learning.*cite it with \\cite\{he2016deep\}.*No full text to open/);
  });

  it("shows imported papers by title while keeping the arXiv id", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [{
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        authors: "Ashish Vaswani and Noam Shazeer",
        hasFullText: true,
        hasBlog: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") {
        return "---\ntitle: Attention Is All You Need\nnotes: |\n  - [ ] Hidden metadata task\n---\n\n## Abstract\n\n- [ ] Review paper";
      }
      if (command === "read_paper_blog_local") return "# Attention overview\n\nA concise explanation.";
      if (command === "write_project_file") return undefined;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const paper = await screen.findByRole("button", { name: /Attention Is All You Need.*1706\.03762/i });
    fireEvent.click(paper);
    expect(await screen.findByText("Attention Is All You Need", { selector: ".active-document span" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
    expect(invoke).toHaveBeenCalledWith("read_paper_blog_local", { arxivId: "1706.03762" });
    expect(invoke).not.toHaveBeenCalledWith("read_paper_blog", { arxivId: "1706.03762" });
    expect(document.querySelector(".paper-reader")).toBeNull();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Attention overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open PDF in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762"));

    const documentView = screen.getByRole("tablist", { name: "Document view" });
    expect(within(documentView).getByRole("tab", { name: "Edit" })).toBeInTheDocument();
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    const paperContent = screen.getByRole("tablist", { name: "Paper content" });
    expect(within(paperContent).getByRole("tab", { name: "Blog" })).toHaveAttribute("aria-selected", "true");
    expect(within(paperContent).getByRole("tab", { name: "Paper" })).toBeInTheDocument();

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const blogEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    const blogEditor = blogEditorDom ? EditorView.findFromDOM(blogEditorDom) : null;
    if (!blogEditor) throw new Error("Paper Markdown editor was not created.");
    blogEditor.dispatch({
      changes: {
        from: 0,
        to: blogEditor.state.doc.length,
        insert: "# Edited overview\n\nSaved from Papers.",
      },
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: ".research/papers/1706.03762/blog.md",
      content: "# Edited overview\n\nSaved from Papers.",
      projectRoot: "/tmp/lattice-paper",
    }));
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: "Edited overview" })).toBeInTheDocument();

    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    const abstractHeading = await screen.findByRole("heading", { name: "Abstract" });
    const paperHeader = document.querySelector<HTMLElement>(".paper-visual-header");
    expect(paperHeader).not.toBeNull();
    expect(within(paperHeader!).getByRole("heading", { name: "Attention Is All You Need" }))
      .toBeInTheDocument();
    expect(within(paperHeader!).getByText("Ashish Vaswani · Noam Shazeer"))
      .toBeInTheDocument();
    expect(paperHeader!.compareDocumentPosition(abstractHeading) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByText("title: Attention Is All You Need")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const paperEditor = await waitFor(() => {
      const paperEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
      const view = paperEditorDom ? EditorView.findFromDOM(paperEditorDom) : null;
      expect(view).not.toBeNull();
      return view;
    });
    if (!paperEditor) throw new Error("Full paper Markdown editor was not created.");
    expect(paperEditor.state.doc.toString()).toContain("- [ ] Hidden metadata task");
    expect(paperEditor.state.doc.toString()).toContain("- [x] Review paper");
    paperEditor.dispatch({
      changes: {
        from: 0,
        to: paperEditor.state.doc.length,
        insert: "# Edited paper\n\nLocal notes.",
      },
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: ".research/papers/1706.03762/paper.md",
      content: "# Edited paper\n\nLocal notes.",
      projectRoot: "/tmp/lattice-paper",
    }));
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: "Edited paper" })).toBeInTheDocument();
    expect(paper.closest(".paper-row")).toHaveClass("active");
    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await switchSidebarMode("Papers");
    await waitFor(() => expect(screen.getByTitle("Attention Is All You Need").closest(".paper-row")).not.toHaveClass("active"));
  });

  it("keeps a local Paper editable when its project is read-only on Overleaf", async () => {
    const snapshot = {
      root: "/tmp/lattice-overleaf-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "overleaf-paper-id",
        name: "Overleaf paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [{
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        hasFullText: true,
        hasBlog: false,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "## Abstract\n\nPaper content.\n\n## Method\n\nEditable notes.";
      if (command === "read_paper_blog") return null;
      if (command === "overleaf_link") return {
        projectId: "ol-read-only",
        projectName: "Overleaf paper",
        host: "https://www.overleaf.com",
        lastSync: null,
        paused: false,
      };
      if (command === "overleaf_sync") return {
        pulled: [],
        pushed: [],
        merged: [],
        conflicts: [],
        deletedLocal: [],
        skippedRemoteDeletes: [],
      };
      if (command === "overleaf_probe") {
        return { changed: false, versionKnown: true, remoteVersion: 1, lastSync: null };
      }
      if (command === "overleaf_rt_connect") return {
        publicId: null,
        rootFolderId: "root",
        docs: [{ id: "main-doc", path: "main.tex" }],
        entities: [],
        permission: "readOnly",
        trackChanges: false,
        userId: null,
      };
      if (command === "overleaf_status") {
        return { connected: true, email: "reader@example.com", name: "Reader", host: "https://www.overleaf.com" };
      }
      if (
        command === "overleaf_rt_disconnect"
        || command === "git_auto_commit"
      ) return command === "git_auto_commit" ? null : undefined;
      if (
        command === "overleaf_chat_messages"
        || command === "overleaf_threads"
        || command === "overleaf_comment_anchors"
        || command === "overleaf_change_authors"
        || command === "overleaf_rt_connected_users"
      ) return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_rt_connect", {
      projectRoot: "/tmp/lattice-overleaf-paper",
    }));
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Attention Is All You Need"));

    const paperEditor = await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(paperEditor).toHaveAttribute("contenteditable", "true"));
    expect(document.querySelector(".ok-block-controls")).not.toBeNull();
  });

  it("opens the linked project on its Overleaf host and keeps the project picker available", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    const snapshot = {
      root: "/tmp/lattice-overleaf-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "overleaf-paper-id",
        name: "Overleaf paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "overleaf_link") return {
        projectId: "ol/project id",
        projectName: "Overleaf paper",
        // Legacy links did not persist the host, so the active account is the
        // source of truth for where their web project lives.
        host: "",
        lastSync: null,
        paused: false,
      };
      if (command === "overleaf_status") {
        return {
          connected: true,
          email: "writer@example.com",
          name: "Writer",
          host: "https://overleaf.example.edu/",
        };
      }
      if (command === "overleaf_sync") return {
        pulled: [],
        pushed: [],
        merged: [],
        conflicts: [],
        deletedLocal: [],
        skippedRemoteDeletes: [],
        automaticRemoteDeletes: [],
        readOnly: false,
      };
      if (command === "overleaf_probe") {
        return { changed: false, versionKnown: true, remoteVersion: 1, lastSync: null };
      }
      if (command === "overleaf_rt_connect") return {
        publicId: null,
        rootFolderId: "root",
        docs: [{ id: "main-doc", path: "main.tex" }],
        entities: [],
        permission: "readAndWrite",
        trackChanges: false,
        userId: null,
      };
      if (command === "overleaf_list_projects") return [];
      if (command === "overleaf_rt_disconnect") return undefined;
      if (command === "git_auto_commit") return null;
      if (
        command === "overleaf_chat_messages"
        || command === "overleaf_threads"
        || command === "overleaf_comment_anchors"
        || command === "overleaf_change_authors"
        || command === "overleaf_rt_connected_users"
      ) return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const actions = await screen.findByRole("button", { name: "Overleaf project actions" });
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Overleaf" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(
      "https://overleaf.example.edu/project/ol%2Fproject%20id",
    ));

    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open another Overleaf project" }));
    expect(await screen.findByLabelText("Open from Overleaf")).toBeInTheDocument();
    expect(await screen.findByText("No projects in this account yet. Create one on Overleaf and it will appear here."))
      .toBeInTheDocument();
  });

  it("silently removes legacy app-owned intermediates from Overleaf", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const snapshot = {
      root: "/tmp/lattice-overleaf-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "overleaf-paper-id",
        name: "Overleaf paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    let syncCount = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "overleaf_link") return {
        projectId: "ol-project",
        projectName: "Overleaf paper",
        host: "https://www.overleaf.com",
        lastSync: null,
        paused: false,
      };
      if (command === "overleaf_status") {
        return { connected: true, email: "writer@example.com", name: "Writer", host: "https://www.overleaf.com" };
      }
      if (command === "overleaf_sync") {
        syncCount += 1;
        return {
          pulled: [],
          pushed: [],
          merged: [],
          conflicts: [],
          deletedLocal: [],
          skippedRemoteDeletes: [],
          automaticRemoteDeletes: syncCount > 1
            ? ["lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs"]
            : [],
          readOnly: false,
        };
      }
      if (command === "overleaf_probe") {
        return { changed: false, versionKnown: true, remoteVersion: 1, lastSync: null };
      }
      if (command === "overleaf_rt_connect") return {
        publicId: null,
        rootFolderId: "root",
        docs: [{ id: "main-doc", path: "main.tex" }],
        entities: [
          { id: "tmp-folder", path: "tmp", kind: "folder" },
          { id: "pdfs-folder", path: "tmp/pdfs", kind: "folder" },
          {
            id: "save-error-file",
            path: "lambda_gpu_proposal.bbl-SAVE-ERROR",
            kind: "file",
          },
        ],
        permission: "readAndWrite",
        trackChanges: false,
        userId: null,
      };
      if (
        command === "overleaf_rt_disconnect"
        || command === "overleaf_delete_entity"
      ) return undefined;
      if (command === "git_auto_commit") return null;
      if (
        command === "overleaf_chat_messages"
        || command === "overleaf_threads"
        || command === "overleaf_comment_anchors"
        || command === "overleaf_change_authors"
        || command === "overleaf_rt_connected_users"
      ) return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_rt_connect", {
      projectRoot: "/tmp/lattice-overleaf-paper",
    }));
    await waitFor(() => expect(syncCount).toBe(1));
    const syncButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>("button[data-tour='overleaf']");
      expect(button).not.toBeNull();
      expect(button).not.toBeDisabled();
      return button!;
    });
    fireEvent.click(syncButton);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", {
      projectRoot: "/tmp/lattice-overleaf-paper",
      kind: "folder",
      entityId: "pdfs-folder",
    }));
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", {
      projectRoot: "/tmp/lattice-overleaf-paper",
      kind: "file",
      entityId: "save-error-file",
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opens a captured webpage without offering it as an arXiv PDF", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [{
        arxivId: "web-0123456789abcdef",
        url: "https://example.com/research/article",
        title: "A captured research article",
        hasFullText: true,
        hasBlog: false,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "# A captured research article\n\nArticle content.";
      if (command === "read_paper_blog") return null;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("A captured research article"));

    const paperHeader = await waitFor(() => {
      const header = document.querySelector<HTMLElement>(".paper-visual-header");
      expect(header).not.toBeNull();
      return header!;
    });
    expect(within(paperHeader).getByRole("heading", { name: "A captured research article" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View original PDF" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open article in browser" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/research/article"));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "read_cached_paper_pdf"))
      .toBe(false);
  });

  it("streams an arXiv PDF once, caches its assembled bytes, and reopens the cache", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 cached arXiv paper").buffer;
    let cached = false;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [{
        arxivId: "1706.03762v7",
        title: "Attention Is All You Need",
        hasFullText: true,
        hasBlog: false,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "## Abstract\n\nPaper content.";
      if (command === "read_paper_blog") return null;
      if (command === "read_cached_paper_pdf") return cached ? pdfBytes : new ArrayBuffer(0);
      if (command === "cache_paper_pdf") {
        cached = true;
        return undefined;
      }
      return mockAppCommand(command);
    });
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          convertToViewportPoint: (x: number, y: number) => [x, y],
        }),
        render: () => renderTask,
        streamTextContent: () => new ReadableStream(),
        getAnnotations: async () => [],
        cleanup: vi.fn(),
      })),
      getData: vi.fn(async () => new Uint8Array(pdfBytes)),
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
      cleanup: vi.fn(),
    };
    vi.mocked(getDocument).mockImplementation(() => ({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    }) as never);
    const NativeURL = globalThis.URL;
    class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:cached-arxiv-paper");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);

    renderApp();
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Attention Is All You Need"));
    const viewOriginalPdf = await screen.findByRole("button", { name: "View original PDF" });
    expect(viewOriginalPdf.closest('[data-tour="paper-actions"]')).not.toBeNull();
    fireEvent.click(viewOriginalPdf);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_cached_paper_pdf", {
      arxivId: "1706.03762v7",
    }));
    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://arxiv.org/pdf/1706.03762v7",
    })));
    const backToPaper = await screen.findByRole("button", { name: "Back to Paper" });
    const openInBrowser = screen.getByRole("button", { name: "Open PDF in browser" });
    const downloadPdf = screen.getByRole("button", { name: "Download PDF" });
    const paperPdfToolbar = backToPaper.closest(".pdf-toolbar");
    expect(paperPdfToolbar).toContainElement(openInBrowser);
    expect(paperPdfToolbar).toContainElement(downloadPdf);
    expect(backToPaper.querySelector("svg")).toHaveClass("lucide-arrow-left");
    expect(backToPaper.querySelector("svg")).toHaveAttribute("stroke-width", "2");
    expect(document.querySelector(".paper-reader-header")).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "cache_paper_pdf",
      expect.objectContaining({ byteLength: pdfBytes.byteLength }),
      { headers: { "x-arxiv-id": "MTcwNi4wMzc2MnY3" } },
    ), { timeout: 2_500 });
    await waitFor(() => expect(downloadPdf).toBeEnabled());
    fireEvent.click(openInBrowser);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://arxiv.org/pdf/1706.03762v7"));

    fireEvent.click(backToPaper);
    expect(await screen.findByRole("heading", { name: "Abstract" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View original PDF" }));

    await waitFor(() => expect(TestURL.createObjectURL).toHaveBeenCalledOnce());
    await waitFor(() => {
      const cachedSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as {
        data?: Uint8Array;
        url?: string;
      } | undefined;
      expect(cachedSource?.data).toBeInstanceOf(Uint8Array);
      expect(cachedSource?.data?.byteLength).toBe(pdfBytes.byteLength);
      expect(cachedSource?.url).toBeUndefined();
    });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_cached_paper_pdf"))
      .toHaveLength(2);
  });

  it("publishes a visually selected Markdown block as Agent context", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "notes.md", path: "notes.md", kind: "markdown", children: [] }],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["notes.md"],
      activeFile: "notes.md",
      activeTab: "notes.md",
      secondaryFile: null,
      focusedPane: "primary",
      canvasMode: "pdf",
      documentMode: "pdf",
      paperView: "blog",
      tabRecency: ["notes.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "## Selected context\n\nUnselected paragraph";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:embed-ready" },
      }));
    });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      editor.view.focus();
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)),
      );
    });

    await waitFor(() => expect(postMessage.mock.calls.some(([message]) => {
      const context = message as { type?: string; editor?: { selection?: string } };
      return context.type === "lattice:host-context"
        && context.editor?.selection === "## Selected context";
    })).toBe(true));

    const grip = document.querySelector<HTMLElement>(".ok-drag-grip");
    expect(grip).not.toBeNull();
    fireEvent.pointerDown(grip!, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerUp(grip!, { button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.click(grip!);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    // The grip focuses the same visual-editor surface after selecting the
    // block. That focus must not clear the context it just published.
    fireEvent.focus(surface);

    const contextCount = postMessage.mock.calls.filter(([message]) => (
      (message as { type?: string }).type === "lattice:host-context"
    )).length;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "lattice:request-host-context" },
      }));
    });
    await waitFor(() => expect(postMessage.mock.calls.filter(([message]) => (
      (message as { type?: string }).type === "lattice:host-context"
    ))).toHaveLength(contextCount + 1));
    const latestContext = postMessage.mock.calls
      .map(([message]) => message as { type?: string; editor?: { selection?: string } })
      .filter((message) => message.type === "lattice:host-context")
      .at(-1);
    expect(latestContext?.editor?.selection).toBe("## Selected context");
  });

  it("gives the Agent a PNG path for a selected WebP Markdown image", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
        {
          name: "figures",
          path: "figures",
          kind: "directory",
          children: [{
            name: "figure.webp",
            path: "figures/figure.webp",
            kind: "figure",
            children: [],
          }],
        },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["notes.md"],
      activeFile: "notes.md",
      activeTab: "notes.md",
      secondaryFile: null,
      focusedPane: "primary",
      canvasMode: "pdf",
      documentMode: "pdf",
      paperView: "blog",
      tabRecency: ["notes.md"],
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "![Figure](figures/figure.webp)";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "read_project_asset") {
        return {
          path: "figures/figure.webp",
          mimeType: "image/webp",
          base64: btoa("webp-bytes"),
        };
      }
      if (command === "prepare_latex_figure") return "figures/figure-converted.png";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:embed-ready" },
      }));
    });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      editor.view.focus();
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)),
      );
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("prepare_latex_figure", {
      path: "figures/figure.webp",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => expect(postMessage.mock.calls.some(([message]) => {
      const context = message as {
        type?: string;
        editor?: {
          selection?: string;
          selectionImage?: {
            sourcePath?: string;
            agentReadablePath?: string;
            mimeType?: string;
          };
        };
      };
      return context.type === "lattice:host-context"
        && context.editor?.selection === "![Figure](figures/figure.webp)"
        && context.editor.selectionImage?.sourcePath === "figures/figure.webp"
        && context.editor.selectionImage.agentReadablePath === "figures/figure-converted.png"
        && context.editor.selectionImage.mimeType === "image/png";
    })).toBe(true));
  });

  it("publishes the current visual document before opening a Paper", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "notes.md", path: "notes.md", kind: "markdown", children: [] }],
    };
    let resolveWrite: (() => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "Original notes";
      if (command === "list_papers") return [{
        arxivId: "2407.06438",
        title: "Paper target",
        hasFullText: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "# Paper body";
      if (command === "read_paper_blog") return null;
      if (command === "write_project_file") {
        return new Promise<void>((resolve) => { resolveWrite = resolve; });
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " updated"));
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: /Paper target.*2407\.06438/i }));
    expect(screen.getByText("Opening Paper target…")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "2407.06438" }));
    // The target Paper read is independent of writing the outgoing notes, so
    // both should be in flight rather than paying write latency first.
    expect(resolveWrite).not.toBeNull();
    act(() => resolveWrite?.());

    await waitFor(() => expect(vi.mocked(invoke).mock.calls).toContainEqual([
      "write_project_file",
      expect.objectContaining({
        path: "notes.md",
        content: expect.stringMatching(/Original notes[\s\S]*updated/),
        projectRoot: "/tmp/lattice-paper",
      }),
    ]));
    expect(await screen.findByRole("heading", { name: "Paper body" })).toBeInTheDocument();
    expect(screen.queryByText("Original notes updated")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "write_project_file",
      expect.objectContaining({
        path: ".research/papers/2407.06438/paper.md",
        content: expect.stringContaining("Original notes"),
      }),
    );
  });

  it("keeps the current document when it is edited during a delayed Paper read", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "notes.md", path: "notes.md", kind: "markdown", children: [] }],
    };
    let resolvePaper: ((value: string) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "Original notes";
      if (command === "list_papers") return [{
        arxivId: "2407.06438",
        title: "Delayed paper",
        hasFullText: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") {
        return new Promise<string>((resolve) => { resolvePaper = resolve; });
      }
      if (command === "read_paper_blog") return null;
      if (command === "write_project_file") return undefined;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: TiptapEditor }).editor;
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByRole("button", { name: /Delayed paper.*2407\.06438/i }));
    await waitFor(() => expect(resolvePaper).not.toBeNull());

    act(() => editor.commands.insertContentAt(editor.state.doc.content.size, " late edit"));
    act(() => resolvePaper?.("# Paper must not replace the edit"));
    await act(async () => { await Promise.resolve(); });

    expect(editor.getText()).toMatch(/Original notes[\s\S]*late edit/);
    expect(screen.queryByRole("heading", { name: "Paper must not replace the edit" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "write_project_file",
      expect.objectContaining({
        path: ".research/papers/2407.06438/paper.md",
        content: expect.stringContaining("Original notes"),
      }),
    );
  });

  it("keeps only the latest Paper when overlapping reads finish out of order", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const paperResolvers = new Map<string, (value: string) => void>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [
        { arxivId: "2407.06438", title: "First paper", hasFullText: true },
        { arxivId: "2103.00020", title: "Second paper", hasFullText: true },
      ];
      if (command === "list_history") return [];
      if (command === "read_paper") {
        return new Promise<string>((resolve) => {
          paperResolvers.set((args as { arxivId: string }).arxivId, resolve);
        });
      }
      if (command === "read_paper_blog") return null;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("First paper"));
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
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "right.tex", path: "right.tex", kind: "tex", children: [] },
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["main.tex", "right.tex"],
      activeFile: "main.tex",
      activeTab: "right.tex",
      secondaryFile: "right.tex",
      focusedPane: "secondary",
      canvasMode: "dual",
      documentMode: "dual",
      paperView: "blog",
      tabRecency: ["right.tex", "main.tex"],
    });
    let resolvePaper!: (value: string) => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return `content:${(args as { path: string }).path}`;
      }
      if (command === "list_papers") return [{
        arxivId: "2407.06438",
        title: "Delayed paper",
        hasFullText: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") {
        return new Promise<string>((resolve) => { resolvePaper = resolve; });
      }
      if (command === "read_paper_blog_local") return null;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelectorAll(".dual-canvas .source-editor"))
      .toHaveLength(2));
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Delayed paper"));
    await waitFor(() => expect(resolvePaper).toBeTypeOf("function"));
    expect(screen.getByText("Opening Delayed paper…")).toBeInTheDocument();

    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:notes.md"));
    expect(screen.queryByText("Opening Delayed paper…")).toBeNull();

    act(() => resolvePaper("# Paper must stay closed"));
    await act(async () => { await Promise.resolve(); });

    expect(document.querySelectorAll(".dual-canvas .source-editor")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { name: "Paper must stay closed" })).toBeNull();
  });

  it("remembers the selected paper content when reopening an article", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers") return [{
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        hasFullText: true,
        hasBlog: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "## Abstract\n\nPaper content.";
      if (command === "read_paper_blog_local") return "# Attention overview\n\nBlog content.";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Attention Is All You Need"));
    const paperContent = await screen.findByRole("tablist", { name: "Paper content" });
    fireEvent.click(within(paperContent).getByRole("tab", { name: "Paper" }));
    await waitFor(() => expect(within(paperContent).getByRole("tab", { name: "Paper" }))
      .toHaveAttribute("aria-selected", "true"));

    await switchSidebarMode("Project");
    fireEvent.click(await findProjectTreeItem("main.tex"));
    await switchSidebarMode("Papers");
    const paper = await screen.findByTitle("Attention Is All You Need");
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
    fireEvent.click(paper);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "read_paper")).toHaveLength(2));

    const reopenedPaperContent = await screen.findByRole("tablist", { name: "Paper content" });
    await waitFor(() => expect(within(reopenedPaperContent).getByRole("tab", { name: "Paper" }))
      .toHaveAttribute("aria-selected", "true"));
  });

  it("opens indexed full-text search from the Project sidebar and opens file and Blog hits", async () => {
    const paper = {
      arxivId: "2407.06438",
      title: "A Single Transformer",
      citationKey: "chen2024single",
      hasFullText: true,
      hasBlog: true,
    };
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "references.bib"
          ? "Bibliography\n@article{chen2024single, title={A Single Transformer}}\n"
          : "Main document\n";
      }
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "read_paper") return "# Full paper\n\nTransformer details.";
      if (command === "read_paper_blog_local") {
        return "# Chen overview\n\nA residual stream explanation.";
      }
      if (command === "search_project") return [
        {
          kind: "file",
          path: "references.bib",
          title: "references.bib",
          snippet: "@article{chen2024single, title={A Single Transformer}}",
          line: 2,
          fileKind: "bib",
        },
        {
          kind: "paper",
          path: ".research/papers/2407.06438/blog.md",
          title: paper.title,
          snippet: "A residual stream explanation.",
          line: 3,
          arxivId: paper.arxivId,
        },
      ];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Find in project" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find in project" }), {
      target: { value: "chen" },
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_project", { query: "chen" }));
    expect(await screen.findByText(/@article\{chen2024single/, {
      selector: ".project-replace-hit-preview",
    })).toBeInTheDocument();
    fireEvent.click(screen.getByText("references.bib:2"));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", {
      name: "Open paper result: A Single Transformer",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "read_paper_blog_local",
      { arxivId: "2407.06438" },
    ));
    expect(await screen.findByRole("heading", { name: "Chen overview" })).toBeInTheDocument();
  });

  it("ignores full-text search results that arrive after a newer query", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    let resolveOlder!: (hits: Array<Record<string, unknown>>) => void;
    let resolveNewer!: (hits: Array<Record<string, unknown>>) => void;
    const older = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveNewer = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "search_project") {
        return (args as { query?: string } | undefined)?.query === "older" ? older : newer;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in project" });
    fireEvent.change(input, { target: { value: "older" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_project", { query: "older" }));
    fireEvent.change(input, { target: { value: "newer" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_project", { query: "newer" }));

    await act(async () => {
      resolveNewer([{
        kind: "file",
        path: "newer.tex",
        title: "newer.tex",
        snippet: "The current result.",
        line: 2,
        fileKind: "tex",
      }]);
      await newer;
    });
    expect(await screen.findByText("newer.tex:2")).toBeInTheDocument();

    await act(async () => {
      resolveOlder([{
        kind: "file",
        path: "older.tex",
        title: "older.tex",
        snippet: "A stale result.",
        line: 7,
        fileKind: "tex",
      }]);
      await older;
    });
    expect(screen.queryByText("older.tex:7")).not.toBeInTheDocument();
    expect(screen.getByText("newer.tex:2")).toBeInTheDocument();
  });

  it("renames project items but keeps bibliography titles authoritative for papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      "/tmp/lattice-paper": {
        "main.tex": { text: { cursor: 12, scrollTop: 80 } },
      },
    }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "rename_project_entry") return "paper.tex";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    renderApp();

    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    const fileMenu = await screen.findByRole("menu");
    expect(fileMenu.parentElement).toBe(document.body);
    expect(fileMenu).toHaveStyle({ position: "fixed" });
    fireEvent.click(within(fileMenu).getByRole("menuitem", { name: "Rename" }));
    const renameInput = await findProjectTreeRenameInput();
    fireEvent.input(renameInput, { target: { value: "paper" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rename_project_entry", {
      path: "main.tex",
      newName: "paper",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /paper\.tex/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /main\.tex/ })).not.toBeInTheDocument();
    expect(await findProjectTreeItem("paper.tex")).toBeInTheDocument();
    await waitFor(() => {
      const states = JSON.parse(
        localStorage.getItem("lattice.file-view-states.v1") ?? "{}",
      ) as Record<string, Record<string, unknown>>;
      expect(states["/tmp/lattice-paper"]?.["main.tex"]).toBeUndefined();
      expect(states["/tmp/lattice-paper"]?.["paper.tex"]).toBeDefined();
    });

    await switchSidebarMode("Papers");
    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("tracks each pointer row as the drop target and persists the move", async () => {
    localStorage.setItem(
      "lattice:expanded-directories:/tmp/lattice-paper",
      JSON.stringify(["sections"]),
    );
    const beforeMove = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "draft.tex", path: "draft.tex", kind: "tex", children: [] },
        { name: "figures", path: "figures", kind: "directory", children: [] },
        { name: "notes", path: "notes", kind: "directory", children: [] },
        { name: "sections", path: "sections", kind: "directory", children: [] },
      ],
    };
    const afterMove = {
      ...beforeMove,
      manifest: {
        ...beforeMove.manifest,
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "figures", path: "figures", kind: "directory", children: [] },
        { name: "notes", path: "notes", kind: "directory", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "directory",
          children: [{ name: "draft.tex", path: "sections/draft.tex", kind: "tex", children: [] }],
        },
      ],
    };
    let moved = false;
    let resolveMove!: (path: string) => void;
    const moveFinished = new Promise<string>((resolve) => {
      resolveMove = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return beforeMove;
      if (command === "refresh_project") return moved ? afterMove : beforeMove;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "move_project_entry") {
        return moveFinished;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const source = await findProjectTreeItem("draft.tex");
    const figures = await findProjectTreeItem("figures/");
    const notes = await findProjectTreeItem("notes/");
    const target = await findProjectTreeItem("sections/");
    const backgroundCallsBeforeMove = vi.mocked(invoke).mock.calls.filter(
      ([command]) => command === "refresh_project"
        || command === "list_papers"
        || command === "list_citation_keys"
        || command === "list_citations"
        || command === "list_references"
        || command === "list_unused_symbols"
        || command === "list_history",
    ).length;
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(figures, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(projectTreeRoot()?.host).toHaveAttribute(
        "data-lattice-pointer-drag-active",
        "true",
      );
      const preview = projectTreeRoot()?.querySelector<HTMLElement>(
        '[data-lattice-pointer-drag-preview="true"]',
      );
      expect(preview).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview?.style.transform).toContain("translate3d");
      expect(preview?.style.opacity).toBe("0.76");
      expect(queryProjectTreeItem("figures/")).toHaveAttribute(
        "data-lattice-pointer-drop-target",
        "true",
      );
    });
    fireEvent.pointerMove(notes, {
      clientX: 20,
      clientY: 35,
      pointerId: 1,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(queryProjectTreeItem("notes/")).toHaveAttribute(
        "data-lattice-pointer-drop-target",
        "true",
      );
    });
    fireEvent.pointerMove(target, {
      clientX: 20,
      clientY: 50,
      pointerId: 1,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(queryProjectTreeItem("sections/")).toHaveAttribute(
        "data-lattice-pointer-drop-target",
        "true",
      );
    });
    expect(queryProjectTreeItem("figures/")).not.toHaveAttribute(
      "data-lattice-pointer-drop-target",
    );
    expect(queryProjectTreeItem("notes/")).not.toHaveAttribute(
      "data-lattice-pointer-drop-target",
    );
    fireEvent.pointerUp(target, {
      clientX: 20,
      clientY: 50,
      pointerId: 1,
      pointerType: "mouse",
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("move_project_entry", {
      path: "draft.tex",
      targetDirectory: "sections",
      projectRoot: "/tmp/lattice-paper",
    }));
    // Pierre's local model must move immediately, before filesystem
    // persistence finishes.
    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    moved = true;
    resolveMove("sections/draft.tex");
    await waitFor(() => {
      expect(projectTreeRoot()?.host).not.toHaveAttribute(
        "data-lattice-pointer-drag-active",
      );
      expect(projectTreeRoot()?.querySelector(
        '[data-lattice-pointer-drag-preview="true"]',
      )).toBeNull();
    });
    expect(vi.mocked(invoke).mock.calls.filter(
      ([command]) => command === "refresh_project"
        || command === "list_papers"
        || command === "list_citation_keys"
        || command === "list_citations"
        || command === "list_references"
        || command === "list_unused_symbols"
        || command === "list_history",
    )).toHaveLength(backgroundCallsBeforeMove);
  });

  it("rebases image paths when an open Markdown file is moved into a folder", async () => {
    localStorage.setItem(
      "lattice:expanded-directories:/tmp/lattice-paper",
      JSON.stringify(["figures"]),
    );
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "notes.md", name: "Notes", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "notes.md", path: "notes.md", kind: "markdown", children: [] },
        {
          name: "figures",
          path: "figures",
          kind: "directory",
          children: [{
            name: "plot.png",
            path: "figures/plot.png",
            kind: "figure",
            children: [],
          }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return '# Notes\n\n<img src="figures/plot.png" alt="Plot" width={223} />\n';
      }
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "move_project_entry") return "figures/notes.md";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("textbox", { name: "Markdown document editor" });
    const source = await findProjectTreeItem("notes.md");
    const target = await findProjectTreeItem("figures/plot.png");
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(target, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(target, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("move_project_entry", {
      path: "notes.md",
      targetDirectory: "figures",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "figures/notes.md",
      content: '# Notes\n\n<img src="plot.png" alt="Plot" width={223} />\n',
      projectRoot: "/tmp/lattice-paper",
    }));
  });

  it("treats a same-directory drop as a no-op", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "notes", path: "notes", kind: "directory", children: [] },
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const source = await findProjectTreeItem("main.tex");
    const target = await findProjectTreeItem("references.bib");
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(target, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(queryProjectTreeItem("references.bib")).not.toHaveAttribute(
      "data-lattice-pointer-drop-target",
    );
    await act(async () => {
      fireEvent.pointerUp(queryProjectTreeItem("references.bib")!, {
        clientX: 20,
        clientY: 20,
        pointerId: 1,
        pointerType: "mouse",
      });
    });
    expect(invoke).not.toHaveBeenCalledWith("move_project_entry", expect.anything());
  });

  it("rolls an optimistic tree move back when persistence fails", async () => {
    localStorage.setItem(
      "lattice:expanded-directories:/tmp/lattice-paper",
      JSON.stringify(["sections"]),
    );
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "draft.tex", path: "draft.tex", kind: "tex", children: [] },
        { name: "sections", path: "sections", kind: "directory", children: [] },
      ],
    };
    let rejectMove!: (reason: Error) => void;
    const moveFinished = new Promise<string>((_resolve, reject) => {
      rejectMove = reject;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "move_project_entry") return moveFinished;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const source = await findProjectTreeItem("draft.tex");
    const target = await findProjectTreeItem("sections/");
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(target, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(target, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("move_project_entry", {
      path: "draft.tex",
      targetDirectory: "sections",
      projectRoot: "/tmp/lattice-paper",
    }));
    rejectMove(new Error("Move failed"));
    expect(await findProjectTreeItem("draft.tex")).toBeInTheDocument();
    await waitFor(() => expect(queryProjectTreeItem("sections/draft.tex")).toBeNull());
  });

  it("moves a nested file to the root when it is dropped on a root file", async () => {
    localStorage.setItem(
      "lattice:expanded-directories:/tmp/lattice-paper",
      JSON.stringify(["sections"]),
    );
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "directory",
          children: [{
            name: "draft.tex",
            path: "sections/draft.tex",
            kind: "tex",
            children: [],
          }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "move_project_entry") return "draft.tex";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const source = await findProjectTreeItem("sections/draft.tex");
    const rootFile = await findProjectTreeItem("main.tex");
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(rootFile, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(queryProjectTreeItem("main.tex")!, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("move_project_entry", {
      path: "sections/draft.tex",
      targetDirectory: "",
      projectRoot: "/tmp/lattice-paper",
    }));
  });

  it("drops onto the exact segment of a flattened directory", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "draft.tex", path: "draft.tex", kind: "tex", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "directory",
          children: [{
            name: "drafts",
            path: "sections/drafts",
            kind: "directory",
            children: [],
          }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "move_project_entry") return "sections/draft.tex";
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const source = await findProjectTreeItem("draft.tex");
    const flattenedSegment = await waitFor(() => {
      const element = projectTreeRoot()?.querySelector<HTMLElement>(
        '[data-item-flattened-subitem="sections/"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(flattenedSegment, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(flattenedSegment, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("move_project_entry", {
      path: "draft.tex",
      targetDirectory: "sections",
      projectRoot: "/tmp/lattice-paper",
    }));
  });

  it("reveals project files and imported papers in Finder from the context menu", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [{ arxivId: "1706.03762", title: "Attention Is All You Need", hasFullText: true }];
      if (command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));

    await switchSidebarMode("Papers");
    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/.research/papers/1706.03762/paper.md"));
  });

  it("imports image files into the figures directory", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "figures", path: "figures", kind: "directory", children: [] }],
    };
    vi.mocked(open).mockResolvedValue(["/tmp/result.png"]);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "import_project_assets") return ["figures/result.png"];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.contextMenu(await findProjectTreeItem("figures/"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import images here" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_assets", {
      paths: ["/tmp/result.png"],
      targetDirectory: "figures",
      projectRoot: "/tmp/lattice-paper",
    }));
  });

  it("opens a project source file when it is dropped onto the editor", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "references.bib"
          ? "@article{lattice, title={Lattice}}"
          : "\\documentclass{article}";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorContent = await waitFor(() => {
      const content = document.querySelector<HTMLElement>(".source-editor .cm-content");
      expect(content).not.toBeNull();
      return content!;
    });
    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => editorContent),
    });
    const bibliography = await findProjectTreeItem("references.bib");
    fireEvent.pointerDown(bibliography, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 41,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, {
      clientX: 250,
      clientY: 300,
      pointerId: 41,
      pointerType: "mouse",
    });
    expect(projectTreeRoot()?.querySelector('[data-lattice-pointer-drag-preview="true"]'))
      .not.toBeNull();
    expect(document.querySelector(".source-editor")).toHaveClass("file-drop-active");
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "left");
    fireEvent.pointerMove(window, {
      clientX: 600,
      clientY: 300,
      pointerId: 41,
      pointerType: "mouse",
    });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "center");
    fireEvent.pointerMove(window, {
      clientX: 850,
      clientY: 300,
      pointerId: 41,
      pointerType: "mouse",
    });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "right");

    fireEvent.pointerUp(window, {
      clientX: 850,
      clientY: 300,
      pointerId: 41,
      pointerType: "mouse",
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "references.bib",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /references\.bib/ }))
      .toHaveAttribute("aria-selected", "true");
    const bibliographyEditorDom = document.querySelector<HTMLElement>(
      ".source-editor[data-editor-pane='secondary'] .cm-editor",
    );
    const bibliographyEditor = bibliographyEditorDom ? EditorView.findFromDOM(bibliographyEditorDom) : null;
    expect(bibliographyEditor && syntaxTree(bibliographyEditor.state).toString())
      .toContain("Entry(EntryType");
    expect(document.querySelector(".source-editor")).not.toHaveClass("file-drop-active");
    expect(document.querySelector(".editor-tab-split-drop-preview")).toBeNull();
  });

  it("opens a dropped project file in the editor pane under the pointer", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "draft.tex", path: "draft.tex", kind: "tex", children: [] },
        { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        const path = (args as { path: string }).path;
        if (path === "draft.tex") return "\\section{Draft}";
        if (path === "references.bib") return "@article{lattice, title={Lattice}}";
        return "\\documentclass{article}";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await findProjectTreeItem("draft.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /draft\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("main.tex"));
    fireEvent.click(within(screen.getByRole("tablist", { name: "Document view" }))
      .getByRole("tab", { name: "Edit" }));
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Dual source view/ }));
    const secondaryEditor = await waitFor(() => {
      const editor = document.querySelector<HTMLElement>(".source-editor[data-editor-pane='secondary']");
      expect(editor).not.toBeNull();
      return editor!;
    });
    const secondaryContent = secondaryEditor.querySelector<HTMLElement>(".cm-content")!;
    const dualCanvas = document.querySelector<HTMLElement>(".dual-canvas")!;
    vi.spyOn(dualCanvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1000,
      width: 1000,
      top: 0,
      bottom: 700,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize dual source panes" }), {
      clientX: 460,
    });
    fireEvent.pointerMove(window, { clientX: 700 });
    fireEvent.pointerUp(window, { clientX: 700 });
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.7");
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toContain("0.7fr");
    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1000,
      width: 1000,
      top: 0,
      bottom: 700,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => secondaryContent),
    });

    const bibliography = await findProjectTreeItem("references.bib");
    fireEvent.pointerDown(bibliography, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 42,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, {
      clientX: 850,
      clientY: 100,
      pointerId: 42,
      pointerType: "mouse",
    });
    expect(secondaryEditor).toHaveClass("file-drop-active");
    fireEvent.pointerUp(window, {
      clientX: 850,
      clientY: 100,
      pointerId: 42,
      pointerType: "mouse",
    });

    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("@article{lattice"));
    expect(localStorage.getItem("lattice.split-ratio.v1")).toBe("0.7");
    expect(document.querySelector<HTMLElement>(".dual-canvas")?.style.gridTemplateColumns)
      .toContain("0.7fr");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    const primaryEditorDom = document.querySelector<HTMLElement>(
      ".source-editor[data-editor-pane='primary'] .cm-editor",
    );
    expect(primaryEditorDom && EditorView.findFromDOM(primaryEditorDom)?.state.doc.toString())
      .toContain("\\documentclass{article}");

    fireEvent.pointerDown(await findProjectTreeItem("draft.tex"), {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 43,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, {
      clientX: 100,
      clientY: 100,
      pointerId: 43,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(window, {
      clientX: 100,
      clientY: 100,
      pointerId: 43,
      pointerType: "mouse",
    });
    await waitFor(() => {
      const primary = document.querySelector<HTMLElement>(
        ".source-editor[data-editor-pane='primary'] .cm-editor",
      );
      expect(primary && EditorView.findFromDOM(primary)?.state.doc.toString())
        .toContain("\\section{Draft}");
      const secondary = document.querySelector<HTMLElement>(
        ".source-editor[data-editor-pane='secondary'] .cm-editor",
      );
      expect(secondary && EditorView.findFromDOM(secondary)?.state.doc.toString())
        .toContain("@article{lattice");
      expect(document.querySelectorAll(".dual-canvas .source-editor[data-editor-pane]")).toHaveLength(2);
    });

    fireEvent.pointerDown(await findProjectTreeItem("main.tex"), {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 44,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(window, {
      clientX: 500,
      clientY: 100,
      pointerId: 44,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(window, {
      clientX: 500,
      clientY: 100,
      pointerId: 44,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(document.querySelector(".dual-canvas")).toBeNull();
      expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("imports a Finder source file into the project before opening it", async () => {
    const beforeImport = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const afterImport = {
      ...beforeImport,
      files: [
        ...beforeImport.files,
        { name: "method.tex", path: "method.tex", kind: "tex", children: [] },
      ],
    };
    let imported = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return beforeImport;
      if (command === "refresh_project") return imported ? afterImport : beforeImport;
      if (command === "import_project_sources") {
        imported = true;
        return ["method.tex"];
      }
      if (command === "read_project_file") {
        return (args as { path: string }).path === "method.tex"
          ? "\\section{Method}"
          : "\\documentclass{article}";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorContent = await waitFor(() => {
      const content = document.querySelector<HTMLElement>(".source-editor .cm-content");
      expect(content).not.toBeNull();
      return content!;
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => editorContent),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/method.tex"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_sources", {
      paths: ["/tmp/method.tex"],
      targetDirectory: "",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /method\.tex/ }))
      .toHaveAttribute("aria-selected", "true");
    expect(await findProjectTreeItem("method.tex")).toBeInTheDocument();
  });

  it("imports and opens a Finder asset dropped onto an asset preview", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{
        name: "figures",
        path: "figures",
        kind: "directory",
        children: [
          { name: "existing.svg", path: "figures/existing.svg", kind: "figure", children: [] },
        ],
      }, { name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "read_project_asset") {
        const path = (args as { path: string }).path;
        return {
          path,
          mimeType: path.endsWith(".png") ? "image/png" : "image/svg+xml",
          base64: path.endsWith(".png") ? "iVBORw0KGgo=" : "PHN2Zy8+",
        };
      }
      if (command === "import_project_assets") return ["figures/new.png"];
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
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
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => preview),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/new.png"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_assets", {
      paths: ["/tmp/new.png"],
      targetDirectory: "figures",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /new\.png/ }))
      .toHaveAttribute("aria-selected", "true");
    expect(await screen.findByAltText("Preview of figures/new.png")).toHaveStyle({ zoom: "1" });
    expect(screen.getByLabelText("Image zoom percentage")).toHaveValue("100");
    expect(invoke).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("relays image and PDF drops on the agent panel into the composer", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "read_agent_composer_files") {
        return [
          { name: "plot.png", mimeType: "image/png", bytesBase64: btoa("png-bytes") },
          { name: "notes.md", mimeType: "text/markdown", bytesBase64: btoa("# Notes") },
        ];
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        origin: synaraHook.runtime.origin!,
        data: { type: "synara:embed-ready" },
      }));
    });
    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => frame),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          // A mixed figure + text-source drop: both are agent-readable, so the
          // panel takes precedence over the project source/mixed branches.
          paths: ["/tmp/plot.png", "/tmp/notes.md"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_agent_composer_files", {
      paths: ["/tmp/plot.png", "/tmp/notes.md"],
    }));
    const message = await waitFor(() => {
      const posted = postMessage.mock.calls
        .map(([data]) => data as {
          type?: string;
          version?: number;
          files?: { name: string; mimeType: string; bytes: ArrayBuffer }[];
        })
        .find((data) => data?.type === "lattice:composer-files");
      expect(posted).toBeDefined();
      return posted!;
    });
    expect(message.version).toBe(1);
    expect(message.files).toHaveLength(2);
    expect(message.files?.[0]?.name).toBe("plot.png");
    expect(message.files?.[0]?.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(message.files![0]!.bytes)).toBe("png-bytes");
    expect(message.files?.[1]?.name).toBe("notes.md");
    expect(message.files?.[1]?.mimeType).toBe("text/markdown");
    expect(new TextDecoder().decode(message.files![1]!.bytes)).toBe("# Notes");
    expect(invoke).not.toHaveBeenCalledWith("import_project_assets", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("import_project_sources", expect.anything());
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("imports a Finder image into the folder of the file it is dropped on", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "directory",
          children: [{ name: "intro.tex", path: "sections/intro.tex", kind: "tex", children: [] }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "import_project_files") return [{ path: "sections/plot.png", kind: "binary" }];
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await findProjectTreeItem("sections/"));
    const row = await findProjectTreeItem("sections/intro.tex");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/plot.png"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_files", {
      paths: ["/tmp/plot.png"],
      targetDirectory: "sections",
      projectRoot: "/tmp/lattice-paper",
    }));
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("imports a mixed Finder file and folder drop where it lands without opening files", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "sections",
          path: "sections",
          kind: "directory",
          children: [{ name: "intro.tex", path: "sections/intro.tex", kind: "tex", children: [] }],
        },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "import_project_files") {
        return [
          { path: "sections/notes.md", kind: "text" },
          { path: "sections/data.csv", kind: "text" },
          { path: "sections/plot.png", kind: "binary" },
          { path: "sections/tables/results.csv", kind: "text" },
        ];
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await findProjectTreeItem("sections/"));
    const row = await findProjectTreeItem("sections/intro.tex");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          // Markdown + a data file the old classifier rejected + an image +
          // a folder, all in one drop: the tree takes any mix.
          paths: ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png", "/tmp/tables"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_files", {
      paths: ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png", "/tmp/tables"],
      targetDirectory: "sections",
      projectRoot: "/tmp/lattice-paper",
    }));
    // Filing into the tree does not open the file; editor drops do that.
    expect(invoke).not.toHaveBeenCalledWith(
      "read_project_file",
      expect.objectContaining({ path: "sections/notes.md" }),
    );
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("imports a Finder image dropped on the Project pane background into the project root", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "import_project_files") return [{ path: "plot.png", kind: "binary" }];
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await findProjectTreeItem("main.tex");
    const pane = document.querySelector(".project-section");
    expect(pane).not.toBeNull();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => pane),
    });
    await waitFor(() => expect(webviewApi.dragDropHandler).not.toBeNull());
    act(() => {
      webviewApi.dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/plot.png"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_files", {
      paths: ["/tmp/plot.png"],
      targetDirectory: "",
      projectRoot: "/tmp/lattice-paper",
    }));
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("limits Quick Open to files and previews SVG files as images", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "figures",
          path: "figures",
          kind: "directory",
          children: [
            // Some scanners classify SVG as text. Opening is extension-based,
            // so Quick Open must still route it to the image preview.
            { name: "diagram.svg", path: "figures/diagram.svg", kind: "text", contentKind: "text", children: [] },
          ],
        },
        { name: "empty", path: "empty", kind: "directory", contentKind: "directory", children: [] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "read_project_asset") {
        return {
          path: (args as { path: string }).path,
          mimeType: "image/svg+xml",
          base64: "PHN2Zy8+",
        };
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("tab", { name: /main\.tex/ });
    fireEvent.keyDown(window, { key: "p", metaKey: true });

    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: "figures" })).toBeNull();
    expect(within(list).queryByRole("option", { name: "empty" })).toBeNull();
    fireEvent.click(within(list).getByRole("option", { name: "figures/diagram.svg" }));

    expect(await screen.findByAltText("Preview of figures/diagram.svg")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/diagram.svg" });
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "figures/diagram.svg" }));
  });

  it("previews SVG and PDF figures and lets their drops replace split panes", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{
        name: "figures",
        path: "figures",
        kind: "directory",
        children: [
          { name: "native-umm.svg", path: "figures/native-umm.svg", kind: "figure", children: [] },
          { name: "result.pdf", path: "figures/result.pdf", kind: "figure", children: [] },
        ],
      },
      { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
      { name: "method.md", path: "method.md", kind: "text", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "method.md"
          ? "# Method"
          : "\\documentclass{article}\n\\begin{document}\n\\end{document}";
      }
      if (command === "read_project_asset") {
        const path = (args as { path: string }).path;
        return path.endsWith(".pdf")
          ? { path, mimeType: "application/pdf", base64: "JVBERi0xLjQ=" }
          : { path, mimeType: "image/svg+xml", base64: "PHN2Zy8+" };
      }
      if (command === "prepare_latex_figure") return "figures/native-umm-converted.pdf";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "write_project_file") return undefined;
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({
          getViewport: () => ({
            width: 600,
            height: 800,
            convertToViewportPoint: (x: number, y: number) => [x, y],
          }),
          render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
          streamTextContent: () => new ReadableStream(),
          getTextContent: async () => ({ items: [] }),
          getAnnotations: async () => [],
        })),
      }),
      destroy: vi.fn(),
    } as never);

    renderApp();
    expect(queryProjectTreeItem("figures/native-umm.svg")).toBeNull();
    fireEvent.click(await findProjectTreeItem("figures/"));
    expect(await findProjectTreeItem("figures/native-umm.svg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    const svgRow = await findProjectTreeItem("figures/native-umm.svg");
    expect(fireEvent.pointerDown(svgRow, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    })).toBe(true);
    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
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
    const svgPreview = screen.getByAltText("Preview of figures/native-umm.svg");
    const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1000,
      width: 1000,
      top: 0,
      bottom: 700,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => svgPreview),
    });
    expect(fireEvent.pointerDown(pdfRow, {
      button: 0,
      pointerId: 2,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    })).toBe(true);
    fireEvent.pointerMove(window, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    expect(document.querySelector(".figure-drag-ghost")).toBeInTheDocument();
    fireEvent.pointerUp(window, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      disableFontFace: true,
      useSystemFonts: false,
    }));
    expect(screen.queryByLabelText("Show document outline")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Split editor right" })).toBeNull();
    expect(await screen.findByRole("separator", { name: "Resize dual source panes" }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /main\.tex/ }));
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => content) });
    fireEvent.pointerDown(await findProjectTreeItem("figures/native-umm.svg"), {
      button: 0,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    expect(document.querySelector(".figure-drag-ghost")).toHaveTextContent("native-umm.svg");
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "left");
    fireEvent.pointerUp(window, {
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    await waitFor(() => expect(assetTab).toHaveAttribute("aria-selected", "true"));
    expect(document.querySelector(".source-editor[data-editor-pane='secondary'] .cm-content"))
      .toHaveTextContent("\\documentclass{article}");
    expect(document.querySelector(".dual-pane-label")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("renders every PDF page in one continuous themed reader", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const renderPdfPage = vi.fn(() => renderTask);
    const getPdfPageText = vi.fn(async () => ({ items: [{ str: "Attention is all you need" }] }));
    const pdf = {
      numPages: 2,
      getPage: vi.fn(async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          convertToViewportPoint: (x: number, y: number) => [x, y],
        }),
        render: renderPdfPage,
        streamTextContent: () => new ReadableStream(),
        getTextContent: getPdfPageText,
        getAnnotations: async () => [{
          id: "link-1",
          subtype: "Link",
          rect: [10, 20, 80, 40],
          url: "https://example.com/paper",
        }],
        cleanup: vi.fn(),
      })),
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    };
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    let pdfUrlSequence = 0;
    const NativeURL = globalThis.URL;
    class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => `blob:lattice-pdf-${++pdfUrlSequence}`);
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    vi.mocked(save).mockResolvedValue("/tmp/exported-paper.pdf");
    let forwardSyncFailure: string | null = null;
    let reverseSyncTarget: { path: string; line: number } = { path: "main.tex", line: 1 };
    let delayForwardSync = false;
    let resolveForwardSync!: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return {
        success: true,
        hasPdf: true,
        log: "",
        durationMs: 100,
        diagnostics: [],
      };
      if (command === "read_compiled_pdf") {
        return new TextEncoder().encode("%PDF-1.4").buffer;
      }
      if (command === "save_compiled_pdf") return "/tmp/exported-paper.pdf";
      if (command === "synctex_edit") return reverseSyncTarget;
      if (command === "synctex_view") {
        const syncArgs = args as Record<string, unknown> | undefined;
        if (delayForwardSync && syncArgs?.path === "main.tex") {
          delayForwardSync = false;
          return new Promise((resolve) => {
            resolveForwardSync = resolve;
          });
        }
        if (
          forwardSyncFailure
          && syncArgs?.path === "main.tex"
          && syncArgs?.line === 1
        ) {
          throw new Error(forwardSyncFailure);
        }
        return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_compiled_pdf", {
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => {
      const compiledSource = vi.mocked(getDocument).mock.calls.at(-1)?.[0] as {
        data?: Uint8Array;
        url?: string;
      } | undefined;
      expect(compiledSource?.data).toBeInstanceOf(Uint8Array);
      expect(compiledSource?.data?.byteLength).toBe(8);
      expect(compiledSource?.url).toBeUndefined();
    });
    const savePdf = await screen.findByRole("button", { name: "Save PDF as…" });
    const pdfScrollArea = document.querySelector(".pdf-scroll-area")!;
    const pdfViewport = pdfScrollArea.querySelector("[data-slot='scroll-area-viewport']");
    expect(pdfViewport).not.toHaveClass("scroll-fade-both");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("PDF page 2")).toBeInTheDocument();
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalledTimes(2));
    // Every page gets a quick CSS-pixel preview before an offscreen high-DPI
    // refinement, so fast scrolling never waits on the final-quality pass.
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalledTimes(4));
    expect(renderTask.cancel).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.querySelector(".pdf-text-layer span")).toHaveTextContent("Attention is all you need");
    });
    expect(getPdfPageText).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getAllByTitle("https://example.com/paper").length).toBeGreaterThan(0);
    });
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2));
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    const fitWidth = screen.getByRole("button", { name: "Fit page to width" });
    const fitHeight = screen.getByRole("button", { name: "Fit page to height" });
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(fitHeight);
    expect(fitWidth).toHaveAttribute("aria-pressed", "false");
    expect(fitHeight).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(localStorage.getItem("lattice.pdf-view-preference.v1"))
      .toContain('"fitMode":"height"'));
    fireEvent.click(fitHeight);
    expect(fitHeight).toHaveAttribute("aria-pressed", "false");
    const pageInput = screen.getByLabelText("PDF page number");
    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "2" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });
    expect(pageInput).toHaveValue("2");
    const searchInput = screen.getByLabelText("Search PDF");
    const searchControl = searchInput.closest(".pdf-search")!;
    expect(searchControl.querySelector(":scope > svg")).not.toBeNull();
    fireEvent.change(searchInput, { target: { value: "attention" } });
    expect(searchControl.querySelector(":scope > svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    await waitFor(() => expect(getPdfPageText).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next search result" }));
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => {
      const exactHighlights = document.querySelectorAll("mark.pdf-text-match");
      expect(exactHighlights.length).toBe(2);
      expect(document.querySelectorAll("mark.pdf-text-match.selected").length).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear PDF search" }));
    expect(searchInput).toHaveValue("");
    expect(searchControl.querySelector(":scope > svg")).not.toBeNull();
    const revealCursor = screen.getByRole("button", { name: /Reveal cursor in PDF/i });
    const pdfZoomControls = fitWidth.closest(".pdf-zoom-controls");
    expect(pdfZoomControls).toContainElement(revealCursor);
    expect(pdfZoomControls?.querySelectorAll(".pdf-fit-divider")).toHaveLength(2);
    const pdfButtons = Array.from(pdfZoomControls!.querySelectorAll<HTMLElement>("button"));
    expect(pdfButtons.indexOf(revealCursor)).toBeLessThan(pdfButtons.indexOf(fitWidth));
    const editorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    expect(editorDom).not.toBeNull();
    const editorView = EditorView.findFromDOM(editorDom!);
    if (!editorView) throw new Error("CodeMirror editor view was not created.");
    let revealReconfigurations = 0;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
        revealReconfigurations += update.transactions.reduce(
          (count, transaction) => count + transaction.effects.filter(
            (effect) => effect.is(StateEffect.reconfigure),
          ).length,
          0,
        );
      })),
    });
    expect(fireEvent.mouseDown(revealCursor)).toBe(false);
    delayForwardSync = true;
    fireEvent.click(revealCursor);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", {
      path: "main.tex",
      line: 1,
      column: 0,
    }));
    editorView.dispatch({ selection: { anchor: 5 } });
    resolveForwardSync({ page: 1, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    expect(screen.queryByLabelText("Source location in PDF")).not.toBeInTheDocument();

    fireEvent.click(revealCursor);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", {
      path: "main.tex",
      line: 1,
      column: 5,
    }));
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
    const buildsBeforeManualRequest = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project").length;
    interfaceSounds.play.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
    // Identical PDF bytes must not thrash pdf.js — keep the same document + zoom.
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
    expect(zoomInput).toHaveValue(String(zoomBefore + 10));
    fireEvent.click(savePdf);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "paper.pdf" })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "save_compiled_pdf",
      expect.objectContaining({ byteLength: 8 }),
      { headers: { "x-pdf-destination": "L3RtcC9leHBvcnRlZC1wYXBlci5wZGY=" } },
    ));
    await expectNotification(/Saved to \/tmp\/exported-paper\.pdf/);
    const pdfPage = screen.getByLabelText("PDF page 1");
    // Double-click (not single click) jumps from the PDF back to the source.
    fireEvent.doubleClick(pdfPage, { clientX: 110, clientY: 220 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_edit", {
      page: 1,
      x: 91.667,
      y: 183.333,
    }));
    // A citation resolves into the bibliography, which has no preview of its
    // own. The jump must not close the PDF it was made from.
    reverseSyncTarget = { path: "references.bib", line: 4 };
    fireEvent.doubleClick(screen.getByLabelText("PDF page 1"), { clientX: 110, clientY: 220 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "references.bib",
      projectRoot: "/tmp/lattice-paper",
    }));
    // Still the same viewer instance, at the page the jump was made from: the
    // preview column follows the project's build, not the file in the editor.
    expect(screen.getByLabelText("PDF page 1")).toBeInTheDocument();
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
  });

  it("jumps out of a dual-pane preview into the pane that still holds an editor", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "chapter.tex", path: "chapter.tex", kind: "tex", children: [] },
      ],
    };
    persistWorkspaceLayout(snapshot.root, {
      openTabs: ["main.tex", "chapter.tex"],
      activeFile: "main.tex",
      activeTab: "main.tex",
      secondaryFile: "chapter.tex",
      focusedPane: "primary",
      canvasMode: "source",
      documentMode: "source",
      paperView: "blog",
      tabRecency: ["chapter.tex", "main.tex"],
    });
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          convertToViewportPoint: (x: number, y: number) => [x, y],
        }),
        render: vi.fn(() => renderTask),
        streamTextContent: () => new ReadableStream(),
        getTextContent: async () => ({ items: [] }),
        getAnnotations: async () => [],
        cleanup: vi.fn(),
      })),
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    };
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    const NativeURL = globalThis.URL;
    class TestURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:lattice-dual-pdf");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return `content:${(args as { path: string }).path}`;
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return {
        success: true,
        hasPdf: true,
        log: "",
        durationMs: 1,
        diagnostics: [],
        rootDocument: "main.tex",
      };
      if (command === "read_compiled_pdf") {
        return new TextEncoder().encode("%PDF-1.4").buffer;
      }
      if (command === "synctex_edit") return { path: "chapter.tex", line: 2 };
      if (command === "synctex_view") return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    // Two editors side by side, then turn one of them into the PDF preview.
    fireEvent.click(await screen.findByRole("button", { name: "Split editor right" }));
    await waitFor(() => expect(document.querySelector(
      ".source-editor[data-editor-pane='secondary'] .cm-content",
    )).toHaveTextContent("content:chapter.tex"));
    fireEvent.click(within(await screen.findByRole("tablist", { name: "Document view" }))
      .getByRole("tab", { name: "Preview" }));
    const pdfPage = await screen.findByLabelText("PDF page 1");
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();

    fireEvent.doubleClick(pdfPage, { clientX: 110, clientY: 220 });
    // The double-click is live here: the other pane is an editor to land in.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "synctex_edit",
      expect.objectContaining({ page: 1 }),
    ));
    // And the layout the reader arranged survives the jump.
    expect(document.querySelector(".dual-canvas")).toBeInTheDocument();
    expect(document.querySelector(".dual-pane-preview .pdf-column")).toBeInTheDocument();
    expect(document.querySelector(".source-editor")).toBeInTheDocument();
  });

  it("lists successful-build diagnostics and jumps to the reported source line", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        {
          name: "chapters",
          path: "chapters",
          kind: "directory",
          children: [{ name: "intro.tex", path: "chapters/intro.tex", kind: "tex", children: [] }],
        },
      ],
    };
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
      "chapters/intro.tex": "\\section{Intro}\none\ntwo\nthree\nfour\n",
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        return files[path] ?? "";
      }
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        return {
          success: true,
          pdfBase64: null,
          log: "chapters/intro.tex:4: Overfull hbox.\n",
          durationMs: 80,
          diagnostics: [{
            file: "/tmp/lattice-paper/./chapters/intro.tex",
            line: 4,
            level: "warning",
            message: "Overfull hbox.",
          }],
        };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const diagnosticsPanel = await screen.findByLabelText("Compile diagnostics");
    const visibleBuildToasts = () => getVisibleAppToastIds()
      .map((id) => getAppLogEntry(id))
      .filter((entry) => entry?.source === "Build");
    expect(visibleBuildToasts()).toEqual([]);
    // Initial and autosave builds are intentionally silent.
    expect(interfaceSounds.play).not.toHaveBeenCalled();
    const buildsBeforeManualRequest = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project").length;
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
    expect(visibleBuildToasts()).toEqual([]);
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "chapters/intro.tex",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.toString()).toContain("\\section{Intro}");
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    });
  });

  it("shows a failed build only as a global error toast", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") {
        return {
          success: false,
          pdfBase64: null,
          log: "Undefined control sequence.\n",
          durationMs: 80,
          diagnostics: [{ level: "error", message: "Undefined control sequence." }],
        };
      }
      return mockAppCommand(command);
    });

    renderApp();
    await waitFor(() => {
      const toasts = getVisibleAppToastIds()
        .map((id) => getAppLogEntry(id))
        .filter((entry) => entry?.source === "Build");
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({
        level: "error",
        title: "Build failed",
      });
    });
    expect(screen.queryByLabelText("Compile diagnostics")).not.toBeInTheDocument();
    expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
  });

  it("saves dirty buffers before switching project files", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}",
      "intro.tex": "\\section{Intro}",
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        return files[path] ?? "";
      }
      if (command === "write_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        const content = String((args as { content?: string } | undefined)?.content ?? "");
        files[path] = content;
        return undefined;
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nDraft change." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nDraft change.",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "intro.tex",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => {
      const next = document.querySelector<HTMLElement>(".cm-editor");
      const nextView = next ? EditorView.findFromDOM(next) : null;
      expect(nextView?.state.doc.toString()).toBe("\\section{Intro}");
    });
  });

  it("keeps the latest file active when an earlier read resolves afterward", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
        { name: "notes.tex", path: "notes.tex", kind: "tex", children: [] },
      ],
    };
    let resolveIntro!: (content: string) => void;
    let resolveNotes!: (content: string) => void;
    const intro = new Promise<string>((resolve) => { resolveIntro = resolve; });
    const notes = new Promise<string>((resolve) => { resolveNotes = resolve; });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        if (path === "intro.tex") return intro;
        if (path === "notes.tex") return notes;
        return "main";
      }
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    fireEvent.click(await findProjectTreeItem("notes.tex"));
    await act(async () => { resolveNotes("latest notes"); });
    await waitFor(() => expect(screen.getByRole("tab", { name: /notes\.tex/ })).toHaveAttribute("aria-selected", "true"));
    await act(async () => { resolveIntro("stale intro"); });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /notes\.tex/ })).toHaveAttribute("aria-selected", "true");
      const editor = document.querySelector<HTMLElement>(".cm-editor");
      expect(editor ? EditorView.findFromDOM(editor)?.state.doc.toString() : null).toBe("latest notes");
    });
  });

  it("opens a recent project in its own window and leaves this one alone", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: "/tmp/notes" },
      { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
    ]));
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return notesSnapshot;
      if (command === "read_project_file") return "# Private draft";
      if (command === "open_project_window") return { label: "project-1", focusedExisting: false };
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("# Private draft");
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Overleaf paper" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_project_window", {
      path: "/tmp/overleaf-paper",
    }));
    // The point of the feature: this window keeps the project and the buffer it
    // already had, rather than being taken over by the one just opened.
    expect(invoke).not.toHaveBeenCalledWith("open_project", { path: "/tmp/overleaf-paper" });
    const element = document.querySelector<HTMLElement>(".cm-editor");
    const view = element ? EditorView.findFromDOM(element) : null;
    expect(view?.state.doc.toString()).toBe("# Private draft");
  });

  it("joins a live collaboration in the current window", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem("lattice.collab.name", "Ada");
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    const sharedSnapshot = {
      ...notesSnapshot,
      root: "/tmp/Lattice Shares/Shared room",
      manifest: { ...notesSnapshot.manifest, projectId: "shared-id", name: "Shared room" },
      files: [],
    };
    const projectInstanceId = "project_1234567890abcdef1234567890abcdef";
    const invitation = formatCollabInvitationV2({
      version: 2,
      deployment: "https://collab.example",
      projectInstanceId,
      guestSecret: "A".repeat(43),
      permission: "write",
      projectName: "Shared room",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      protocol: 2,
      projectInstanceId,
      name: "Shared room",
      lifecycle: "live",
      catalogRevision: 1,
      snapshotGeneration: 0,
      workspaceLeaseGeneration: 0,
      authorityEpoch: 1,
      files: [],
    }), { headers: { "content-type": "application/json" } })));
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return notesSnapshot;
      if (command === "read_project_file") return "# Private draft";
      if (command === "put_collab_credential") return undefined;
      if (command === "create_collab_join_workspace") return sharedSnapshot;
      if (command === "open_project") throw new Error("stop after binding the current window");
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-tour="collaboration"]')!);
    fireEvent.click(await screen.findByRole("tab", { name: "Join" }));
    fireEvent.change(screen.getByLabelText("Collab invite"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "Join share" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_project", {
      path: sharedSnapshot.root,
    }));
    expect(invoke).not.toHaveBeenCalledWith("open_project_window", expect.anything());
  });

  it("shows share-start progress in the selected interface language", async () => {
    await activateAppLocale("zh-CN");
    localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: "zh-CN" }));
    localStorage.setItem("lattice.collab.name", "Ada");
    const snapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    const inventoryFailure: { reject: ((reason: Error) => void) | null } = { reject: null };
    const inventory = new Promise<never>((_resolve, reject) => {
      inventoryFailure.reject = reject;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "# Private draft";
      if (command === "harper_lint") return [];
      if (command === "collab_project_inventory_v2") return inventory;
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-tour="collaboration"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "开始共享" }));

    expect(await screen.findByRole("status")).toHaveTextContent("正在扫描项目文件…");
    await act(async () => inventoryFailure.reject?.(new Error("stop after localized status")));
    expect(await screen.findByRole("status")).toHaveTextContent("导入失败——请重新点击“开始共享”");
  });

  it("gives a newly created project its own window when one is already open", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    const created = { ...notesSnapshot, root: "/tmp/new-paper" };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return notesSnapshot;
      if (command === "read_project_file") return "# Private draft";
      if (command === "create_project") return created;
      if (command === "open_project_window") return { label: "project-1", focusedExisting: false };
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("# Private draft");
    });

    vi.mocked(open).mockResolvedValue("/tmp");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New project" }));
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_project_window", {
      path: "/tmp/new-paper",
    }));
    // The window that was in use keeps its project and its buffer.
    expect(invoke).not.toHaveBeenCalledWith("open_project", { path: "/tmp/new-paper" });
    const element = document.querySelector<HTMLElement>(".cm-editor");
    const view = element ? EditorView.findFromDOM(element) : null;
    expect(view?.state.doc.toString()).toBe("# Private draft");
  });

  it("opens a folder chosen from the picker in its own window too", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return notesSnapshot;
      if (command === "read_project_file") return "# Private draft";
      if (command === "open_project_window") return { label: "project-1", focusedExisting: false };
      if (command === "list_papers" || command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("# Private draft");
    });

    vi.mocked(open).mockResolvedValue("/tmp/other");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open another folder" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_project_window", {
      path: "/tmp/other",
    }));
    expect(invoke).not.toHaveBeenCalledWith("open_project", { path: "/tmp/other" });
  });

  it("does not carry an open Markdown buffer into the next project", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: "/tmp/notes" },
      { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
    ]));
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    const overleafSnapshot = {
      root: "/tmp/overleaf-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "overleaf-id",
        name: "Overleaf paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    let currentRoot = notesSnapshot.root;
    let releaseIncomingPapers!: (papers: never[]) => void;
    const incomingPapers = new Promise<never[]>((resolve) => {
      releaseIncomingPapers = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return notesSnapshot;
      if (command === "open_tutorial_project") {
        currentRoot = overleafSnapshot.root;
        return overleafSnapshot;
      }
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        if (currentRoot === notesSnapshot.root && path === "draft.md") return "# Private draft";
        if (currentRoot === overleafSnapshot.root && path === "main.tex") return "\\documentclass{article}";
        return "";
      }
      if (command === "list_papers") {
        return currentRoot === overleafSnapshot.root ? incomingPapers : [];
      }
      if (command === "list_history") return [];
      if (command === "write_project_file") return undefined;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const initialEditor = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("# Private draft");
      return view!;
    });
    const insertedText = "\nLocal only.";
    const savedCursor = initialEditor.state.doc.length + insertedText.length;
    initialEditor.dispatch({
      changes: { from: initialEditor.state.doc.length, insert: insertedText },
      selection: { anchor: savedCursor },
    });

    // Driven through the tutorial, which is one of the flows that still
    // replaces the project in this window. Choosing a project — from the
    // recent list or a folder — now opens a window of its own instead, but
    // every in-place switch still runs this same save/transition/enter path.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Guided tutorial" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_tutorial_project"));
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("");
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const writes = vi.mocked(invoke).mock.calls.filter(([command]) => command === "write_project_file");
    expect(writes).toEqual([
      ["write_project_file", {
        path: "draft.md",
        content: "# Private draft\nLocal only.",
        projectRoot: "/tmp/notes",
      }],
    ]);
    const storedViews = JSON.parse(
      localStorage.getItem("lattice.file-view-states.v1") ?? "{}",
    ) as Record<string, Record<string, { text?: { cursor: number; scrollTop: number } }>>;
    expect(storedViews["/tmp/notes"]?.["draft.md"]?.text).toEqual({
      cursor: savedCursor,
      scrollTop: 0,
    });
    expect(storedViews["/tmp/overleaf-paper"]?.["draft.md"]).toBeUndefined();

    releaseIncomingPapers([]);
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("\\documentclass{article}");
    });
  });

  it("does not auto-sync the next project against Overleaf when it is not linked", async () => {
    // Switching away from a linked project has one render where the new root
    // is in but the old link state is not yet cleared; auto-sync firing in
    // that window raised "Sync failed: This project is not linked to an
    // Overleaf project." at the local project.
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
      { name: "Notes", path: "/tmp/notes" },
    ]));
    const overleafSnapshot = {
      root: "/tmp/overleaf-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "overleaf-id",
        name: "Overleaf paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    const notesSnapshot = {
      root: "/tmp/notes",
      manifest: {
        schemaVersion: 1,
        projectId: "notes-id",
        name: "Notes",
        rootDocuments: [],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "draft.md", path: "draft.md", kind: "markdown", children: [] }],
    };
    let currentRoot = overleafSnapshot.root;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return overleafSnapshot;
      if (command === "open_tutorial_project") {
        currentRoot = notesSnapshot.root;
        return notesSnapshot;
      }
      if (command === "refresh_project") {
        return currentRoot === overleafSnapshot.root ? overleafSnapshot : notesSnapshot;
      }
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        if (path === "main.tex") return "\\documentclass{article}";
        if (path === "draft.md") return "# Local notes";
        return "";
      }
      if (command === "overleaf_link") {
        // The backend reads the link off the currently open project; a local
        // project simply has no state file.
        if (currentRoot !== overleafSnapshot.root) {
          throw new Error("This project is not linked to an Overleaf project.");
        }
        return {
          projectId: "ol-123",
          projectName: "Overleaf paper",
          host: "https://www.overleaf.com",
          lastSync: null,
          paused: false,
        };
      }
      if (command === "overleaf_sync") {
        return {
          pulled: [],
          pushed: [],
          merged: [],
          conflicts: [],
          deletedLocal: [],
          skippedRemoteDeletes: [],
        };
      }
      if (command === "overleaf_probe") {
        return { changed: false, versionKnown: true, remoteVersion: 1, lastSync: null };
      }
      if (command === "overleaf_rt_connect") {
        return {
          publicId: null,
          rootFolderId: "root",
          docs: [],
          entities: [],
          permission: "readAndWrite",
          trackChanges: false,
          userId: null,
        };
      }
      if (command === "overleaf_status") {
        return { connected: true, email: "me@example.com", name: "Me", host: "https://www.overleaf.com" };
      }
      if (
        command === "overleaf_rt_disconnect"
        || command === "write_project_file"
        || command === "git_auto_commit"
      ) return command === "git_auto_commit" ? null : undefined;
      if (
        command === "overleaf_chat_messages"
        || command === "overleaf_threads"
        || command === "overleaf_comment_anchors"
        || command === "overleaf_change_authors"
        || command === "overleaf_rt_connected_users"
        || command === "list_papers"
        || command === "list_history"
      ) return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    // The linked project's own first-open auto-sync is the positive control:
    // the machinery is live, and it aims at the linked root.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_sync", expect.objectContaining({
      projectRoot: "/tmp/overleaf-paper",
    })));

    // The tutorial is one of the flows that still replaces the project in this
    // window; choosing a project now opens a window of its own instead.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switch project" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Guided tutorial" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_tutorial_project"));
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      const view = element ? EditorView.findFromDOM(element) : null;
      expect(view?.state.doc.toString()).toBe("# Local notes");
    });
    // The stale-link window has passed by the time the new project renders;
    // give pending promises a beat and confirm nothing aimed at it.
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    const syncRoots = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "overleaf_sync")
      .map(([, callArgs]) => (callArgs as { projectRoot?: string } | undefined)?.projectRoot);
    expect(syncRoots).toEqual(["/tmp/overleaf-paper"]);
    const probeRoots = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "overleaf_probe")
      .map(([, callArgs]) => (callArgs as { projectRoot?: string } | undefined)?.projectRoot);
    expect(probeRoots).not.toContain("/tmp/notes");
  });

  it("does not make file switching wait for post-save project scans", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "intro.tex", path: "intro.tex", kind: "tex", children: [] },
      ],
    };
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}",
      "intro.tex": "\\section{Intro}",
    };
    let blockHistory = false;
    let resolveHistory!: (items: never[]) => void;
    const delayedHistory = new Promise<never[]>((resolve) => {
      resolveHistory = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        return files[path] ?? "";
      }
      if (command === "write_project_file") {
        const path = String((args as { path?: string } | undefined)?.path ?? "");
        const content = String((args as { content?: string } | undefined)?.content ?? "");
        files[path] = content;
        blockHistory = true;
        return undefined;
      }
      if (command === "list_history") return blockHistory ? delayedHistory : [];
      if (command === "list_papers") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nDraft change." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.click(await findProjectTreeItem("intro.tex"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "intro.tex",
      projectRoot: "/tmp/lattice-paper",
    }));
    resolveHistory([]);
  });

  it("shows only edit and delete actions on a Papers row", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true };
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "See ";
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    await switchSidebarMode("Papers");
    expect(screen.queryByTitle("Insert citation for vaswani2017attention")).not.toBeInTheDocument();
    expect(await screen.findByTitle("Edit bibliography entry")).toBeInTheDocument();
    expect(await screen.findByTitle("Remove Attention Is All You Need")).toBeInTheDocument();
  });

  it("saves the visible source before checking whether a paper is still cited", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const paper = { arxivId: "2407.06438", title: "A Single Transformer", citationKey: "chen2024single", hasFullText: true };
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    let diskSource = "See \\cite{chen2024single}.\n";
    let sourceAtPreview = "";
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "main.tex" ? diskSource : "";
      }
      if (command === "write_project_file") {
        const write = args as { path: string; content: string };
        if (write.path === "main.tex") diskSource = write.content;
        return undefined;
      }
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "remove_reference") {
        const citationMode = (args as { citationMode?: string }).citationMode;
        if (citationMode === "preview") {
          sourceAtPreview = diskSource;
          return { key: paper.citationKey, removed: false, blockers: [], changedFiles: [], removedCitations: 0 };
        }
        return { key: paper.citationKey, removed: true, blockers: [], changedFiles: ["references.bib"], removedCitations: 0 };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "The citation was removed.\n" } });

    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    await waitFor(() => expect(sourceAtPreview).toBe("The citation was removed.\n"));
    expect(sourceAtPreview).not.toContain("chen2024single");
  });

  it("offers cited-paper removal with and without its citation commands", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const paper = { arxivId: "2407.06438", title: "A Single Transformer", citationKey: "chen2024single", hasFullText: true };
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    let diskSource = "See \\cite{chen2024single}.\n";
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "main.tex" ? diskSource : "";
      }
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "remove_reference") {
        const citationMode = (args as { citationMode?: string }).citationMode;
        if (citationMode === "preview") {
          return {
            key: paper.citationKey,
            removed: false,
            blockers: [{ kind: "citation", symbol: paper.citationKey, role: "reference", path: "main.tex", line: 1, snippet: diskSource }],
            changedFiles: [],
            removedCitations: 0,
          };
        }
        const before = diskSource;
        if (citationMode === "remove") diskSource = "See .\n";
        return {
          key: paper.citationKey,
          removed: true,
          blockers: [],
          changedFiles: citationMode === "remove" ? ["main.tex", "references.bib"] : ["references.bib"],
          removedCitations: citationMode === "remove" ? 1 : 0,
          transactionId: "remove-chen",
          changes: citationMode === "remove"
            ? [
                { path: "main.tex", before, after: diskSource },
                { path: "references.bib", before: "@article{chen2024single}\n", after: "" },
              ]
            : [{ path: "references.bib", before: "@article{chen2024single}\n", after: "" }],
        };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<ConfirmActionProvider><App /></ConfirmActionProvider>);
    await switchSidebarMode("Papers");
    fireEvent.click(await screen.findByTitle("Remove A Single Transformer"));
    const dialog = await screen.findByRole("dialog", { name: "Remove “A Single Transformer” from the bibliography?" });
    expect(dialog).toHaveAccessibleDescription(/cited in 1 place.*main\.tex:1.*leave them unresolved/i);
    fireEvent.click(screen.getByRole("button", { name: "Remove citations too" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_reference", {
      key: "chen2024single",
      citationMode: "remove",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>(".cm-editor");
      expect(editor ? EditorView.findFromDOM(editor)?.state.doc.toString() : null).toBe("See .\n");
    });
  });

  it("deletes a history entry without creating another one", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    let entries = [{ id: "change-1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z", files: ["main.tex"] }];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [];
      if (command === "list_history") return entries;
      if (command === "get_history_entry") {
        return {
          id: "change-1",
          label: "Edit main.tex",
          timestamp: "2026-07-16T00:00:00Z",
          changes: [{ path: "main.tex", before: "old line\n", after: "new line\n" }],
        };
      }
      if (command === "delete_history_entry") {
        entries = [];
        return undefined;
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Project history" }));
    // HistoryDrawer is lazy-loaded, so wait for its chunk to resolve.
    fireEvent.click(await screen.findByRole("button", { name: /Edit main\.tex/i }));
    await screen.findByLabelText("Diff for main.tex");
    fireEvent.click(await screen.findByTitle("Delete this history entry"));

    await waitFor(() => expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("delete_history_entry", { transactionId: "change-1" });
  });

  it("shows the document outline and jumps to a section", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{
        name: "sections",
        path: "sections",
        kind: "folder",
        children: [{ name: "introduction.tex", path: "sections/introduction.tex", kind: "tex", children: [] }],
      }],
    };
    const syncResolvers: Array<(target: { page: number; x: number; y: number; width: number; height: number }) => void> = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        if ((args as { path?: string } | undefined)?.path === "sections/introduction.tex") {
          return "\\subsection{Background}\ntext\n";
        }
        return "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\input{sections/introduction}\n\\section{Results}\n\\end{document}\n";
      }
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 1, diagnostics: [] };
      if (command === "synctex_view") {
        return new Promise((resolve) => syncResolvers.push(resolve));
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    expect(await screen.findByLabelText("Show document outline")).toBeInTheDocument();
    fireEvent.click(await screen.findByTitle("Show outline"));
    expect(await screen.findByLabelText("Document outline")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Background/i })).toBeInTheDocument();
    expect(screen.queryByText("sections/introduction.tex")).not.toBeInTheDocument();
    expect(screen.queryByText("\\input{sections/introduction.tex}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Results/i }));
    const editorView = await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
      return view!;
    });
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
    await waitFor(() => {
      const currentEditor = document.querySelector<HTMLElement>(".cm-editor");
      const currentView = currentEditor ? EditorView.findFromDOM(currentEditor) : null;
      expect(currentView?.state.doc.lineAt(currentView.state.selection.main.head).number).toBe(5);
    });
    const idsBeforeLatestResponse = randomUUID.mock.calls.length;
    syncResolvers[1]({ page: 2, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(randomUUID).toHaveBeenCalledTimes(idsBeforeLatestResponse + 1));
  });

  it("opens a rich insert palette with previews", { timeout: 20000 }, async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\begin{document}\n\n\\end{document}\n";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 1, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" }));
    const palette = await screen.findByLabelText("Insert LaTeX snippets");
    expect(palette).toHaveClass("resizable-drawer");
    expect(within(palette).getByRole("separator", { name: "Resize right panel" })).toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: /Alpha/i })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("tab", { name: "Symbols" }));
    expect(palette.querySelector(".sliding-tab-underline")).not.toBeInTheDocument();
    expect(within(palette).getByRole("tab", { name: "Symbols" })).toHaveAttribute("aria-selected", "true");
    expect(within(palette).getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");
    // The eight symbol groups share one tab and stay as headed sections inside it.
    expect(within(palette).getByRole("heading", { name: /Greek/ })).toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: /Capital omega/i })).toBeInTheDocument();
    expect(within(palette).queryByRole("button", { name: /Bulleted list/i })).not.toBeInTheDocument();

    const documentView = screen.getByRole("tablist", { name: "Document view" });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" }))
        .not.toBeInTheDocument();
      expect(screen.queryByLabelText("Insert LaTeX snippets")).not.toBeInTheDocument();
    });

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    expect(await screen.findByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("Insert LaTeX snippets")).not.toBeInTheDocument();
  });

  it("creates and deletes project entries and imported papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      "/tmp/lattice-paper": {
        "notes.tex": { text: { cursor: 8, scrollTop: 40 } },
      },
    }));
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [
          { path: "main.tex", name: "Main paper", isDefault: true },
          // Building a standalone draft registers it here, but does not make it protected.
          { path: "notes.tex", name: "Notes", isDefault: false },
        ],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [
        { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
        { name: "notes.tex", path: "notes.tex", kind: "tex", children: [] },
      ],
    };
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\section{Notes}";
      if (command === "list_papers") return [paper];
      if (command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "create_project_entry") {
        const entry = args as { path: string; kind: "file" | "folder" };
        return entry.kind === "file" && !entry.path.includes(".")
          ? `${entry.path}.tex`
          : entry.path;
      }
      if (command === "delete_project_entry") return undefined;
      if (command === "remove_reference") return { removed: true, blockers: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const projectTreeSurface = await screen.findByLabelText("Project files");
    fireEvent.contextMenu(projectTreeSurface);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    const fileNameInput = await findProjectTreeRenameInput();
    expect(fileNameInput).toHaveValue("untitled");
    fireEvent.input(fileNameInput, { target: { value: "method" } });
    fireEvent.keyDown(fileNameInput, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project_entry", {
      path: "method",
      kind: "file",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /method\.tex/ })).toBeInTheDocument();

    fireEvent.contextMenu(projectTreeSurface);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const folderNameInput = await findProjectTreeRenameInput();
    expect(folderNameInput).toHaveValue("untitled");
    fireEvent.input(folderNameInput, { target: { value: "draft" } });
    fireEvent.keyDown(folderNameInput, { key: "Escape" });
    await waitFor(() => expect(projectTreeRoot()?.querySelector("[data-item-rename-input]")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "draft", kind: "folder" });
    expect(queryProjectTreeItem("draft/")).toBeNull();

    fireEvent.contextMenu(projectTreeSurface);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const unchangedFolderInput = await findProjectTreeRenameInput();
    expect(unchangedFolderInput).toHaveValue("untitled");
    fireEvent.blur(unchangedFolderInput);
    await waitFor(() => expect(queryProjectTreeItem("untitled/")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "untitled", kind: "folder" });

    fireEvent.contextMenu(projectTreeSurface);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    const nextFileInput = await findProjectTreeRenameInput();
    expect(nextFileInput).toHaveValue("untitled");
    fireEvent.keyDown(nextFileInput, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project_entry", {
      path: "untitled",
      kind: "file",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await findProjectTreeItem("untitled.tex")).toBeInTheDocument();

    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();

    fireEvent.click(await findProjectTreeItem("notes.tex"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /notes\.tex/ }))
      .toHaveAttribute("aria-selected", "true"));
    fireEvent.contextMenu(await findProjectTreeItem("notes.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_project_entry", {
      path: "notes.tex",
      projectRoot: "/tmp/lattice-paper",
    }));
    await waitFor(() => {
      const states = JSON.parse(
        localStorage.getItem("lattice.file-view-states.v1") ?? "{}",
      ) as Record<string, Record<string, unknown>>;
      expect(states["/tmp/lattice-paper"]?.["notes.tex"]).toBeUndefined();
    });
    await switchSidebarMode("Papers");
    fireEvent.click(screen.getByTitle("Remove Attention Is All You Need"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_reference", {
      key: "vaswani2017attention",
      projectRoot: "/tmp/lattice-paper",
    }));
  });

  it("creates a board from the header button with an inline name", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "notes.tex", path: "notes.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "";
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "create_project_entry") return (args as { path: string }).path;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByLabelText("Project files");
    fireEvent.click(screen.getByRole("button", { name: "New board" }));
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput).toHaveValue("untitled");
    fireEvent.input(nameInput, { target: { value: "sketch" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project_entry", {
      path: "sketch.tldr",
      kind: "file",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByTestId("board-editor-mock")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" }))
      .not.toBeInTheDocument();
  });

  it("creates a spreadsheet from the header button with an inline name", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: {
        schemaVersion: 1,
        projectId: "paper-id",
        name: "Lattice paper",
        rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
        primaryBibliography: "references.bib",
        trusted: false,
      },
      files: [{ name: "notes.tex", path: "notes.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "";
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "create_project_entry") return (args as { path: string }).path;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByLabelText("Project files");
    fireEvent.click(screen.getByRole("button", { name: "New spreadsheet" }));
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput).toHaveValue("untitled");
    fireEvent.input(nameInput, { target: { value: "results" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project_entry", {
      path: "results.lattice-sheet",
      kind: "file",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert snippet or symbol (⌘⇧I)" }))
      .not.toBeInTheDocument();
  });

});
