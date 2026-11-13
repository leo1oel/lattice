import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { clearAddQueue, getAddQueue } from "../papers/add-papers-queue";
import { saveFullTextSetting } from "../papers/save-full-text-setting";
import { useReferenceImport } from "./use-reference-import";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./effect-helpers", () => ({ subscribeTauriEvent: () => () => undefined }));
const showNotice = vi.hoisted(() => vi.fn());
vi.mock("./notify", () => ({ showNotice, showError: vi.fn(), showWarning: vi.fn() }));

// A Zotero PDF is attached only when adds save full text, which is off by
// default; these tests cover that path.
beforeEach(() => saveFullTextSetting.set(true));

afterEach(() => {
  saveFullTextSetting.set(false);
  invoke.mockReset();
  showNotice.mockReset();
  clearAddQueue();
});

const ENTRY = "@article{Lee2024Sparse,\n\ttitle = {Sparse attention},\n\tyear = {2024}\n}";
const ADDED = { arxivId: "", title: "Sparse attention", citationKey: "Lee2024Sparse", alreadyImported: false, paperPath: "" };

function mount(project: ProjectSnapshot | null = null) {
  const refreshProject = vi.fn(async () => ({ manifest: { primaryBibliography: "references.bib" } }) as unknown as ProjectSnapshot);
  const { result } = renderHook(() => useReferenceImport({
    project,
    projectRootRef: { current: "/projects/thesis" },
    refreshProject,
    refreshHistory: vi.fn(async () => undefined),
    editor: { activeFile: "main.tex", dirty: false, save: vi.fn(async () => true), accept: vi.fn() },
    onCite: vi.fn(),
    onExternalEdits: { current: vi.fn() },
    onMissingPaperTools: vi.fn(),
  }));
  return { result, refreshProject };
}

async function addFromZotero(pdf: string | undefined) {
  const { result, refreshProject } = mount();
  act(() => result.current.addPapers([{ id: "bibtex:1", input: ENTRY, label: "Sparse attention", pdf }]));
  await waitFor(() => expect(getAddQueue()[0]?.state).toBe("added"));
  return { item: getAddQueue()[0], refreshProject };
}

describe("adding a Zotero item", () => {
  it("makes its PDF the paper's text once the citation lands", async () => {
    invoke.mockImplementation(async (command: string) => (command === "import_reference" ? ADDED : { arxivId: "web-0123456789abcdef", paperPath: "x/paper.md" }));
    const { item, refreshProject } = await addFromZotero("PDF00001");
    expect(invoke).toHaveBeenCalledWith("attach_zotero_pdf", { citationKey: "Lee2024Sparse", attachment: "PDF00001" });
    expect(item).toMatchObject({ citationKey: "Lee2024Sparse", note: undefined });
    expect(refreshProject).toHaveBeenCalledTimes(2);
  });

  it("keeps the citation, with the reason as its note, when the PDF cannot be read", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_reference") return ADDED;
      throw "The PDF has almost no text layer; a scanned paper needs OCR, which is not available.";
    });
    const { item } = await addFromZotero("PDF00001");
    expect(item.note).toContain("almost no text layer");
  });

  it.each([
    ["no PDF", undefined, ADDED],
    ["a full text already fetched", "PDF00001", { ...ADDED, arxivId: "2401.00001", paperPath: ".research/papers/2401.00001/paper.md" }],
    ["a paper already in Papers", "PDF00001", { ...ADDED, alreadyImported: true }],
  ])("attaches nothing for %s", async (_, pdf, imported) => {
    invoke.mockImplementation(async () => imported);
    await addFromZotero(pdf);
    expect(invoke).not.toHaveBeenCalledWith("attach_zotero_pdf", expect.anything());
  });
});

