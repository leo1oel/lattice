import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictResolverDialog } from "./conflict-resolver";

const conflict = [
  "before",
  "<<<<<<< ours",
  "local",
  "=======",
  "remote",
  ">>>>>>> theirs",
  "after",
].join("\n");

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@pierre/diffs", () => ({
  UnresolvedFile: class {
    private options: { onMergeConflictResolve: (file: { contents: string }) => void };
    private container?: HTMLElement;

    constructor(options: { onMergeConflictResolve: (file: { contents: string }) => void }) {
      this.options = options;
    }

    render({ fileContainer }: { fileContainer: HTMLElement }) {
      this.container = fileContainer;
      const resolveAll = document.createElement("button");
      resolveAll.textContent = "Use Overleaf";
      resolveAll.addEventListener("click", () => {
        this.options.onMergeConflictResolve({ contents: "before\nremote\nafter" });
      });
      const resolveFirst = document.createElement("button");
      resolveFirst.textContent = "Resolve first";
      resolveFirst.addEventListener("click", () => {
        this.options.onMergeConflictResolve({ contents: [
          "before",
          "remote",
          "<<<<<<< ours",
          "second local",
          "=======",
          "second remote",
          ">>>>>>> theirs",
          "after",
        ].join("\n") });
      });
      fileContainer.append(resolveAll, resolveFirst);
    }

    cleanUp() {
      this.container?.replaceChildren();
    }
  },
}));
vi.mock("@pierre/diffs/edit", () => ({ Editor: class {} }));
vi.mock("./file-diff-view", () => ({
  PIERRE_UNSAFE_CSS: "pierre styles",
  usePierreResources: () => ({
    error: undefined,
    language: "tex",
    preloadKey: "github-light:tex",
    ready: true,
    theme: "light",
    themeName: "github-light",
  }),
}));
vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: ReactNode }) => children,
  File: (props: {
    file: { contents: string };
    editorOptions: { onChange: (file: { contents: string }) => void };
  }) => (
    <textarea
      aria-label="Resolved file"
      defaultValue={props.file.contents}
      onChange={(event) => props.editorOptions.onChange({ contents: event.currentTarget.value })}
    />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConflictResolverDialog", () => {
  it("resolves through Pierre, lets the user edit the result, and saves that draft", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_file") return conflict;
      return undefined;
    });
    const onClose = vi.fn();
    const onResolved = vi.fn();

    render(
      <ConflictResolverDialog
        open
        path="main.tex"
        projectRoot="/tmp/paper"
        onClose={onClose}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use Overleaf" }));
    expect(await screen.findByText("1 of 1 decided")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review and edit/ }));

    const editor = await screen.findByRole("textbox", { name: "Resolved file" });
    expect(editor).toHaveValue("before\nremote\nafter");
    fireEvent.change(editor, { target: { value: "before\nrevised remote\nafter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: "before\nrevised remote\nafter",
      projectRoot: "/tmp/paper",
    }));
    expect(onResolved).toHaveBeenCalledWith("main.tex");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves a resolved first conflict while preserving later conflict markers", async () => {
    const twoConflicts = `${conflict.replace("after", "middle")}\n<<<<<<< ours\nsecond local\n=======\nsecond remote\n>>>>>>> theirs\nafter`;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_file") return twoConflicts;
      return undefined;
    });

    render(
      <ConflictResolverDialog
        open
        path="main.tex"
        projectRoot="/tmp/paper"
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Resolve first" }));
    expect(await screen.findByText("1 of 2 decided")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex",
      content: expect.stringContaining("<<<<<<< ours\nsecond local"),
      projectRoot: "/tmp/paper",
    }));
  });
});
