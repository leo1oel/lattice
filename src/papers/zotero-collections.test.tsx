import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { AddPapersSheet } from "./add-papers-sheet";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { collectionTree, type ZoteroCollection, type ZoteroItem } from "./zotero";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
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
    invoke.mockImplementation(async (command: string) => (command === "zotero_collections" ? COLLECTIONS : ITEMS));
    const onAdd = sheet();
    const list = await screen.findByRole("list", { name: "Zotero collections" });
    // My Library, then the tree; a long name keeps one line, its full text on hover.
    const rows = within(list).getAllByRole("button").map((button) => button.textContent);
    expect(rows).toEqual(["My Library", "Thesis0", `${LONG_NAME}2`, "Orphan1"]);
    expect(screen.getByTitle(LONG_NAME)).toHaveClass("zotero-collection-name");

    fireEvent.click(screen.getByTitle(LONG_NAME));
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { collection: "CHAP0003" });
    expect(await screen.findByText("Sparse attention for long documents")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue(ITEMS.map((item) => item.bibtex).join("\n\n"));
    expect(screen.getByText("1 already in Papers is skipped")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add 1 paper" }));
    expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({ input: ITEMS[0].bibtex, pdf: "PDF00001" })]);
  });

  it("reads the whole library from My Library", async () => {
    invoke.mockImplementation(async (command: string) => (command === "zotero_collections" ? [] : ITEMS));
    sheet();
    fireEvent.click(await screen.findByTitle("My Library"));
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { collection: null });
    expect(await screen.findByText("Sparse attention for long documents")).toBeInTheDocument();
  });

  it.each([
    "Zotero isn't running. Open Zotero, then try again.",
    "In Zotero, turn on Settings › Advanced › “Allow other applications on this computer to communicate with Zotero”.",
  ])("says what to do (%s), and tries again", async (message) => {
    invoke.mockRejectedValueOnce(message).mockResolvedValue(COLLECTIONS);
    sheet();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Zotero collections" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("goes back to the paste box without reading anything", async () => {
    invoke.mockResolvedValue(COLLECTIONS);
    sheet();
    await screen.findByRole("list", { name: "Zotero collections" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue("");
    expect(invoke).not.toHaveBeenCalledWith("zotero_items", expect.anything());
  });
});