describe("bringing a Zotero item's annotations to its note", () => {
  const HIGHLIGHT = {
    key: "ANNHIGH1", attachment: "PDF00001", kind: "highlight", text: "Sparse attention keeps long documents in reach",
    comment: "Key idea", page: 3, pageLabel: "3", color: "#ffd400",
  };
  const NOTE = { ...HIGHLIGHT, key: "ANNNOTE1", kind: "note", text: "", comment: "Compare with dense retrieval", page: 1, pageLabel: "1" };
  const PAPER = {
    arxivId: "web-0123456789abcdef", title: "Sparse attention", citationKey: "Lee2024Sparse",
    hasFullText: true, hasBlog: false, hasLocalPdf: true,
  };

  /** The backend for one batch: the import, the attach, Zotero's annotations, the library, and the note on disk (`note`, null when not written). */
  function backend({ note = null as string | null, imported = ADDED as object, papers = [PAPER] as object[] } = {}) {
    const written: string[] = [];
    invoke.mockImplementation(async (command: string, args: { content?: string }) => {
      switch (command) {
        case "import_reference": return imported;
        case "attach_zotero_pdf": return { arxivId: PAPER.arxivId, paperPath: "x/paper.md" };
        case "zotero_annotations": return { SPARSE01: [HIGHLIGHT, NOTE] };
        case "list_papers": return papers;
        case "stat_project_file": return { exists: note !== null };
        case "read_project_file": return note;
        case "write_project_file": written.push(args.content!); return undefined;
        default: throw new Error(`unexpected ${command}`);
      }
    });
    return written;
  }

  async function add(items: Array<Record<string, unknown>>) {
    const { result } = mount();
    act(() => result.current.addPapers(items.map((item, index) => ({ id: `zotero:${index}`, input: ENTRY, label: "Sparse attention", ...item }))));
    await waitFor(() => expect(getAddQueue().every((item) => item.state === "added")).toBe(true));
    return getAddQueue();
  }

  it("writes a new paper's annotations to its note, with links to the page here and in Zotero", async () => {
    const written = backend();
    const [item] = await add([{ pdf: "PDF00001", annotations: { item: "SPARSE01", dataDir: null } }]);
    expect(invoke).toHaveBeenCalledWith("zotero_annotations", { dataDir: null, items: ["SPARSE01"] });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("## Zotero annotations");
    expect(written[0]).toContain("> Sparse attention keeps long documents in reach [p. 3](/.research/papers/web-0123456789abcdef/original.pdf#page=3 ");
    expect(written[0]).toContain("[Zotero](zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1)");
    expect(item.note).toBe("2 annotations in notes/Lee2024Sparse.md");
  });

  it("reads Zotero once for the whole batch", async () => {
    backend();
    await add([
      { pdf: "PDF00001", annotations: { item: "SPARSE01", dataDir: "/Volumes/Zotero" } },
      { annotations: { item: "OTHER001", dataDir: "/Volumes/Zotero" } },
    ]);
    expect(invoke.mock.calls.filter(([command]) => command === "zotero_annotations")).toEqual([
      ["zotero_annotations", { dataDir: "/Volumes/Zotero", items: ["SPARSE01", "OTHER001"] }],
    ]);
  });

  it("adds to a paper Papers holds only the annotations its note lacks, without importing it again", async () => {
    const note = "# Sparse attention\n\n> Earlier [Zotero](zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1)\n";
    const written = backend({ note, papers: [{ ...PAPER, hasLocalPdf: false }] });
    const [item] = await add([{ pdf: "PDF00001", existing: "Lee2024Sparse", annotations: { item: "SPARSE01", dataDir: null } }]);
    expect(invoke).not.toHaveBeenCalledWith("import_reference", expect.anything());
    // It had no PDF of its own, so the Zotero one comes with its annotations.
    expect(invoke).toHaveBeenCalledWith("attach_zotero_pdf", { citationKey: "Lee2024Sparse", attachment: "PDF00001" });
    expect(written).toHaveLength(1);
    expect(written[0].startsWith(note.trimEnd())).toBe(true);
    expect(written[0]).not.toContain("## Zotero annotations");
    expect(written[0]).toContain("annotation=ANNNOTE1");
    expect(item.note).toBe("1 annotation in notes/Lee2024Sparse.md");
  });

  it("leaves a note that holds every annotation as it is", async () => {
    const note = "> a [Zotero](zotero://open-pdf/library/items/PDF00001?annotation=ANNHIGH1)\n\nb [Zotero](zotero://open-pdf/library/items/PDF00001?page=1&annotation=ANNNOTE1)\n";
    const written = backend({ note });
    const [item] = await add([{ existing: "Lee2024Sparse", annotations: { item: "SPARSE01", dataDir: null } }]);
    expect(written).toEqual([]);
    expect(item.note).toBe("Annotations already in notes/Lee2024Sparse.md");
  });
});

describe("re-adding a cited paper", () => {
  it("offers to refresh its entry through the check Add papers runs", async () => {
    const entry = { path: "references.bib", key: "Lee2024Sparse", title: "Sparse attention", bibtex: ENTRY, issues: [] };
    invoke.mockImplementation(async (command: string) => ({
      import_reference: { ...ADDED, alreadyImported: true },
      bibliography_audit_scan: { entries: [entry], issues: [] },
      bibliography_audit_entry: { status: "update", message: "", before: ENTRY, after: "@article{Lee2024Sparse}", changes: [{ field: "pages", before: "", after: "1--9" }] },
    })[command]);
    const project = { root: "/projects/thesis", manifest: { primaryBibliography: "references.bib" } } as unknown as ProjectSnapshot;
    const { result, refreshProject } = mount(project);
    await act(() => result.current.importReference("2401.00001"));
    const [, , action] = showNotice.mock.calls[0];
    expect(action.label).toBe("Refresh entry");
    await act(() => action.onClick());
    expect(invoke).toHaveBeenCalledWith("bibliography_audit_apply", expect.objectContaining({ key: "Lee2024Sparse", after: "@article{Lee2024Sparse}" }));
    expect(refreshProject).toHaveBeenCalledTimes(2);
    expect(showNotice).toHaveBeenLastCalledWith("Updated the entry for \\cite{Lee2024Sparse} from its sources.");
  });
});
