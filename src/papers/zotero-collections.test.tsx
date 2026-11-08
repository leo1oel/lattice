import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { AddPapersSheet } from "./add-papers-sheet";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { collectionTree, type ZoteroCollection, type ZoteroItem } from "./zotero";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const openDialog = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog, confirm: vi.fn(), save: vi.fn() }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
  openDialog.mockReset();
});

const LONG_NAME = "Reading for chapter three: sparse attention, retrieval and long-context evaluation";
const COLLECTIONS: ZoteroCollection[] = [
  { key: "CHAP0003", name: LONG_NAME, parent: "THESIS01", items: 2 },
  { key: "THESIS01", name: "Thesis", parent: null, items: 0 },
  { key: "ORPHAN01", name: "Orphan", parent: "GONE0001", items: 1 },
];
const ITEMS: ZoteroItem[] = [
  { citationKey: "Lee2024Sparse", pdf: "PDF00001", bibtex: "@article{Lee2024Sparse,\n\ttitle = {Sparse attention for long documents},\n\tauthor = {Lee, Ada},\n\tyear = {2024},\n\tdoi = {10.1000/sparse}\n}" },
  { citationKey: "vaswani2017attention", pdf: null, bibtex: "@inproceedings{vaswani2017attention,\n\ttitle = {Attention Is All You Need},\n\tauthor = {Vaswani, Ashish},\n\tyear = {2017}\n}" },
];
const DATA_DIR = "/Users/ada/Zotero";
const LIBRARY = { dataDir: DATA_DIR, collections: COLLECTIONS };
const IN_PAPERS = {
  arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani, Ashish", citationKey: "vaswani2017attention",
  hasFullText: true, hasBlog: false, assetPaths: [],
} as PaperSummary;

function sheet(onAdd = vi.fn()) {
  render(
    <AddPapersSheet
      seed="" papers={[IN_PAPERS]} importing={false}
      onResolve={vi.fn() as unknown as (query: string) => Promise<ResolvedCitationDraft>}
      onAdd={onAdd} onStop={vi.fn()} onEnterManually={vi.fn()} onLinkLibrary={vi.fn()} onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Zotero…" }));
  return onAdd;
}

describe("collectionTree", () => {
  it("puts each collection under its parent, and one whose parent is missing at the top", () => {
    expect(collectionTree(COLLECTIONS).map(({ key, depth }) => [key, depth])).toEqual([
      ["THESIS01", 0], ["CHAP0003", 1], ["ORPHAN01", 0],
    ]);
  });
});

describe("Add papers from Zotero", () => {
  it("brings a collection in as references, skipping what Papers holds and carrying each PDF", async () => {
    invoke.mockImplementation(async (command: string) => (command === "zotero_library" ? LIBRARY : ITEMS));
    const onAdd = sheet();
    const list = await screen.findByRole("list", { name: "Zotero collections" });
    // My Library, then the tree; a long name keeps one line, its full text on hover.
    const rows = within(list).getAllByRole("button").map((button) => button.textContent);
    expect(rows).toEqual(["My Library", "Thesis0", `${LONG_NAME}2`, "Orphan1"]);
    expect(screen.getByTitle(LONG_NAME)).toHaveClass("zotero-collection-name");

    fireEvent.click(screen.getByTitle(LONG_NAME));
    expect(invoke).toHaveBeenCalledWith("zotero_library", { dataDir: null });
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: DATA_DIR, collection: "CHAP0003" });
    expect(await screen.findByText("Sparse attention for long documents")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue(ITEMS.map((item) => item.bibtex).join("\n\n"));
    expect(screen.getByText("1 already in Papers is skipped")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add 1 paper" }));
    expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({ input: ITEMS[0].bibtex, pdf: "PDF00001" })]);
  });

  it("reads the whole library from My Library", async () => {
    invoke.mockImplementation(async (command: string) => (command === "zotero_library" ? { dataDir: DATA_DIR, collections: [] } : ITEMS));
    sheet();
    fireEvent.click(await screen.findByTitle("My Library"));
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: DATA_DIR, collection: null });
    expect(await screen.findByText("Sparse attention for long documents")).toBeInTheDocument();
  });

  it.each([
    "Lattice couldn't find a Zotero library on this Mac.",
    "Lattice couldn't read the Zotero library: database disk image is malformed",
  ])("says what went wrong (%s), and tries again", async (message) => {
    invoke.mockRejectedValueOnce(message).mockResolvedValue(LIBRARY);
    sheet();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Zotero collections" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reads a library kept in a folder the writer chooses", async () => {
    invoke.mockRejectedValueOnce("Lattice couldn't find a Zotero library on this Mac.")
      .mockImplementation(async (command: string) => (command === "zotero_library" ? { dataDir: "/Volumes/Research/Zotero", collections: COLLECTIONS } : ITEMS));
    openDialog.mockResolvedValue("/Volumes/Research/Zotero");
    sheet();
    fireEvent.click(await screen.findByRole("button", { name: "Choose Zotero folder…" }));
    expect(await screen.findByRole("list", { name: "Zotero collections" })).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("zotero_library", { dataDir: "/Volumes/Research/Zotero" });
    fireEvent.click(screen.getByTitle("Thesis"));
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: "/Volumes/Research/Zotero", collection: "THESIS01" });
  });

  it("drops a read that finishes after Back, keeping what was typed since", async () => {
    let finish: (items: ZoteroItem[]) => void = () => {};
    invoke.mockImplementation((command: string) => (command === "zotero_library"
      ? Promise.resolve(LIBRARY)
      : new Promise<ZoteroItem[]>((resolve) => { finish = resolve; })));
    sheet();
    fireEvent.click(await screen.findByTitle("My Library"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const box = screen.getByRole("textbox", { name: "Paste references" });
    fireEvent.change(box, { target: { value: "10.1000/typed" } });
    await act(async () => { finish(ITEMS); });
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue("10.1000/typed");
    expect(screen.queryByRole("list", { name: "Zotero collections" })).not.toBeInTheDocument();
  });

  it("goes back to the paste box without reading anything", async () => {
    invoke.mockResolvedValue(LIBRARY);
    sheet();
    await screen.findByRole("list", { name: "Zotero collections" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue("");
    expect(invoke).not.toHaveBeenCalledWith("zotero_items", expect.anything());
  });
});
