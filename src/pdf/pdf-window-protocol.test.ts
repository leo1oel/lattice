import { describe, expect, it, vi } from "vitest";
import { runPdfWindowAction, type PdfWindowAction, type PdfWindowHandlers } from "./pdf-window-protocol";

function handlers(): PdfWindowHandlers {
  return {
    ready: vi.fn(), forwardSync: vi.fn(), source: vi.fn(), build: vi.fn(), dock: vi.fn(), openCitation: vi.fn(),
    navigateOutline: vi.fn(), pageCount: vi.fn(), page: vi.fn(), viewState: vi.fn(), select: vi.fn(),
  };
}

describe("the PDF window's actions", () => {
  it("are carried out only for the owner's current window", () => {
    const run = handlers();
    const source: PdfWindowAction = { window: "pdf-2", kind: "source", page: 3, x: 72, y: 540, word: null };
    // A window the owner has since replaced, another owner's window, or none open yet.
    expect(runPdfWindowAction(source, "pdf-3", run, () => true)).toBe(false);
    expect(runPdfWindowAction(source, null, run, () => true)).toBe(false);
    expect(run.source).not.toHaveBeenCalled();

    expect(runPdfWindowAction(source, "pdf-2", run, () => true)).toBe(true);
    expect(run.source).toHaveBeenCalledWith(3, 72, 540, null);
  });

  it("reach the handler each names", () => {
    const run = handlers();
    const actions: PdfWindowAction[] = [
      { window: "pdf-1", kind: "ready" },
      { window: "pdf-1", kind: "forward-sync" },
      { window: "pdf-1", kind: "build" },
      { window: "pdf-1", kind: "dock" },
      { window: "pdf-1", kind: "outline", path: "sections/intro.tex", line: 12 },
      { window: "pdf-1", kind: "page-count", count: 9 },
      { window: "pdf-1", kind: "page", page: 4 },
      { window: "pdf-1", kind: "view-state", state: { page: 4, scale: 1.25, fitMode: null, scrollTop: 900, scrollLeft: 0 } },
      { window: "pdf-1", kind: "select", text: "attention" },
    ];
    for (const action of actions) expect(runPdfWindowAction(action, "pdf-1", run, () => true)).toBe(true);
    expect(run.ready).toHaveBeenCalledOnce();
    expect(run.forwardSync).toHaveBeenCalledOnce();
    expect(run.build).toHaveBeenCalledOnce();
    expect(run.dock).toHaveBeenCalledOnce();
    expect(run.navigateOutline).toHaveBeenCalledWith("sections/intro.tex", 12);
    expect(run.pageCount).toHaveBeenCalledWith(9);
    expect(run.page).toHaveBeenCalledWith(4);
    expect(run.viewState).toHaveBeenCalledWith(expect.objectContaining({ page: 4, scrollTop: 900 }));
    expect(run.select).toHaveBeenCalledWith("attention");
  });

  it("open a citation only when the owner could open it, as the docked PDF offers it", () => {
    const run = handlers();
    const openable = (key: string) => key === "vaswani2017";
    expect(runPdfWindowAction({ window: "pdf-1", kind: "citation", key: "unknown2020" }, "pdf-1", run, openable)).toBe(false);
    expect(runPdfWindowAction({ window: "pdf-1", kind: "citation", key: "vaswani2017" }, "pdf-1", run, openable)).toBe(true);
    expect(run.openCitation).toHaveBeenCalledOnce();
    expect(run.openCitation).toHaveBeenCalledWith("vaswani2017", undefined);
  });
});
