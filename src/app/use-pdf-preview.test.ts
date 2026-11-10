import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { usePdfPreview } from "./use-pdf-preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});

const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }, { path: "SI.tex", name: "SI", isDefault: false }] },
} as unknown as ProjectSnapshot;
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.5 ${text}`).buffer;
const LIVE = { token: null, quiet: false };

function renderPreview() {
  return renderHook(() => usePdfPreview({ projectRef: { current: PROJECT } }));
}

describe("usePdfPreview", () => {
  it("names the document it shows, turns to another document's PDF at once, and keeps each one's bytes", () => {
    const view = renderPreview();
    const main = pdf("main");
    act(() => view.result.current.show(main, 0, true, LIVE, "main.tex", false));
    expect(view.result.current.shown).toEqual({ document: "main.tex", requested: false });
    const mainUrl = view.result.current.pdfUrl;
    expect(mainUrl).toBeTruthy();

    // Not immediate, but another document's: no debounce to wait out.
    const supplement = pdf("SI");
    act(() => view.result.current.show(supplement, 0, false, LIVE, "SI.tex", false));
    expect(view.result.current.shown).toEqual({ document: "SI.tex", requested: false });
    expect(view.result.current.pdfUrl).not.toBe(mainUrl);
    expect(view.result.current.shownBytes.get("main.tex")).toBe(main);
    expect(view.result.current.shownBytes.get("SI.tex")).toBe(supplement);

    // An autosave rebuild of the same document waits, and leaves `shown` as it was.
    const shown = view.result.current.shown;
    const url = view.result.current.pdfUrl;
    act(() => view.result.current.show(pdf("SI again"), 0, false, LIVE, "SI.tex", false));
    expect(view.result.current.pdfUrl).toBe(url);
    act(() => { vi.advanceTimersByTime(1_200); });
    expect(view.result.current.pdfUrl).not.toBe(url);
    expect(view.result.current.shown).toBe(shown);

    // A build asked for says so, even with the same pages.
    act(() => view.result.current.show(pdf("SI again"), 0, true, LIVE, "SI.tex", true));
    expect(view.result.current.shown).toEqual({ document: "SI.tex", requested: true });
    expect(view.result.current.shown).not.toBe(shown);
  });

  it("shows the default root document's PDF on disk when a project opens, and forgets the last project's", async () => {
    vi.mocked(invoke).mockResolvedValue(pdf("on disk"));
    const view = renderPreview();
    act(() => view.result.current.show(pdf("other"), 0, true, LIVE, "SI.tex", false));
    const onRead = vi.fn();
    await act(async () => { view.result.current.reset("/project", onRead); });
    expect(invoke).toHaveBeenCalledWith("read_compiled_pdf", { projectRoot: "/project" });
    expect(onRead).toHaveBeenCalledOnce();
    expect(view.result.current.shown).toEqual({ document: "main.tex", requested: false });
    expect(view.result.current.shownBytes.has("SI.tex")).toBe(false);
    expect(view.result.current.pdfUrl).toBeTruthy();
    // A build from before the reset shows nothing.
    act(() => view.result.current.show(pdf("late"), 0, true, LIVE, "SI.tex", false));
    expect(view.result.current.shown?.document).toBe("main.tex");
  });
});
