import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { AddPapersSheet } from "./add-papers-sheet";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { collectionTree, folderCounts, folderItems, folderRows, type ZoteroCollection, type ZoteroItem, type ZoteroLibrary } from "./zotero";

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
  { key: "CHAP0003", name: LONG_NAME, parent: "THESIS01" },
  { key: "THESIS01", name: "Thesis", parent: null },
  { key: "EMPTY001", name: "Empty", parent: null },
  { key: "ORPHAN01", name: "Orphan", parent: "GONE0001" },
];
const entry = (key: string, title: string, extra = "") => `@article{${key},\n  title = {${title}},\n  author = {Lee, Ada},\n  year = {2024}${extra}\n}`;
// Sparse attention sits in Thesis and in its Chapter 3 both.
const CHAPTER: ZoteroItem[] = [
  { citationKey: "Lee2024Sparse", pdf: "PDF00001", collections: ["THESIS01", "CHAP0003"], bibtex: entry("Lee2024Sparse", "Sparse attention for long documents", ",\n  doi = {10.1000/sparse}") },
  { citationKey: "lee_dense_2024", pdf: null, collections: ["CHAP0003"], bibtex: entry("lee_dense_2024", "Dense retrieval for drafting") },
  { citationKey: "vaswani2017attention", pdf: null, collections: ["CHAP0003"], bibtex: entry("vaswani2017attention", "Attention Is All You Need", ",\n  eprint = {1706.03762}") },
];
const MAMBA: ZoteroItem = { citationKey: "gu_mamba_2023", pdf: null, collections: ["THESIS01"], bibtex: entry("gu_mamba_2023", "Mamba") };
const LOOSE: ZoteroItem = { citationKey: "lee_loose_2024", pdf: null, collections: [], bibtex: entry("lee_loose_2024", "In no folder") };
const DATA_DIR = "/Users/ada/Zotero";
const LIBRARY: ZoteroLibrary = { dataDir: DATA_DIR, collections: COLLECTIONS, items: [...CHAPTER, MAMBA, LOOSE] };
const IN_PAPERS = {
  arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani, Ashish", citationKey: "vaswani2017attention",
  hasFullText: true, hasBlog: false, assetPaths: [],
} as PaperSummary;

/** Zotero answering with LIBRARY, its one read. */
function zotero(command: string) {
  return command === "zotero_library" ? Promise.resolve(LIBRARY) : Promise.reject(new Error(`unexpected ${command}`));
}

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

const folderNames = () => within(screen.getByRole("tree", { name: "Zotero folders" }))
  .getAllByRole("treeitem").map((row) => row.querySelector(".zotero-folder-name")?.textContent);
const inTree = () => within(screen.getByRole("tree", { name: "Zotero folders" }));
const openFolder = (name: string) => fireEvent.click(inTree().getByTitle(name));

describe("Zotero folder rows", () => {
  it("puts each folder under its parent, and one whose parent is missing at the top", () => {
    expect(collectionTree(COLLECTIONS).map(({ key, depth }) => [key, depth])).toEqual([
      ["THESIS01", 0], ["CHAP0003", 1], ["EMPTY001", 0], ["ORPHAN01", 0],
    ]);
  });

  it("opens only expanded folders, and a search opens what it takes to show each match", () => {
    expect(folderRows(COLLECTIONS, new Set(), "").map((row) => row.key)).toEqual(["THESIS01", "EMPTY001", "ORPHAN01"]);
    expect(folderRows(COLLECTIONS, new Set(["THESIS01"]), "").map((row) => [row.key, row.expanded])).toEqual([
      ["THESIS01", true], ["CHAP0003", false], ["EMPTY001", false], ["ORPHAN01", false],
    ]);
    expect(folderRows(COLLECTIONS, new Set(), "chapter").map((row) => row.key)).toEqual(["THESIS01", "CHAP0003"]);
  });
});

describe("Zotero folder contents", () => {
  const keys = (items: ZoteroItem[]) => items.map((item) => item.citationKey);

  it("lists a folder's own papers, or with its subfolders every paper below it once", () => {
    expect(keys(folderItems(LIBRARY, "THESIS01", false))).toEqual(["Lee2024Sparse", "gu_mamba_2023"]);
    expect(keys(folderItems(LIBRARY, "THESIS01", true))).toEqual(["Lee2024Sparse", "lee_dense_2024", "vaswani2017attention", "gu_mamba_2023"]);
    expect(keys(folderItems(LIBRARY, "EMPTY001", true))).toEqual([]);
    expect(keys(folderItems(LIBRARY, "", false))).toHaveLength(5);
  });

  it("counts each folder as it lists it", () => {
    expect(Object.fromEntries(folderCounts(LIBRARY, false))).toEqual({ CHAP0003: 3, THESIS01: 2, EMPTY001: 0, ORPHAN01: 0 });
    expect(Object.fromEntries(folderCounts(LIBRARY, true))).toEqual({ CHAP0003: 3, THESIS01: 4, EMPTY001: 0, ORPHAN01: 0 });
  });
});

