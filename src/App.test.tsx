import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { mayApplyProjectRefreshV2, planRemoteCollabDeleteUiV2 } from "./App";
import { clearAppLogs, formatAppLogs } from "./app-log-store";
import { persistWorkspaceLayout } from "./app-settings";
import { loadTextLanguageExtensions } from "./document-canvas";
import { referenceAssetPreviewDataUrl } from "./reference-preview";
import { usePanelLayout } from "./use-panel-layout";
import { parseVisualMarkdown } from "./visual-markdown-schema";
import type { SynaraRuntimeInfo } from "./synara-runtime";

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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
vi.mock("./use-synara-runtime", () => ({
  useSynaraRuntime: (enabled = true) => {
    synaraHook.enabledCalls.push(enabled);
    return synaraHook;
  },
}));

describe("remote collaboration deletion UI", () => {
  it("closes a background tab without disturbing the active document", () => {
    expect(planRemoteCollabDeleteUiV2({
      path: "notes.md",
      activeFile: "paper.md",
      secondaryFile: null,
      openTabs: ["paper.md", "notes.md"],
      tabRecency: ["notes.md", "paper.md"],
      liveTextPaths: ["paper.md"],
    })).toEqual({
      openTabs: ["paper.md"],
      tabRecency: ["paper.md"],
      deletedActive: false,
      deletedSecondary: false,
      replacement: null,
    });
  });

  it("clears a deleted secondary document and selects the preferred live replacement for an active deletion", () => {
    const secondary = planRemoteCollabDeleteUiV2({
      path: "side.md",
      activeFile: "paper.md",
      secondaryFile: "side.md",
      openTabs: ["paper.md", "side.md"],
      tabRecency: ["side.md", "paper.md"],
      liveTextPaths: ["paper.md"],
    });
    expect(secondary.deletedSecondary).toBe(true);
    expect(secondary.deletedActive).toBe(false);

    expect(planRemoteCollabDeleteUiV2({
      path: "paper.md",
      activeFile: "paper.md",
      secondaryFile: null,
      openTabs: ["paper.md", "appendix.md"],
      tabRecency: ["paper.md", "appendix.md"],
      liveTextPaths: ["appendix.md", "index.md"],
      preferredPaths: ["index.md", "appendix.md"],
    })).toEqual({
      openTabs: ["appendix.md"],
      tabRecency: ["appendix.md"],
      deletedActive: true,
      deletedSecondary: false,
      replacement: "index.md",
    });
  });

  it("rejects a pre-delete project refresh or sidebar poll after the post-delete refresh starts", () => {
    const scope = { expectedRoot: "/tmp/project", generation: 4 };
    expect(mayApplyProjectRefreshV2({
      refreshGeneration: 8,
      currentRefreshGeneration: 9,
      scope,
      currentProjectGeneration: 4,
      currentRoot: "/tmp/project",
      snapshotRoot: "/tmp/project",
    })).toBe(false);
    expect(mayApplyProjectRefreshV2({
      refreshGeneration: 9,
      currentRefreshGeneration: 9,
      scope,
      currentProjectGeneration: 4,
      currentRoot: "/tmp/project",
      snapshotRoot: "/tmp/project",
    })).toBe(true);
  });
});
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

