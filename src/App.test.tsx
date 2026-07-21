import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { referenceAssetPreviewDataUrl } from "./reference-preview";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn(),
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  onResized: vi.fn(),
}));
const tauriCore = vi.hoisted(() => {
  class MockChannel {
    onmessage: (response: unknown) => void;

    constructor(onmessage?: (response: unknown) => void) {
      this.onmessage = onmessage ?? (() => undefined);
    }
  }
  return { MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: tauriCore.MockChannel }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
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

const testSession = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "New conversation",
  createdAt: "2026-07-16T00:00:00Z",
  updatedAt: "2026-07-16T00:00:00Z",
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  messages: [{ id: "random-persisted-id", role: "agent", text: "What would you like to work on?", files: [] }],
};

const testSessionSummary = {
  id: testSession.id,
  title: testSession.title,
  updatedAt: testSession.updatedAt,
  provider: testSession.provider,
  model: testSession.model,
  reasoningEffort: testSession.reasoningEffort,
  messageCount: testSession.messages.length,
};

function mockSessionCommand(command: string, args?: Record<string, unknown>) {
  if (command === "list_citation_keys") return [];
  if (command === "list_citations") return [];
  if (command === "list_references") return [];
  if (command === "list_agent_sessions") return [testSessionSummary];
  if (command === "read_agent_session") return testSession;
  if (command === "save_agent_session") return args?.session;
  if (command === "save_agent_checkpoint") return undefined;
  throw new Error(`Unexpected command: ${command}`);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  vi.mocked(revealItemInDir).mockResolvedValue(undefined);
  vi.mocked(writeText).mockResolvedValue(undefined);
  windowApi.isFullscreen.mockResolvedValue(false);
  windowApi.setFullscreen.mockResolvedValue(undefined);
  windowApi.onResized.mockResolvedValue(() => undefined);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "initial_project") return null;
    if (command === "list_agent_skills") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

    expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "#ffffff" }));
    expect(destroy).toHaveBeenCalled();
  });

  it("offers project creation and existing folder import", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Research, written with evidence." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open folder/i })).toBeInTheDocument();
  });

  it("opens the project creation dialog", () => {
    render(<App />);
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
      if (command === "list_agent_skills") return [];
      if (command === "create_project") throw new Error("That folder already exists and is not empty.");
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder already exists and is not empty.");
    expect(screen.getByRole("heading", { name: "Create a research project" })).toBeInTheDocument();
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
      if (command === "list_agent_skills") return [];
      if (command === "create_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.click(screen.getByRole("radio", { name: /ICML/i }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project", {
      parent: "/tmp/research",
      name: "New paper",
      venue: "icml",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("New paper");
  });

  it("opens appearance settings and persists font choices", async () => {
    render(<App />);
    expect(screen.queryByTitle("Toggle theme")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByLabelText(/latex editor font/i)).toHaveValue("Menlo, ui-monospace, monospace");
    fireEvent.change(screen.getByLabelText("Color theme"), { target: { value: "dark" } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("lattice.theme.v1")).toBe("dark");
    fireEvent.change(screen.getByLabelText(/interface font/i), { target: { value: "-apple-system, BlinkMacSystemFont, sans-serif" } });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--ui-font")).toBe("-apple-system, BlinkMacSystemFont, sans-serif");
    });
    expect(screen.getByRole("slider", { name: /interface size/i })).toHaveValue("110");
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveValue("14");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    const autoBuild = screen.getByLabelText("Automatic build");
    expect(autoBuild).toHaveValue("automatic");
    expect(screen.getByText("Build automatically")).toBeInTheDocument();
    expect(screen.getByText(/leave the editor or after 1.2 seconds/i)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("lattice.build-preferences.v2")).toContain("automatic"));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const systemPrompt = screen.getByLabelText("Agent system prompt");
    fireEvent.change(systemPrompt, { target: { value: "Write with precision." } });
    await waitFor(() => expect(localStorage.getItem("lattice.agent-system-prompt.v1")).toBe("Write with precision."));
  });

  it("persists the opt-in editor spellcheck setting", async () => {
    render(<App />);
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    const spellcheck = screen.getByLabelText("Spellcheck prose in the editor");
    expect(spellcheck).not.toBeChecked();
    fireEvent.click(spellcheck);
    await waitFor(() => expect(localStorage.getItem("lattice.appearance.v4")).toContain('"editorSpellcheck":true'));
  });

  it("keeps an explicitly selected manual build preference", () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    render(<App />);
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Automatic build")).toHaveValue("manual");
  });

  it("migrates the legacy manual default to automatic build", () => {
    localStorage.setItem("lattice.build-preferences.v1", JSON.stringify({ autoBuildMode: "manual" }));
    render(<App />);
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Automatic build")).toHaveValue("automatic");
  });

  it("manages application-local skills without installing them globally", async () => {
    const skill = {
      name: "research-taste",
      description: "Apply the user's research taste.",
      scope: "built-in",
      enabled: true,
      editable: false,
      overridden: false,
      content: "---\nname: research-taste\ndescription: Apply the user's research taste.\n---\n",
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return null;
      if (command === "list_agent_skills") return [skill];
      if (command === "save_agent_skill") return { ...skill, scope: "application" };
      throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
    });

    render(<App />);
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(await screen.findByText("research-taste")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit research-taste"));
    const instructions = screen.getByLabelText("Skill instructions");
    fireEvent.change(instructions, { target: { value: `${skill.content}\nUse it carefully.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_agent_skill", {
      request: {
        originalName: "research-taste",
        scope: "application",
        content: `${skill.content}\nUse it carefully.`,
      },
    }));
  });
});

describe("project workspace", () => {
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    await screen.findByRole("button", { name: "Switch project" });
    expect(screen.queryByText("/tmp/lattice-paper")).not.toBeInTheDocument();
    expect(document.querySelector(".titlebar-navigator")).not.toHaveAttribute("style");
    fireEvent.mouseDown(document.querySelector(".titlebar-drag-area")!, { button: 0, buttons: 1 });
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Switch project" }));

    expect(screen.getByText("Recent projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open another folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize project navigator" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize writing agent" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize Project and Papers" })).toBeInTheDocument();
    expect(screen.getByTitle("Add file or folder").querySelector(".lucide-folder-plus")).not.toBeNull();
    expect(document.querySelector(".count-badge")).toHaveTextContent("0");
    expect(document.querySelector(".source-editor > .code-editor-root")).toBeInTheDocument();
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    expect(composer).toHaveAttribute("rows", "1");
    expect(composer).toHaveStyle({ height: "44px", overflowY: "hidden" });
    expect(screen.getByTitle("Conversation history")).toHaveTextContent("New");
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    await screen.findByTitle("Hide navigator");
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const divider = await screen.findByRole("separator", { name: "Resize project navigator" });
    expect(divider).toHaveAttribute("aria-valuenow", "200");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "216");

    fireEvent.pointerDown(divider, { clientX: 216 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(divider).toHaveAttribute("aria-valuenow", "300");

    const navigatorDivider = screen.getByRole("separator", { name: "Resize Project and Papers" });
    expect(navigatorDivider).toHaveAttribute("aria-valuenow", "58");
    fireEvent.keyDown(navigatorDivider, { key: "ArrowDown" });
    expect(navigatorDivider).toHaveAttribute("aria-valuenow", "61");

    const splitDivider = screen.getByRole("separator", { name: "Resize source and PDF preview" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "46");
    fireEvent.keyDown(splitDivider, { key: "ArrowRight" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
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
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
    vi.mocked(invoke).mockClear();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nIdle build." } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nIdle build.",
    }), { timeout: 2_500 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
  });

  it("opens Settings → Subscriptions when Claude subscription auth is missing", async () => {
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
      if (command === "run_agent") {
        throw new Error("LATTICE_AUTH_SUBSCRIPTION:Sign in to Claude in Settings → Subscriptions before using the Claude subscription.");
      }
      if (command === "subscription_status") return [
        { provider: "codex", installed: true, loggedIn: false, detail: "Sign in through OMP · ChatGPT Codex subscription" },
        { provider: "claude", installed: true, loggedIn: false, detail: "Sign in through OMP · Claude Pro or Max subscription" },
      ];
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Agent provider"), { target: { value: "claude" } });
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Revise the abstract." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    expect(await screen.findByText("Sign in to Claude in Settings → Subscriptions before using the Claude subscription.")).toBeInTheDocument();
    expect(screen.queryByText(/LATTICE_AUTH_SUBSCRIPTION/)).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Subscriptions" })).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: "Sign in with OMP" })).toHaveLength(2);
  });

  it("shows subscription status in settings without asking for an API key", async () => {
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
      if (command === "subscription_status") return [
        { provider: "codex", installed: true, loggedIn: true, detail: "Logged in using ChatGPT" },
        { provider: "claude", installed: true, loggedIn: true, detail: "Max subscription" },
      ];
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    expect(await screen.findByLabelText("Agent provider")).toHaveValue("codex");
    expect(screen.getByRole("option", { name: "GPT-5.5" })).toBeInTheDocument();
    expect(screen.queryByTitle("API key settings")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Subscriptions" }));
    expect(await screen.findAllByText("Connected")).toHaveLength(2);

    fireEvent.click(screen.getByTitle("Close settings"));
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "claude" } });
    expect(screen.getByRole("option", { name: "Claude Opus 4.8" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Sonnet 5" })).toBeInTheDocument();
    expect(screen.queryByTitle("API key settings")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "openai-api" } });
    expect(screen.getByTitle("API key settings")).toBeInTheDocument();
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
      if (command === "list_papers") return [{ arxivId: "1706.03762", title: "Attention Is All You Need" }];
      if (command === "list_history") return [];
      if (command === "read_paper") return "Title: Attention Is All You Need\n\n## Abstract";
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const paper = await screen.findByRole("button", { name: /Attention Is All You Need.*1706\.03762/i });
    fireEvent.click(paper);
    expect(await screen.findByText("Attention Is All You Need", { selector: ".paper-reader-title span" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });
    expect(paper.closest(".paper-row")).toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: "main.tex" }));
    await waitFor(() => expect(paper.closest(".paper-row")).not.toHaveClass("active"));
  });

  it("searches project files and paper contents from one navigator field", async () => {
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention" };
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Filter project files and papers"), { target: { value: "alignment" } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_project", { query: "alignment" }));
    expect(await screen.findByText(/L3 · A latent alignment objective\./)).toBeInTheDocument();
    expect(screen.getByText("The model relies entirely on self-attention.")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/L3 · A latent alignment objective\./));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    });
  });

  it("renames project items and paper display titles from their context menus", async () => {
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
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention" };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers") return [paper];
      if (command === "list_history") return [];
      if (command === "rename_project_entry") return "paper.tex";
      if (command === "rename_paper") return { ...paper, title: "Transformer" };
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });
    render(<App />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "main.tex" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rename_project_entry", { path: "main.tex", newName: "paper" }));

    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Transformer" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rename_paper", { arxivId: "1706.03762", title: "Transformer" }));
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
      if (command === "list_papers") return [{ arxivId: "1706.03762", title: "Attention Is All You Need" }];
      if (command === "list_history") return [];
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.contextMenu(await screen.findByRole("button", { name: "main.tex" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));

    fireEvent.contextMenu(screen.getByTitle("Attention Is All You Need"));
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Import images into figures"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_project_assets", {
      paths: ["/tmp/result.png"],
      targetDirectory: "figures",
    }));
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
        children: [{ name: "native-umm.svg", path: "figures/native-umm.svg", kind: "figure", children: [] }],
      }, { name: "main.tex", path: "main.tex", kind: "tex", children: [] }],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}\n\\begin{document}\n\\end{document}";
      if (command === "read_project_asset") return {
        path: "figures/native-umm.svg",
        mimeType: "image/svg+xml",
        base64: "PHN2Zy8+",
      };
      if (command === "prepare_latex_figure") return "figures/native-umm-converted.pdf";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 50, diagnostics: [] };
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "native-umm.svg" }));
    expect(await screen.findByAltText("Preview of figures/native-umm.svg")).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zy8+");
    expect(screen.getAllByText("figures/native-umm.svg").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "native-umm.svg" }).closest(".tree-row")).toHaveClass("active");
    expect(screen.getByRole("button", { name: "main.tex" }).closest(".tree-row")).not.toHaveClass("active");

    fireEvent.click(screen.getByRole("button", { name: "source" }));
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => content) });
    fireEvent.pointerDown(screen.getByRole("button", { name: "native-umm.svg" }), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    expect(document.querySelector(".figure-drag-ghost")).toHaveTextContent("native-umm.svg");
    expect(document.querySelector(".figure-drop-line")).toHaveTextContent(/Insert above line \d+/);
    expect(document.querySelector(".source-editor")).not.toHaveTextContent("Insert figure here");
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("prepare_latex_figure", { path: "figures/native-umm.svg" }));
    const figureDialog = await screen.findByLabelText("Insert figure");
    fireEvent.click(within(figureDialog).getByRole("button", { name: "Insert" }));
    await waitFor(() => {
      const view = EditorView.findFromDOM(editorElement);
      expect(view?.state.doc.toString()).toContain("\\includegraphics[width=\\linewidth]{\\detokenize{figures/native-umm-converted.pdf}}");
    });
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
    const pdf = {
      numPages: 2,
      getPage: vi.fn(async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          convertToViewportPoint: (x: number, y: number) => [x, y],
        }),
        render: () => renderTask,
        streamTextContent: () => new ReadableStream(),
        getTextContent: async () => ({ items: [{ str: "Attention is all you need" }] }),
        getAnnotations: async () => [{
          id: "link-1",
          subtype: "Link",
          rect: [10, 20, 80, 40],
          url: "https://example.com/paper",
        }],
      })),
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    };
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    let pdfUrlSequence = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:lattice-pdf-${++pdfUrlSequence}`),
      revokeObjectURL: vi.fn(),
    });
    vi.mocked(save).mockResolvedValue("/tmp/exported-paper.pdf");
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return {
        success: true,
        pdfBase64: "JVBERi0xLjQ=",
        log: "",
        durationMs: 100,
        diagnostics: [],
      };
      if (command === "save_compiled_pdf") return "/tmp/exported-paper.pdf";
      if (command === "synctex_edit") return { path: "main.tex", line: 1 };
      if (command === "synctex_view") return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
    const savePdf = await screen.findByTitle("Save PDF as…");
    expect(screen.getByTitle("Previous page")).toBeDisabled();
    await waitFor(() => expect(screen.getByTitle("Next page")).toBeEnabled());
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("PDF page 2")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(".pdf-text-layer span")).toHaveTextContent("Attention is all you need");
    });
    await waitFor(() => {
      expect(screen.getAllByTitle("https://example.com/paper").length).toBeGreaterThan(0);
    });
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    expect(pdf.getPage).toHaveBeenCalledWith(2);
    expect(screen.getByTitle("Zoom out")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in")).toBeInTheDocument();
    expect(screen.getByTitle("Fit page to width")).toBeInTheDocument();
    expect(screen.getByTitle("Fit whole page")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search PDF"), { target: { value: "attention" } });
    expect(await screen.findByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Next search result"));
    expect(await screen.findByText("2/2")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Reveal cursor in PDF/i));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", {
      path: "main.tex",
      line: 1,
      column: 0,
    }));
    expect(await screen.findByLabelText("Source location in PDF")).toBeInTheDocument();
    const zoomBefore = Number(screen.getByText(/\d+%/).textContent?.replace("%", ""));
    fireEvent.click(screen.getByTitle("Zoom in"));
    const zoomAfter = `${zoomBefore + 10}%`;
    expect(screen.getByText(zoomAfter)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Build automatically · Command-S builds now/i));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project", { force: false }));
    // Identical PDF bytes must not thrash pdf.js — keep the same document + zoom.
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
    expect(screen.getByText(zoomAfter)).toBeInTheDocument();
    fireEvent.click(savePdf);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "paper.pdf" })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_compiled_pdf", {
      path: "/tmp/exported-paper.pdf",
      pdfBase64: "JVBERi0xLjQ=",
    }));
    expect(await screen.findByText("Saved to /tmp/exported-paper.pdf")).toBeInTheDocument();
    const pdfPage = screen.getByLabelText("PDF page 1");
    fireEvent.click(pdfPage, { clientX: 110, clientY: 220 });
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    expect(await screen.findByLabelText("Compile diagnostics")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Log/i }));
    expect(screen.getByLabelText("Raw build log")).toHaveTextContent("Undefined control sequence.");
    fireEvent.click(screen.getByRole("tab", { name: /Messages/i }));
    fireEvent.click(screen.getByRole("button", { name: /chapters\/intro\.tex:4/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "chapters/intro.tex" }));
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const editorElement = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorElement);
    if (!view) throw new Error("CodeMirror view was not available");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nDraft change." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "intro.tex" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nDraft change.",
    }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "intro.tex" }));
    await waitFor(() => {
      const next = document.querySelector<HTMLElement>(".cm-editor");
      const nextView = next ? EditorView.findFromDOM(next) : null;
      expect(nextView?.state.doc.toString()).toBe("\\section{Intro}");
    });
  });

  it("inserts a cite command from the Papers panel", async () => {
    localStorage.setItem("lattice.build-preferences.v2", JSON.stringify({ autoBuildMode: "manual" }));
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention" };
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    fireEvent.click(await screen.findByTitle("Insert citation for vaswani2017attention"));
    fireEvent.click(await screen.findByRole("button", { name: "\\cite" }));
    await waitFor(() => {
      const editorElement = document.querySelector<HTMLElement>(".cm-editor");
      const view = editorElement ? EditorView.findFromDOM(editorElement) : null;
      expect(view?.state.doc.toString()).toContain("\\cite{vaswani2017attention}");
    });
  });

  it("creates and restores project conversations", async () => {
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
    const earlier = {
      ...testSession,
      id: "22222222-2222-4222-8222-222222222222",
      title: "Revise the related work",
      messages: [{ id: "old", role: "user", text: "Compare against the strongest baseline.", files: [] }],
    };
    const summaries = [testSessionSummary, {
      id: earlier.id,
      title: earlier.title,
      updatedAt: earlier.updatedAt,
      provider: earlier.provider,
      model: earlier.model,
      reasoningEffort: earlier.reasoningEffort,
      messageCount: earlier.messages.length,
    }];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{main}";
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "list_agent_sessions") return summaries;
      if (command === "read_agent_session") return (args as { sessionId: string }).sessionId === earlier.id ? earlier : testSession;
      if (command === "create_agent_session") return testSession;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Conversation history"));
    expect(screen.getByText("Revise the related work")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText("Conversations")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Conversation history"));
    fireEvent.click(screen.getByText("Revise the related work"));
    expect(await screen.findByText("Compare against the strongest baseline.")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("New conversation"));
    expect(invoke).toHaveBeenCalledWith("create_agent_session", {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  it("searches conversation contents", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: { schemaVersion: 1, projectId: "paper-id", name: "Lattice paper", rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }], primaryBibliography: "references.bib", trusted: false },
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "search_agent_sessions") return [{ ...testSessionSummary, title: "Earlier draft", snippet: "…strongest diffusion baseline…" }];
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Conversation history"));
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "diffusion" } });
    expect(await screen.findByText("…strongest diffusion baseline…")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("search_agent_sessions", { query: "diffusion" });
  });

  it("edits an earlier message by creating a new conversation branch", async () => {
    const snapshot = {
      root: "/tmp/lattice-paper",
      manifest: { schemaVersion: 1, projectId: "paper-id", name: "Lattice paper", rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }], primaryBibliography: "references.bib", trusted: false },
      files: [],
    };
    const source = {
      ...testSession,
      messages: [
        ...testSession.messages,
        { id: "question", role: "user", text: "Draft the old argument.", files: [] },
        { id: "answer", role: "agent", text: "Old answer", files: [] },
      ],
    };
    const branch = { ...source, id: "33333333-3333-4333-8333-333333333333", title: "New", messages: testSession.messages };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "list_agent_sessions") return [{ ...testSessionSummary, messageCount: source.messages.length }];
      if (command === "read_agent_session") return source;
      if (command === "fork_agent_session") return branch;
      if (command === "save_agent_session") return (args as { session: unknown }).session;
      if (command === "save_agent_checkpoint") return undefined;
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 1, diagnostics: [] };
      if (command === "run_agent") return { summary: "New branched answer", changedFiles: [], skillsUsed: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Edit and branch from this message"));
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    expect(composer).toHaveValue("Draft the old argument.");
    fireEvent.change(composer, { target: { value: "Draft a stronger argument." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    expect(await screen.findByText("New branched answer")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("fork_agent_session", {
      sourceSessionId: testSession.id,
      messageId: "question",
      systemPrompt: "",
    });
    expect(invoke).toHaveBeenCalledWith("run_agent", expect.objectContaining({ request: expect.objectContaining({ sessionId: branch.id, message: "Draft a stronger argument." }) }));
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Project history"));
    fireEvent.click(screen.getByRole("button", { name: /Edit main\.tex/i }));
    expect(await screen.findByLabelText("Diff for main.tex")).toHaveTextContent("- old line");
    expect(screen.getByLabelText("Diff for main.tex")).toHaveTextContent("+ new line");
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
      files: [],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") {
        return "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\ntext\n\\section{Results}\n\\end{document}\n";
      }
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "build_project") return { success: true, pdfBase64: null, log: "", durationMs: 1, diagnostics: [] };
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    expect(await screen.findByLabelText("Show document outline")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Show outline"));
    expect(await screen.findByLabelText("Document outline")).toBeInTheDocument();
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Insert snippet or symbol (⌘⇧I)"));
    const palette = await screen.findByLabelText("Insert LaTeX snippets");
    expect(palette).toHaveTextContent("Pick a symbol or snippet");
    expect(within(palette).getByRole("button", { name: /Alpha/i })).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("tab", { name: "Greek" }));
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
    const paper = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention" };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project" || command === "refresh_project") return snapshot;
      if (command === "read_project_file") return "\\section{Notes}";
      if (command === "list_papers") return [paper];
      if (command === "list_history" || command === "list_citation_keys" || command === "list_citations" || command === "list_references") return [];
      if (command === "create_project_entry") return "sections/method.tex";
      if (command === "delete_project_entry" || command === "delete_paper") return undefined;
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Add file or folder"));
    expect(screen.queryByTitle("Cancel file creation")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Project-relative path"), { target: { value: "sections/method" } });
    fireEvent.click(screen.getByTitle("Create"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project_entry", { path: "sections/method", kind: "file" }));

    fireEvent.click(screen.getByTitle("Add file or folder"));
    fireEvent.change(screen.getByLabelText("Project-relative path"), { target: { value: "draft" } });
    fireEvent.keyDown(screen.getByLabelText("Project-relative path"), { key: "Escape" });
    expect(screen.queryByLabelText("Project-relative path")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Add file or folder"));
    fireEvent.change(screen.getByLabelText("Project-relative path"), { target: { value: "draft" } });
    fireEvent.pointerDown(screen.getByText("Project").closest(".navigator-section")!);
    expect(screen.queryByLabelText("Project-relative path")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Delete notes.tex"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_project_entry", { path: "notes.tex" }));
    fireEvent.click(screen.getByTitle("Remove Attention Is All You Need"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_paper", { arxivId: "1706.03762" }));
  });

  it("shows a sent message while Claude is still working", async () => {
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
      if (command === "run_agent") {
        const channel = (args as { onEvent: { onmessage: (event: unknown) => void } }).onEvent;
        channel.onmessage({ type: "status", message: "Thinking…" });
        channel.onmessage({ type: "text", text: "Reviewing the abstract as evidence arrives…" });
        return new Promise(() => undefined);
      }
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Agent provider"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Agent model"), { target: { value: "claude-opus-4-8" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "xhigh" } });
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    const message = `Review the abstract.\n${"longword".repeat(40)}`;
    fireEvent.change(composer, { target: { value: message } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    const sentMessage = await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === message);
    expect(sentMessage.closest(".chat-message.user")).not.toBeNull();
    expect(sentMessage.textContent).toContain("\n");
    const streamedReply = screen.getByText("Reviewing the abstract as evidence arrives…");
    expect(streamedReply.closest(".chat-message.streaming")).not.toBeNull();
    expect(screen.getAllByTitle("Copy agent response")).toHaveLength(1);
    fireEvent.click(screen.getByTitle("Copy user message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(message));
    expect(screen.getByTitle("Copy user message").closest(".message-body")).toBeNull();
    fireEvent.click(streamedReply.closest(".message-body")!.querySelector<HTMLButtonElement>('[title="Copy agent response"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Reviewing the abstract as evidence arrives…"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("run_agent", expect.objectContaining({
      request: {
        settings: { provider: "claude", model: "claude-opus-4-8", reasoningEffort: "xhigh" },
        message,
        activeFile: "main.tex",
        selection: null,
        sessionId: testSession.id,
        sessionTitle: testSession.title,
        systemPrompt: "",
      },
    })));
  });

  it("stops an active agent run from the composer", async () => {
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
    let finishRun: ((result: { summary: string; changedFiles: string[]; skillsUsed: string[] }) => void) | undefined;
    let runChannel: { onmessage: (event: unknown) => void } | undefined;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "run_agent") {
        runChannel = (args as { onEvent: { onmessage: (event: unknown) => void } }).onEvent;
        return new Promise((resolve) => {
          finishRun = resolve;
        });
      }
      if (command === "abort_agent") {
        finishRun?.({ summary: "Stopped.", changedFiles: [], skillsUsed: [] });
        return true;
      }
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const composer = await screen.findByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Rewrite the abstract." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    const stop = await screen.findByTitle("Stop agent");
    expect(stop).toBeDisabled();
    runChannel?.onmessage({ type: "cancellable", enabled: true });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("abort_agent", { sessionId: testSession.id }));
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
  });

  it("does not send while an input method is composing text", async () => {
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const composer = await screen.findByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "中文" } });
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229, isComposing: true });
    expect(composer).toHaveValue("中文");
    expect(invoke).not.toHaveBeenCalledWith("run_agent", expect.anything());
  });

  it("suggests project files after typing an at mention", async () => {
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
        { name: "sections", path: "sections", kind: "directory", children: [
          { name: "method.tex", path: "sections/method.tex", kind: "tex", children: [] },
        ] },
      ],
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const composer = await screen.findByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Update @mai", selectionStart: 11 } });
    expect(screen.getByRole("listbox", { name: "Project references" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /main\.tex/i })).toBeInTheDocument();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue("Update @main.tex ");
    expect(screen.queryByRole("listbox", { name: "Project references" })).not.toBeInTheDocument();
  });

  it("shows the application skills selected for a completed agent turn", async () => {
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
      if (command === "run_agent") {
        return {
          summary: "Revised the experiment section.",
          changedFiles: [],
          skillsUsed: ["Writing", "Research taste"],
        };
      }
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    const composer = await screen.findByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Revise the experiment section and check the baseline." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    expect(await screen.findByText("Revised the experiment section.")).toBeInTheDocument();
    expect(screen.getByText("Writing")).toBeInTheDocument();
    expect(screen.getByText("Research taste")).toBeInTheDocument();
  });
});
