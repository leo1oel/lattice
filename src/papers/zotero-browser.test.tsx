import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { AddPapersSheet } from "./add-papers-sheet";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { collectionTree, folderRows, type ZoteroCollection, type ZoteroItem } from "./zotero";

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
  { key: "CHAP0003", name: LONG_NAME, parent: "THESIS01", items: 3, total: 3 },
  { key: "THESIS01", name: "Thesis", parent: null, items: 1, total: 4 },
  { key: "EMPTY001", name: "Empty", parent: null, items: 0, total: 0 },
  { key: "ORPHAN01", name: "Orphan", parent: "GONE0001", items: 1, total: 1 },
];
const entry = (key: string, title: string, extra = "") => `@article{${key},\n  title = {${title}},\n  author = {Lee, Ada},\n  year = {2024}${extra}\n}`;
const CHAPTER: ZoteroItem[] = [
  { citationKey: "Lee2024Sparse", pdf: "PDF00001", bibtex: entry("Lee2024Sparse", "Sparse attention for long documents", ",\n  doi = {10.1000/sparse}") },
  { citationKey: "lee_dense_2024", pdf: null, bibtex: entry("lee_dense_2024", "Dense retrieval for drafting") },
  { citationKey: "vaswani2017attention", pdf: null, bibtex: entry("vaswani2017attention", "Attention Is All You Need", ",\n  eprint = {1706.03762}") },
];
const THESIS: ZoteroItem[] = [{ citationKey: "gu_mamba_2023", pdf: null, bibtex: entry("gu_mamba_2023", "Mamba") }];
const DATA_DIR = "/Users/ada/Zotero";
const LIBRARY = { dataDir: DATA_DIR, collections: COLLECTIONS };
const IN_PAPERS = {
  arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani, Ashish", citationKey: "vaswani2017attention",
  hasFullText: true, hasBlog: false, assetPaths: [],
} as PaperSummary;

/** Zotero answering from LIBRARY: a folder's items, with its subfolders' when asked. */
function zotero(command: string, args?: { collection?: string | null; includeSubfolders?: boolean }) {
  if (command === "zotero_library") return Promise.resolve(LIBRARY);
  if (args?.collection === "CHAP0003") return Promise.resolve(CHAPTER);
  if (args?.collection === "THESIS01") return Promise.resolve(args.includeSubfolders ? [...THESIS, ...CHAPTER] : THESIS);
  return Promise.resolve([]);
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

describe("Add papers from Zotero", () => {
  it("adds exactly the ticked papers of a folder, each with its PDF, and never one Papers holds", async () => {
    invoke.mockImplementation(zotero);
    const onAdd = sheet();
    await waitFor(() => expect(folderNames()).toEqual(["My Library", "Thesis", "Empty", "Orphan"]));
    fireEvent.click(screen.getByRole("button", { name: "Expand Thesis" }));
    expect(folderNames()).toEqual(["My Library", "Thesis", LONG_NAME, "Empty", "Orphan"]);

    openFolder(LONG_NAME);
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: DATA_DIR, collection: "CHAP0003", includeSubfolders: false });
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
    expect(count()).toBe("1");
    openFolder("Thesis");
    expect(await screen.findAllByRole("checkbox", { name: "Mamba" })).toHaveLength(1);
    expect(screen.queryByRole("checkbox", { name: "Dense retrieval for drafting" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Include subfolders" }));
    expect(await screen.findByRole("checkbox", { name: "Dense retrieval for drafting" })).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: DATA_DIR, collection: "THESIS01", includeSubfolders: true });
    expect(count()).toBe("4");
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
  });

  it("reads a library kept in a folder the writer chooses", async () => {
    invoke.mockRejectedValueOnce("Lattice couldn't find a Zotero library on this Mac.")
      .mockImplementation((command: string, args?: { collection?: string | null }) => (command === "zotero_library"
        ? Promise.resolve({ dataDir: "/Volumes/Research/Zotero", collections: COLLECTIONS })
        : zotero(command, args)));
    openDialog.mockResolvedValue("/Volumes/Research/Zotero");
    sheet();
    fireEvent.click(await screen.findByRole("button", { name: "Choose Zotero folder…" }));
    expect(await screen.findByRole("tree", { name: "Zotero folders" })).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("zotero_library", { dataDir: "/Volumes/Research/Zotero" });
    openFolder("Thesis");
    expect(invoke).toHaveBeenLastCalledWith("zotero_items", { dataDir: "/Volumes/Research/Zotero", collection: "THESIS01", includeSubfolders: false });
  });

  it("drops a read that lands after Back, keeping what was typed since", async () => {
    let finish: (items: ZoteroItem[]) => void = () => {};
    invoke.mockImplementation((command: string) => (command === "zotero_library"
      ? Promise.resolve(LIBRARY)
      : new Promise<ZoteroItem[]>((resolve) => { finish = resolve; })));
    sheet();
    await screen.findByRole("tree", { name: "Zotero folders" });
    openFolder("Thesis");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Paste references" }), { target: { value: "10.1000/typed" } });
    await act(async () => { finish(THESIS); });
    expect(screen.getByRole("textbox", { name: "Paste references" })).toHaveValue("10.1000/typed");
  });
});