async function findProjectTreeSearchInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const input = projectTreeRoot()?.querySelector<HTMLInputElement>("[data-file-tree-search-input]");
    expect(input).not.toBeNull();
    return input!;
  });
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
    expect(localStorage.getItem("lattice.theme.v1")).toBe("dark");
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
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getByText("Open a project to manage Agent settings.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
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

  it("persists the opt-in editor spellcheck setting", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    const spellcheck = screen.getByLabelText("Check spelling in prose");
    expect(spellcheck).not.toBeChecked();
    fireEvent.click(spellcheck);
    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v5")).toContain('"editorSpellcheck":true'));
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

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    fireEvent.click(await findProjectTreeItem("conference.sty"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /conference\.sty/ }))
      .toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.querySelector(".source-editor")).not.toBeNull());

    fireEvent.click(await findProjectTreeItem("main.tex"));
    expect(await screen.findByRole("separator", { name: "Resize editor and PDF preview" }))
      .toBeInTheDocument();
  });

  it("restores tab order, active pane, and column layout after relaunch", async () => {
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

    await waitFor(() => expect(document.querySelector(".columns-canvas")).toBeInTheDocument());
    expect(Array.from(document.querySelectorAll<HTMLElement>(".editor-tab"))
      .map((tab) => tab.dataset.tabPath)).toEqual(["intro.tex", "main.tex", "method.tex"]);
    expect(screen.getByRole("tab", { name: /method\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".dual-pane-label")).toHaveTextContent("method.tex");
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
      canvasMode: "columns",
      documentMode: "columns",
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

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(document.querySelector(".markdown-preview")).toBeNull();

    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const splitEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    expect(splitEditorDom).not.toBeNull();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(screen.getByTestId("editor-scroll-container")).toHaveStyle({ overflowAnchor: "none" });
    const splitEditor = splitEditorDom ? EditorView.findFromDOM(splitEditorDom) : null;
    if (!splitEditor) throw new Error("Markdown split editor was not created.");
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

    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    expect(screen.getByTestId("editor-scroll-container").style.overflowAnchor).toBe("");
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
      files: [{ name: "report.html", path: "report.html", kind: "html", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") {
        return (args as { path: string }).path === "report.html"
          ? "<!doctype html><html><head><base href='https://example.com/'><style>h1{color:tomato}</style></head><body><h1 id='results'>Results</h1><button onclick='this.textContent=&quot;Done&quot;'>Run</button><a href='./details.html'>Details</a><a href='#results'>Jump</a><script>window.previewReady=true</script></body></html>"
          : "\\documentclass{article}";
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
    expect(synaraHook.enabledCalls).toContain(true);
    await switchSidebarMode("Agent");
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

  it("routes agent review requests to the editor or the changes drawer", async () => {
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
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, hasPdf: false, log: "", durationMs: 5, diagnostics: [] };
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
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
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "stat_project_file") return { exists: true, mtimeMs: 1 };
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, hasPdf: false, log: "", durationMs: 5, diagnostics: [] };
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

    renderApp();
    await screen.findByRole("button", { name: "Switch project" });
    await switchSidebarMode("Agent");
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(element).not.toBeNull();
      return element!;
    });

    // The first snapshot for a thread replays its existing history; it must
    // prime the fingerprints without scheduling a rebuild.
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 1, deletions: 0 }])]);
    const baseline = buildCalls();
    await new Promise((resolvePause) => setTimeout(resolvePause, 2_200));
    expect(buildCalls()).toBe(baseline);

    // The same checkpoint growing new file work is fresh agent editing.
    postSnapshot(frame, [checkpoint([{ path: "sections/intro.tex", additions: 5, deletions: 2 }])]);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 1), { timeout: 4_000 });
  });

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
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toHaveClass("w-52");
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
      "981",
    );
    await waitFor(() => expect(windowApi.setMinSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1302, height: 680 }),
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
    const box = await screen.findByPlaceholderText("arXiv id, DOI, URL, or title");
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
        hasFullText: true,
        hasBlog: true,
      }];
      if (command === "list_history") return [];
      if (command === "read_paper") {
        return "---\ntitle: Attention Is All You Need\nnotes: |\n  - [ ] Hidden metadata task\n---\n\n## Abstract\n\n- [ ] Review paper";
      }
      if (command === "read_paper_blog") return "# Attention overview\n\nA concise explanation.";
      if (command === "write_project_file") return undefined;
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    await switchSidebarMode("Papers");
    const paper = await screen.findByRole("button", { name: /Attention Is All You Need.*1706\.03762/i });
    fireEvent.click(paper);
    expect(await screen.findByText("Attention Is All You Need", { selector: ".active-document span" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
    expect(document.querySelector(".paper-reader")).toBeNull();
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Attention overview" })).toBeInTheDocument();

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
    expect(await screen.findByRole("heading", { name: "Abstract" })).toBeInTheDocument();
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
      if (command === "read_paper_blog") return "# Attention overview\n\nBlog content.";
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

  it("uses Pierre path search while keeping indexed full-text search available", async () => {
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
      files: [{ name: "method.tex", path: "sections/method.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "line one\nline two\nA latent alignment objective.\n";
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "search_project") return [
        { kind: "file", path: "sections/method.tex", title: "method.tex", snippet: "A latent alignment objective.", line: 3, fileKind: "tex" },
        { kind: "paper", path: ".research/papers/1706.03762/paper.md", title: paper.title, snippet: "The model relies entirely on self-attention.", arxivId: paper.arxivId },
      ];
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const searchToggle = await screen.findByRole("button", { name: "Search files" });
    fireEvent.click(searchToggle);
    let input = await findProjectTreeSearchInput();
    input.focus();
    expect(fireEvent.pointerDown(searchToggle)).toBe(false);
    fireEvent.click(searchToggle);
    await waitFor(() => expect(searchToggle).toHaveAttribute("aria-pressed", "false"));

    fireEvent.click(searchToggle);
    input = await findProjectTreeSearchInput();
    fireEvent.input(input, { target: { value: "method" } });
    expect(await findProjectTreeItem("sections/method.tex")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("search_project", expect.anything());

    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    fireEvent.change(await screen.findByLabelText("Query"), { target: { value: "alignment" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_project", { query: "alignment" }));
    expect(await screen.findByText("A latent alignment objective.", {
      selector: ".project-replace-hit-preview",
    })).toBeInTheDocument();
    expect(screen.getByText("The model relies entirely on self-attention.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("sections/method.tex:3"));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    });
  });

  it("renames project items but keeps bibliography titles authoritative for papers", async () => {
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
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
      clientX: 100,
      clientY: 100,
      pointerId: 41,
      pointerType: "mouse",
    });
    expect(projectTreeRoot()?.querySelector('[data-lattice-pointer-drag-preview="true"]'))
      .not.toBeNull();
    expect(document.querySelector(".source-editor")).toHaveClass("file-drop-active");

    fireEvent.pointerUp(window, {
      clientX: 100,
      clientY: 100,
      pointerId: 41,
      pointerType: "mouse",
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", {
      path: "references.bib",
      projectRoot: "/tmp/lattice-paper",
    }));
    expect(await screen.findByRole("tab", { name: /references\.bib/ }))
      .toHaveAttribute("aria-selected", "true");
    const bibliographyEditorDom = document.querySelector<HTMLElement>(".source-editor .cm-editor");
    const bibliographyEditor = bibliographyEditorDom ? EditorView.findFromDOM(bibliographyEditorDom) : null;
    expect(bibliographyEditor && syntaxTree(bibliographyEditor.state).toString())
      .toContain("Entry(EntryType");
    expect(document.querySelector(".source-editor")).not.toHaveClass("file-drop-active");
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
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Dual source view/ }));
    const secondaryEditor = await waitFor(() => {
      const editor = document.querySelector<HTMLElement>(".source-editor[data-editor-pane='secondary']");
      expect(editor).not.toBeNull();
      return editor!;
    });
    const secondaryContent = secondaryEditor.querySelector<HTMLElement>(".cm-content")!;
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
      clientX: 500,
      clientY: 100,
      pointerId: 42,
      pointerType: "mouse",
    });
    expect(secondaryEditor).toHaveClass("file-drop-active");
    fireEvent.pointerUp(window, {
      clientX: 500,
      clientY: 100,
      pointerId: 42,
      pointerType: "mouse",
    });

    await waitFor(() => expect(document.querySelector(".dual-pane-label"))
      .toHaveTextContent("references.bib"));
    const primaryEditorDom = document.querySelector<HTMLElement>(
      ".source-editor[data-editor-pane='primary'] .cm-editor",
    );
    expect(primaryEditorDom && EditorView.findFromDOM(primaryEditorDom)?.state.doc.toString())
      .toContain("\\documentclass{article}");
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

  it("imports a mixed Finder drop into the folder it lands on without opening files", async () => {
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
          // Markdown + a data file the old classifier rejected + an image,
          // all in one drop: the tree takes any mix.
          paths: ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png"],
          position: { x: 100, y: 100 },
        },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_files", {
      paths: ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png"],
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

  it("previews SVG figures and inserts them at the editor drop position", async () => {
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
    expect(document.querySelector(".figure-drag-ghost")).toHaveClass("ready");
    fireEvent.pointerUp(window, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Search PDF").closest(".pdf-find-controls"))
      .toHaveClass("without-outline");

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
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
    expect(document.querySelector(".figure-drop-line")).toHaveTextContent(/Insert above line \d+/);
    expect(document.querySelector(".source-editor")).not.toHaveTextContent("Insert figure here");
    fireEvent.pointerUp(window, {
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("prepare_latex_figure", {
      path: "figures/native-umm.svg",
      projectRoot: "/tmp/lattice-paper",
    }));
    const figureDialog = await screen.findByLabelText("Insert figure");
    fireEvent.click(within(figureDialog).getByRole("button", { name: "Insert" }));
    await waitFor(() => {
      const view = EditorView.findFromDOM(editorElement);
      expect(view?.state.doc.toString()).toContain("\\includegraphics[width=\\linewidth]{\\detokenize{figures/native-umm-converted.pdf}}");
    });

    fireEvent.click(await findProjectTreeItem("method.md"));
    const methodTab = await screen.findByRole("tab", { name: /method\.md/ });
    await waitFor(() => expect(methodTab).toHaveAttribute("aria-selected", "true"));
    const documentView = screen.getByRole("tablist", { name: "Document view" });
    const editTab = await waitFor(
      () => within(documentView).getByRole("tab", { name: "Edit" }),
      { timeout: 5_000 },
    );
    fireEvent.click(editTab);
    const markdownEditor = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const markdownContent = document.querySelector<HTMLElement>(".cm-content")!;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => markdownContent),
    });
    fireEvent.pointerDown(await findProjectTreeItem("figures/native-umm.svg"), {
      button: 0,
      pointerId: 3,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(window, {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 100,
      clientY: 100,
    });
    await waitFor(() => {
      const view = EditorView.findFromDOM(markdownEditor);
      expect(view?.state.doc.toString()).toContain("![native umm](<figures/native-umm.svg>)");
    });
    expect(screen.queryByLabelText("Insert figure")).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "prepare_latex_figure"))
      .toHaveLength(1);
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("renders every PDF page in one continuous themed reader", async () => {
    const intersections: Array<{
      element: Element;
      notify: (isIntersecting: boolean) => void;
    }> = [];
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        intersections.push({
          element,
          notify: (isIntersecting) => this.callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        });
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = "900px 0px";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
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
      if (command === "synctex_edit") return { path: "main.tex", line: 1 };
      if (command === "synctex_view") {
        const syncArgs = args as Record<string, unknown> | undefined;
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
    const savePdf = await screen.findByRole("button", { name: "Save PDF as…" });
    const pdfScrollArea = document.querySelector(".pdf-scroll-area")!;
    const pdfViewport = pdfScrollArea.querySelector("[data-slot='scroll-area-viewport']");
    expect(pdfViewport).not.toHaveClass("scroll-fade-both");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("PDF page 2")).toBeInTheDocument();
    act(() => {
      for (const intersection of intersections) intersection.notify(true);
    });
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalledTimes(2));
    const firstPageIntersection = intersections.find(
      ({ element }) => (element as HTMLElement).dataset.pdfPage === "1",
    );
    expect(firstPageIntersection).toBeDefined();
    act(() => firstPageIntersection?.notify(false));
    await Promise.resolve();
    act(() => firstPageIntersection?.notify(true));
    await Promise.resolve();
    expect(renderPdfPage).toHaveBeenCalledTimes(2);
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
    fireEvent.click(revealCursor);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", {
      path: "main.tex",
      line: 1,
      column: 0,
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
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({
      force: false,
      projectRoot: "/tmp/lattice-paper",
    })));
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
  });

  it("lists compile diagnostics and jumps to the reported source line", async () => {
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
          success: false,
          pdfBase64: null,
          log: "chapters/intro.tex:4: Undefined control sequence.\n",
          durationMs: 80,
          diagnostics: [{
            file: "/tmp/lattice-paper/./chapters/intro.tex",
            line: 4,
            level: "error",
            message: "Undefined control sequence.",
          }],
        };
      }
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    const diagnosticsPanel = await screen.findByLabelText("Compile diagnostics");
    expect(diagnosticsPanel.closest(".pdf-column")).toBeInTheDocument();
    expect(diagnosticsPanel.parentElement).not.toHaveClass("workspace");
    expect(screen.getByText("1 error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy error message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("chapters/intro.tex:4 Undefined control sequence."));
    fireEvent.click(screen.getByRole("tab", { name: /Log/i }));
    expect(screen.getByLabelText("Raw build log")).toHaveTextContent("Undefined control sequence.");
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
    initialEditor.dispatch({ changes: { from: initialEditor.state.doc.length, insert: "\nLocal only." } });

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
      return mockAppCommand(command, args as Record<string, unknown> | undefined);
    });

    renderApp();
    expect(await screen.findByLabelText("Show document outline")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Show outline"));
    expect(await screen.findByLabelText("Document outline")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Background/i })).toBeInTheDocument();
    expect(screen.queryByText("sections/introduction.tex")).not.toBeInTheDocument();
    expect(screen.queryByText("\\input{sections/introduction.tex}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Results/i }));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    });
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
    expect(palette).toHaveTextContent("Pick a symbol or snippet");
    expect(within(palette).getByRole("button", { name: /Alpha/i })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("tab", { name: "Greek" }));
    expect(palette.querySelector(".sliding-tab-underline")).not.toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: /Capital omega/i })).toBeInTheDocument();
  });

  it("creates and deletes project entries and imported papers", async () => {
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

    fireEvent.contextMenu(await findProjectTreeItem("notes.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_project_entry", {
      path: "notes.tex",
      projectRoot: "/tmp/lattice-paper",
    }));
    await switchSidebarMode("Papers");
    fireEvent.click(screen.getByTitle("Remove Attention Is All You Need"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_reference", { key: "vaswani2017attention" }));
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

});
