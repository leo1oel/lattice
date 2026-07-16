import { invoke } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
    expect(screen.getByRole("slider", { name: /editor font size/i })).toHaveAttribute("max", "18");
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
    fireEvent.click(await screen.findByRole("button", { name: "Switch project" }));

    expect(screen.getByText("Recent projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open another folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize project navigator" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize writing agent" })).toBeInTheDocument();
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

    const splitDivider = screen.getByRole("separator", { name: "Resize source and PDF preview" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "46");
    fireEvent.keyDown(splitDivider, { key: "ArrowRight" });
    expect(splitDivider).toHaveAttribute("aria-valuenow", "49");
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
      if (command === "run_agent") return new Promise(() => undefined);
      return mockSessionCommand(command, args as Record<string, unknown> | undefined);
    });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Agent provider"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Agent model"), { target: { value: "claude-opus-4-8" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "xhigh" } });
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Review the abstract." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    expect(await screen.findByText("Review the abstract.")).toBeInTheDocument();
    expect(screen.getByText("Claude is writing…")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("run_agent", expect.objectContaining({
      settings: { provider: "claude", model: "claude-opus-4-8", reasoningEffort: "xhigh" },
      message: "Review the abstract.",
      conversation: testSession.messages,
    })));
  });
});
