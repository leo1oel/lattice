import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import type { ProjectSnapshot } from "../app-types";
import { FigureInventoryDialog } from "./figure-inventory-dialog";
import { useProjectFigureUndo } from "./figure-undo";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const source = String.raw`\begin{figure}\includegraphics{a.png}\caption{Result}\label{fig:a}\end{figure}`;
let files: Record<string, string>;
const project: ProjectSnapshot = { manifest: { schemaVersion: 1, projectId: "fixture", name: "Fixture", rootDocuments: [], primaryBibliography: "", trusted: true }, root: "/fixture", files: ["main.tex", "supp.tex", "a.png", "b.svg"].map((path) => ({ name: path, path, kind: "file", children: [] })) };
const afterWrite = vi.fn(async () => {});
const beforeWrite = vi.fn(async () => true);
const onOpen = vi.fn(async () => {});
let owns = true;
function Host() {
  const [open, setOpen] = useState(true);
  const [undo, setUndo] = useProjectFigureUndo(project.root);
  return open ? <FigureInventoryDialog project={project} activeFile="" activeSource="" onOpen={onOpen} onClose={() => setOpen(false)}
    beforeWrite={beforeWrite} afterWrite={afterWrite} captureProjectScope={() => () => owns} undo={undo} setUndo={setUndo} />
    : <button onClick={() => setOpen(true)}>Reopen</button>;
}
function setup() {
  return render(<Host />);
}
async function preview() {
  await screen.findByText("2 literal graphics commands found");
  fireEvent.click(screen.getByRole("button", { name: "Inspect and replace" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "b.svg" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
}
beforeEach(() => {
  activateAppLocale("en"); owns = true; files = { "main.tex": source, "supp.tex": source }; vi.clearAllMocks();
  beforeWrite.mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { path, content, expectedContent } = (args ?? {}) as { path: string; content: string; expectedContent: string };
    if (command === "read_project_file") return files[path];
    if (command === "read_project_asset") throw new Error("no preview");
    if (command === "write_project_file") {
      if (files[path] !== expectedContent) throw new Error("changed");
      files[path] = content; return null;
    }
    return null;
  });
});
afterEach(cleanup);
it("previews every usage, replaces exact arguments, and undoes all changed files", async () => {
  setup(); await preview();
  expect(files["main.tex"]).toBe(source);
  expect(screen.getByText("Only the listed graphics arguments will change. Image files stay in place.")).toBeInTheDocument();
  expect(screen.getAllByText(String.raw`\detokenize{b.svg}`, { selector: "ins" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Replace listed usages" }));
  await waitFor(() => expect(afterWrite).toHaveBeenCalledTimes(1));
  expect(files["main.tex"]).toContain(String.raw`\includegraphics{\detokenize{b.svg}}`);
  expect(files["supp.tex"]).toBe(files["main.tex"]);
  fireEvent.click(await screen.findByRole("button", { name: "Undo replacement" }));
  await waitFor(() => expect(afterWrite).toHaveBeenCalledTimes(2));
  expect(files).toEqual({ "main.tex": source, "supp.tex": source });
});
it("rejects a stale preview before changing any file", async () => {
  setup(); await preview(); files["supp.tex"] = "external edit";
  fireEvent.click(screen.getByRole("button", { name: "Replace listed usages" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A source file changed"));
  expect(files["main.tex"]).toBe(source);
  expect(afterWrite).not.toHaveBeenCalled();
});
it("does not write after the save belongs to an outgoing project", async () => {
  setup(); await preview(); beforeWrite.mockImplementationOnce(async () => { owns = false; return true; });
  fireEvent.click(screen.getByRole("button", { name: "Replace listed usages" }));
  await waitFor(() => expect(beforeWrite).toHaveBeenCalled());
  expect(files).toEqual({ "main.tex": source, "supp.tex": source });
});
it("keeps undo for the successful file when a later file write fails", async () => {
  setup(); await preview();
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "write_project_file" && (args as { path: string }).path === "supp.tex") throw new Error("disk full");
    return implementation(command, args);
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace listed usages" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
  expect(files["supp.tex"]).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Undo replacement" }));
  await waitFor(() => expect(files["main.tex"]).toBe(source));
});

it("keeps undo after navigating away and reopening the inventory", async () => {
  files["main.tex"] = source + String.raw` see \ref{fig:a}`;
  const original = { ...files };
  setup(); await preview();
  fireEvent.click(screen.getByRole("button", { name: "Replace listed usages" }));
  await waitFor(() => expect(afterWrite).toHaveBeenCalledTimes(1));
  fireEvent.click((await screen.findAllByRole("button", { name: /^Reference:/ }))[0]);
  expect(onOpen).toHaveBeenCalledWith("main.tex", { line: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo replacement" }));
  await waitFor(() => expect(afterWrite).toHaveBeenCalledTimes(2));
  expect(files).toEqual(original);
  expect(screen.queryByRole("button", { name: "Undo replacement" })).not.toBeInTheDocument();
});
it("clears figure undo when another project opens", () => {
  const { result, rerender } = renderHook(({ root }) => useProjectFigureUndo(root), { initialProps: { root: "/a" } });
  act(() => result.current[1](() => [{ path: "main.tex", before: "a", after: "b" }]));
  expect(result.current[0]).toHaveLength(1);
  rerender({ root: "/b" });
  expect(result.current[0]).toEqual([]);
  rerender({ root: "/a" });
  expect(result.current[0]).toEqual([]);
});
