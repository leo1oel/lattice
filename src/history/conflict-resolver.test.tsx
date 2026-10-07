import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// The file Overleaf sync wrote when Overleaf's references.bib was emptied
// while Papers had appended an entry locally: one diff3 block around the
// whole file, with an empty Overleaf side.
const ours = "@misc{a,\n  title = {A},\n}\n\n@misc{b,\n  title = {B},\n}";
const wholeFile = [
  "<<<<<<< ours",
  ours,
  "||||||| original",
  "@misc{a,\n  title = {A},\n}",
  "=======",
  ">>>>>>> theirs",
  "",
].join("\n");

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@pierre/diffs/edit", () => ({ Editor: class {} }));
vi.mock("./pierre-diff", async () => ({
  PIERRE_UNSAFE_CSS: "pierre styles",
  usePierreResources: (await import("./pierre-test-mocks")).readyPierreResources,
}));
vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: ReactNode }) => children,
  File: (props: {
    file: { contents: string };
    onEditChange: (event: { file: { contents: string } }) => void;
  }) => (
    <textarea
      aria-label="Resolved file"
      defaultValue={props.file.contents}
      onChange={(event) => props.onEditChange({ file: { contents: event.currentTarget.value } })}
    />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(content: string, path = "references.bib") {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "read_project_file") return content;
    return undefined;
  });
  const onClose = vi.fn();
  const onResolved = vi.fn();
  render(
    <ConflictResolverDialog open path={path} projectRoot="/tmp/paper" onClose={onClose} onResolved={onResolved} />,
  );
  return { onClose, onResolved };
}

const written = () => vi.mocked(invoke).mock.calls
  .filter(([command]) => command === "write_project_file")
  .map(([, args]) => (args as { content: string }).content);

describe("ConflictResolverDialog", () => {
  it("closes a stale conflict request without offering to save a marker-free file", async () => {
    const { onClose, onResolved } = renderDialog("The writer has already continued editing.\n", "section.tex");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "section.tex", projectRoot: "/tmp/paper" });
    expect(onResolved).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("does not dismiss a newer conflict when an older marker-free read finishes late", async () => {
    let finishOldRead!: (text: string) => void;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      if ((args as { path: string }).path === "old.tex") return new Promise<string>((resolve) => { finishOldRead = resolve; });
      return conflict;
    });
    const onClose = vi.fn();
    const props = { open: true, projectRoot: "/tmp/paper", onClose, onResolved: vi.fn() };
    const view = render(<ConflictResolverDialog {...props} path="old.tex" />);
    view.rerender(<ConflictResolverDialog {...props} path="new.tex" />);
    await screen.findByRole("radio", { name: "Keep Overleaf's version" });
    await act(async () => { finishOldRead("Already resolved"); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Resolve conflicts in new.tex" })).toBeInTheDocument();
  });

  it("names each side and shows an empty Overleaf side as a removal", async () => {
    renderDialog(wholeFile);
    const local = await screen.findByRole("region", { name: "This computer" });
    const overleaf = screen.getByRole("region", { name: "Overleaf" });
    expect(within(local).getByText(/@misc\{b,/)).toBeInTheDocument();
    expect(within(local).queryByText(/\|\|\|\|\|\|\|/)).not.toBeInTheDocument();
    expect(within(overleaf).getByText("Overleaf removed this part.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 of 1 decided");
    expect(screen.getByRole("button", { name: "Save decided spots" })).toBeDisabled();
  });

  it.each([
    ["Keep this computer's version", `${ours}\n`],
    ["Keep Overleaf's version", ""],
    ["Keep both", `${ours}\n`],
  ])("writes exactly the chosen side for %s, never the base section", async (label, expected) => {
    const { onClose, onResolved } = renderDialog(wholeFile);
    const choice = await screen.findByRole("radio", { name: label });
    fireEvent.click(choice);
    expect(choice).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Every spot decided");
    fireEvent.click(screen.getByRole("button", { name: "Save resolved file" }));
    await waitFor(() => expect(written()).toEqual([expected]));
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "references.bib",
      content: expected,
      projectRoot: "/tmp/paper",
    });
    expect(onResolved).toHaveBeenCalledWith("references.bib");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets the user change a choice before saving", async () => {
    renderDialog(conflict, "main.tex");
    fireEvent.click(await screen.findByRole("radio", { name: "Keep this computer's version" }));
    fireEvent.click(screen.getByRole("radio", { name: "Keep Overleaf's version" }));
    expect(screen.getByRole("radio", { name: "Keep this computer's version" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Save resolved file" }));
    await waitFor(() => expect(written()).toEqual(["before\nremote\nafter"]));
  });

  it("lets the user edit the combined result and saves that draft", async () => {
    const { onResolved } = renderDialog(conflict, "main.tex");
    fireEvent.click(await screen.findByRole("radio", { name: "Keep Overleaf's version" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit before saving/ }));

    const editor = await screen.findByRole("textbox", { name: "Resolved file" });
    expect(editor).toHaveValue("before\nremote\nafter");
    fireEvent.change(editor, { target: { value: "before\nrevised remote\nafter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save resolved file" }));

    await waitFor(() => expect(written()).toEqual(["before\nrevised remote\nafter"]));
    expect(onResolved).toHaveBeenCalledWith("main.tex");
  });

  it("saves decided spots while preserving later conflict markers", async () => {
    const twoConflicts = `${conflict.replace("after", "middle")}\n<<<<<<< ours\nsecond local\n=======\nsecond remote\n>>>>>>> theirs\nafter`;
    renderDialog(twoConflicts, "main.tex");
    const [firstOverleaf] = await screen.findAllByRole("radio", { name: "Keep Overleaf's version" });
    fireEvent.click(firstOverleaf);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2 decided");
    fireEvent.click(screen.getByRole("button", { name: "Save decided spots" }));

    await waitFor(() => expect(written()).toEqual([
      "before\nremote\nmiddle\n<<<<<<< ours\nsecond local\n=======\nsecond remote\n>>>>>>> theirs\nafter",
    ]));
  });

  it("keeps the dialog open and reports a failed write", async () => {
    const { onClose, onResolved } = renderDialog(conflict, "main.tex");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "write_project_file") throw new Error("disk full");
      return conflict;
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Keep both" }));
    fireEvent.click(screen.getByRole("button", { name: "Save resolved file" }));
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