describe("Add papers from Zotero", () => {
  it("adds exactly the ticked papers of a folder, each with its PDF, and never one Papers holds", async () => {
    invoke.mockImplementation(zotero);
    const onAdd = sheet();
    await waitFor(() => expect(folderNames()).toEqual(["My Library", "Thesis", "Empty", "Orphan"]));
    fireEvent.click(screen.getByRole("button", { name: "Expand Thesis" }));
    expect(folderNames()).toEqual(["My Library", "Thesis", LONG_NAME, "Empty", "Orphan"]);

    openFolder(LONG_NAME);
    const list = await screen.findByRole("list", { name: LONG_NAME });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(3);
    const held = screen.getByRole("checkbox", { name: "Attention Is All You Need" });
    expect(held).toBeDisabled();
    expect(within(held.closest("li")!).getByText("In Papers")).toBeInTheDocument();
    expect(within(screen.getByRole("checkbox", { name: "Sparse attention for long documents" }).closest("li")!).getByText("PDF")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add papers$/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Sparse attention for long documents" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 paper selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 papers selected");
    fireEvent.click(screen.getByRole("button", { name: "Add 2 papers" }));
    expect(onAdd).toHaveBeenCalledWith([
      { id: "zotero:Lee2024Sparse", input: CHAPTER[0].bibtex, label: "Sparse attention for long documents", pdf: "PDF00001" },
      { id: "zotero:lee_dense_2024", input: CHAPTER[1].bibtex, label: "Dense retrieval for drafting", pdf: undefined },
    ]);
    expect(invoke.mock.calls).toEqual([["zotero_library", { dataDir: null }]]);
  });

  it("says an empty folder is empty, with nothing to add", async () => {
    invoke.mockImplementation(zotero);
    sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    openFolder("Empty");
    expect(await screen.findByText("No papers in this folder")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select all" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add papers$/ })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Paste references" })).not.toBeInTheDocument();
  });

  it("brings in a folder's subfolders when asked, and counts to match", async () => {
    invoke.mockImplementation(zotero);
    sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    const count = () => inTree().getByTitle("Thesis").closest("button")!.querySelector(".zotero-count")?.textContent;
    expect(count()).toBe("2");
    openFolder("Thesis");
    expect(await screen.findAllByRole("checkbox", { name: "Mamba" })).toHaveLength(1);
    expect(screen.queryByRole("checkbox", { name: "Dense retrieval for drafting" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Include subfolders" }));
    const list = screen.getByRole("list", { name: "Thesis" });
    expect(within(list).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "Sparse attention for long documents", "Dense retrieval for drafting", "Attention Is All You Need", "Mamba",
    ]);
    expect(count()).toBe("4");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("finds papers in the folder by title", async () => {
    invoke.mockImplementation(zotero);
    sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    fireEvent.click(screen.getByRole("button", { name: "Expand Thesis" }));
    openFolder(LONG_NAME);
    await screen.findByRole("list", { name: LONG_NAME });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search papers" }), { target: { value: "dense" } });
    expect(within(screen.getByRole("list", { name: LONG_NAME })).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual(["Dense retrieval for drafting"]);
  });

  it("selects all of the papers a search shows, and adds those ticked in every folder", async () => {
    invoke.mockImplementation(zotero);
    const onAdd = sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    openFolder("Thesis");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mamba" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Thesis" }));
    openFolder(LONG_NAME);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search papers" }), { target: { value: "dense" } });
    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    fireEvent.click(selectAll);
    expect(screen.getByRole("status")).toHaveTextContent("2 papers selected");
    fireEvent.click(selectAll);
    expect(screen.getByRole("status")).toHaveTextContent("1 paper selected");
    fireEvent.click(selectAll);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search papers" }), { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "Dense retrieval for drafting" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Sparse attention for long documents" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 papers" }));
    expect(onAdd).toHaveBeenCalledWith([
      { id: "zotero:gu_mamba_2023", input: MAMBA.bibtex, label: "Mamba", pdf: undefined },
      { id: "zotero:lee_dense_2024", input: CHAPTER[1].bibtex, label: "Dense retrieval for drafting", pdf: undefined },
    ]);
  });

  it("steps back with Escape: the folders first, then the paste box", async () => {
    invoke.mockImplementation(zotero);
    sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    openFolder("Thesis");
    await screen.findByRole("checkbox", { name: "Mamba" });
    expect(document.querySelector(".zotero-browser")).toHaveAttribute("data-pane", "papers");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.querySelector(".zotero-browser")).toHaveAttribute("data-pane", "folders");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(await screen.findByRole("textbox", { name: "Paste references" })).toBeInTheDocument();
  });

  it.each([
    "Lattice couldn't find a Zotero library on this Mac.",
    "Lattice couldn't read the Zotero library: database disk image is malformed",
  ])("says what went wrong (%s), and tries again", async (message) => {
    invoke.mockRejectedValueOnce(message).mockImplementation(zotero);
    sheet();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("tree", { name: "Zotero folders" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reads a library kept in a folder the writer chooses", async () => {
    invoke.mockRejectedValueOnce("Lattice couldn't find a Zotero library on this Mac.")
      .mockImplementation(() => Promise.resolve({ ...LIBRARY, dataDir: "/Volumes/Research/Zotero" }));
    openDialog.mockResolvedValue("/Volumes/Research/Zotero");
    sheet();
    fireEvent.click(await screen.findByRole("button", { name: "Choose Zotero folder…" }));
    expect(await screen.findByRole("tree", { name: "Zotero folders" })).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("zotero_library", { dataDir: "/Volumes/Research/Zotero" });
    openFolder("Thesis");
    expect(await screen.findByRole("checkbox", { name: "Mamba" })).toBeInTheDocument();
  });

  it("drops a read that lands after Back, keeping what was typed since", async () => {
    let finish: (library: ZoteroLibrary) => void = () => {};
    invoke.mockImplementation(() => new Promise<ZoteroLibrary>((resolve) => { finish = resolve; }));
    sheet();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Paste references" }), { target: { value: "10.1000/typed" } });
    await act(async () => { finish(LIBRARY); });
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue("10.1000/typed");
  });
});
