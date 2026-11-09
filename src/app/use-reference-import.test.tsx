import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { clearAddQueue, getAddQueue } from "../papers/add-papers-queue";
import { useReferenceImport } from "./use-reference-import";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./effect-helpers", () => ({ subscribeTauriEvent: () => () => undefined }));
const showNotice = vi.hoisted(() => vi.fn());
vi.mock("./notify", () => ({ showNotice, showError: vi.fn(), showWarning: vi.fn() }));

afterEach(() => {
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
