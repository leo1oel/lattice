import { invoke } from "@tauri-apps/api/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "initial_project") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch project" }));

    expect(screen.getByText("Recent projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open another folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
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
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "initial_project") return snapshot;
      if (command === "read_project_file") return "\\documentclass{article}";
      if (command === "list_papers" || command === "list_history") return [];
      if (command === "run_agent") return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<App />);
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "claude" } });
    const composer = screen.getByPlaceholderText(/ask the agent/i);
    fireEvent.change(composer, { target: { value: "Review the abstract." } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    expect(await screen.findByText("Review the abstract.")).toBeInTheDocument();
    expect(screen.getByText("Claude is writing…")).toBeInTheDocument();
  });
});
