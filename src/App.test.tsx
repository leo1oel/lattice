import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const windowApi = vi.hoisted(() => ({ startDragging: vi.fn() }));
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
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: windowApi.startDragging }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));

const testSession = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "New conversation",
  createdAt: "2026-07-16T00:00:00Z",
  updatedAt: "2026-07-16T00:00:00Z",
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  messages: [{ id: "welcome", role: "agent", text: "Tell me what you want to write or revise.", files: [] }],
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
  if (command === "list_agent_sessions") return [testSessionSummary];
  if (command === "read_agent_session") return testSession;
  if (command === "save_agent_session") return args?.session;
  throw new Error(`Unexpected command: ${command}`);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  vi.mocked(revealItemInDir).mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "initial_project") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("welcome screen", () => {
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
  });

  it("opens appearance settings and persists font choices", async () => {
    render(<App />);
    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/interface font/i), { target: { value: "Inter, -apple-system, sans-serif" } });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--ui-font")).toBe("Inter, -apple-system, sans-serif");
    });
    expect(screen.getByRole("slider", { name: /interface size/i })).toHaveValue("110");
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveValue("14");
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    const autoBuild = screen.getByLabelText("Automatic build");
    expect(autoBuild).toHaveValue("manual");
    fireEvent.change(autoBuild, { target: { value: "automatic" } });
    expect(screen.getByText("Build automatically")).toBeInTheDocument();
    expect(screen.getByText(/leave the editor or after 1.2 seconds/i)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("lattice.build-preferences.v1")).toContain("automatic"));
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
    expect(screen.queryByText("/tmp/lattice-paper")).not.toBeInTheDocument();
    expect(document.querySelector(".titlebar-navigator")).not.toHaveAttribute("style");
    fireEvent.mouseDown(document.querySelector(".titlebar-drag-area")!, { button: 0, buttons: 1 });
    expect(windowApi.startDragging).toHaveBeenCalledOnce();
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
    expect(divider).toHaveAttribute("aria-valuenow", "220");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider).toHaveAttribute("aria-valuenow", "236");

    fireEvent.pointerDown(divider, { clientX: 236 });
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
    localStorage.setItem("lattice.build-preferences.v1", JSON.stringify({ autoBuildMode: "automatic" }));
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project"));
  });

  it("automatically builds after 1.2 seconds without editing", async () => {
    localStorage.setItem("lattice.build-preferences.v1", JSON.stringify({ autoBuildMode: "automatic" }));
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
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nIdle build." } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("build_project"), { timeout: 2_500 });
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "\\documentclass{article}\nIdle build.",
    });
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
      files: [],
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

  it("uses the themed PDF toolbar after a successful build", async () => {
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
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => renderTask,
      })),
    };
    vi.mocked(getDocument).mockReturnValue({
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    } as never);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:lattice-pdf"),
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
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build" }));
    const savePdf = await screen.findByTitle("Save PDF as…");
    expect(screen.getByTitle("Previous page")).toBeDisabled();
    await waitFor(() => expect(screen.getByTitle("Next page")).toBeEnabled());
    expect(screen.getByTitle("Zoom out")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in")).toBeInTheDocument();
    fireEvent.click(savePdf);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "paper.pdf" })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_compiled_pdf", {
      path: "/tmp/exported-paper.pdf",
      pdfBase64: "JVBERi0xLjQ=",
    }));
    expect(await screen.findByText("Saved to /tmp/exported-paper.pdf")).toBeInTheDocument();
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
      if (command === "list_papers" || command === "list_history" || command === "list_citation_keys") return [];
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
      if (command === "delete_history_entry") {
        entries = [];
        return undefined;
      }
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.click(await screen.findByTitle("Project history"));
    fireEvent.click(await screen.findByTitle("Delete this history entry"));

    await waitFor(() => expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("delete_history_entry", { transactionId: "change-1" });
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
      if (command === "list_history" || command === "list_citation_keys") return [];
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("run_agent", expect.objectContaining({
      settings: { provider: "claude", model: "claude-opus-4-8", reasoningEffort: "xhigh" },
      message,
      conversation: testSession.messages,
    })));
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
