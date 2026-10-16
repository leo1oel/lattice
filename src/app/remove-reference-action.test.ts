import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { confirmAction } from "../app-utils";
import { showError } from "./notify";
import { removeReference } from "./remove-reference-action";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn() }));
vi.mock("../app-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-utils")>(),
  confirmAction: vi.fn(),
  chooseAction: vi.fn(),
}));

const ROOT = "/papers/attention";
const paper: PaperSummary = {
  arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention",
  hasFullText: false, hasBlog: false,
};

/** The removal's inputs with `main.tex` open holding `source`; `current` answers every scope check. */
function removal({ source = "", current = () => true }: { source?: string; current?: () => boolean } = {}) {
  return {
    project: { root: ROOT, manifest: { primaryBibliography: "references.bib" } },
    captureProjectScope: () => current,
    flush: () => true,
    save: vi.fn(async () => true),
    activeFile: "main.tex",
    activeFileRef: { current: "main.tex" },
    sourceRef: { current: source },
    accept: vi.fn(() => true),
    markDiskVersion: vi.fn(async () => undefined),
    activePaper: null,
    leavePaper: vi.fn(),
    refreshProject: vi.fn(async () => undefined),
    refreshHistory: vi.fn(async () => undefined),
  };
}

/** Answers `remove_reference`'s preview with no blockers, then `result` for the removal itself. */
function mockRemoval(result: object) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "remove_reference") return undefined;
    if ((args as { citationMode?: string }).citationMode === "preview") {
      return { key: paper.citationKey, removed: false, blockers: [], changedFiles: [], removedCitations: 0 };
    }
    return { key: paper.citationKey, removedCitations: 0, blockers: [], changedFiles: [], ...result };
  });
}

const removeCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "remove_reference");

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(confirmAction).mockReset();
  vi.mocked(showError).mockReset();
});

describe("removeReference", () => {
  it("abandons the removal when another project opens while the writer confirms", async () => {
    let open = true;
    mockRemoval({ removed: true });
    vi.mocked(confirmAction).mockImplementation(async () => {
      open = false;
      return true;
    });
    const inputs = removal({ current: () => open });

    await removeReference(paper, inputs);

    expect(removeCalls().map(([, args]) => (args as { citationMode?: string }).citationMode)).toEqual(["preview"]);
    expect(inputs.refreshProject).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it("reverts rather than merging a result older than the open buffer", async () => {
    mockRemoval({
      removed: true,
      transactionId: "tx-1",
      changedFiles: ["main.tex"],
      changes: [{ path: "main.tex", before: "See \\cite{vaswani2017attention}.", after: "See ." }],
    });
    vi.mocked(confirmAction).mockResolvedValue(true);
    const inputs = removal({ source: "See \\cite{vaswani2017attention}. Typed while confirming." });

    await removeReference(paper, inputs);

    expect(invoke).toHaveBeenCalledWith("revert_transaction", { transactionId: "tx-1", projectRoot: ROOT });
    expect(showError).toHaveBeenCalledWith(
      "main.tex changed while the reference was being removed. Nothing was removed; try again.",
    );
    expect(inputs.accept).not.toHaveBeenCalled();
    expect(inputs.refreshProject).toHaveBeenCalled();
  });
});
