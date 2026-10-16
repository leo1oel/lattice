import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedLibrarySheet } from "./linked-library-sheet";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));
const notify = vi.hoisted(() => ({ showNotice: vi.fn(), showError: vi.fn() }));
vi.mock("../app/notify", () => notify);

const BASE = "@article{a,\n  title = {Alpha},\n  year = {2017},\n}\n\n@article{b,\n  title = {Beta},\n  year = {2018},\n}\n\n@article{c,\n  title = {Gamma},\n}\n";
const LOCAL = BASE.replace("{Beta}", "{Beta, my wording}");
const LIBRARY = "@article{a,\n  title = {Alpha},\n  year = {2018},\n}\n\n@article{b,\n  title = {Beta, theirs},\n  year = {2018},\n}\n\n@article{d,\n  title = {Delta},\n}\n";
const SOURCE = "/Users/writer/Zotero/My Library.bib";

function backend({ link = true, missing = false }: { link?: boolean; missing?: boolean } = {}) {
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "read_linked_bibliography":
        return link ? { source: SOURCE, target: "references.bib", updatedAt: Date.now() - 7_200_000, baseline: BASE } : null;
      case "read_bibliography_source":
        if (missing) throw new Error("No such file or directory (os error 2)");
        return LIBRARY;
      case "read_project_file":
        return LOCAL;
      case "list_citation_usages":
        return [{ kind: "citation", symbol: "c", role: "reference", path: "main.tex", line: 1, snippet: "" }];
      case "save_linked_bibliography":
        return { ...args, updatedAt: Date.now() };
      default:
        return null;
    }
  });
}

const renderSheet = (onRewrite = vi.fn(async (_path: string, change: (current: string) => string) => Boolean(change(LOCAL)))) => {
  const onClose = vi.fn();
  render(<LinkedLibrarySheet projectRoot="/p" bibliography="references.bib" onRewrite={onRewrite} onClose={onClose} />);
  return { onRewrite, onClose };
};

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.open.mockReset();
  notify.showNotice.mockReset();
  notify.showError.mockReset();
});
afterEach(cleanup);

describe("LinkedLibrarySheet", () => {
  it("lays out each kind of change, ticks only what is safe, and applies what is ticked", async () => {
    backend();
    const { onRewrite, onClose } = renderSheet();
    await screen.findByText("Delta");
    const box = (title: string) => screen.getByText(title, { selector: "strong" }).closest("label")!.querySelector("input")!;
    // New and updated come in; the writer's own wording stays; a cited paper cannot go.
    expect(box("Alpha").checked).toBe(true);
    expect(box("Delta").checked).toBe(true);
    expect(box("Beta, my wording").checked).toBe(false);
    expect(box("Gamma").disabled).toBe(true);
    expect(screen.getByText("Cited in the paper, so it stays")).toBeTruthy();
    expect(screen.getByText("2 of 4 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const written = onRewrite.mock.calls[0][1](LOCAL);
    expect(written).toContain("@article{a,\n  title = {Alpha},\n  year = {2018},");
    expect(written).toContain("{Beta, my wording}");
    expect(written).toContain("@article{c,");
    expect(written.endsWith("@article{d,\n  title = {Delta},\n}\n")).toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("save_linked_bibliography", {
      projectRoot: "/p", source: SOURCE, target: "references.bib", baseline: LIBRARY,
    });
    expect(notify.showNotice).toHaveBeenCalledWith("Updated references.bib from My Library.bib. Undo it from History.");
  });

  it("says a file it cannot read changed nothing, and offers to locate it", async () => {
    backend({ missing: true });
    renderSheet();
    await screen.findByText("Can't find My Library.bib. It may have been moved or renamed, or its drive is not connected.");
    expect(screen.getByText("references.bib has not been changed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Locate the file…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Apply|Link|Done)/ })).toBeNull();
  });

  it("links a chosen file only once the writer applies, keeping their version where an entry differs", async () => {
    backend({ link: false });
    tauri.open.mockResolvedValue(SOURCE);
    const { onRewrite } = renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Choose .bib file…" }));
    await screen.findByText("Delta");
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_linked_bibliography", expect.anything());
    const box = (title: string) => screen.getByText(title, { selector: "strong" }).closest("label")!.querySelector("input")!;
    // Before a first update nothing says which side made a difference.
    expect(box("Alpha").checked).toBe(false);
    expect(box("Delta").checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("save_linked_bibliography", expect.objectContaining({ baseline: LIBRARY })));
    expect(onRewrite).toHaveBeenCalledOnce();
  });
});
