import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { reviewMode } from "./review-mode-store";
import { MARKED_PDF_DELAY_MS, useMarkedPdf } from "./use-marked-pdf";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const host = vi.mocked(invoke);
const PDF = new TextEncoder().encode("%PDF-1.7 marked").buffer;

beforeEach(async () => {
  vi.useFakeTimers();
  host.mockImplementation(async (command: string) => {
    if (command === "review_mode_load") return { startedAt: "2026-11-08T00:00:00Z", bases: { "main.tex": "x" } };
    if (command === "review_changes_pdf") return PDF;
    return null;
  });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:marked");
  globalThis.URL.revokeObjectURL = vi.fn();
  await reviewMode.load("/project");
});

afterEach(async () => {
  // Unmounted before review mode changes, so no test's hook builds in the next.
  cleanup();
  await reviewMode.load(null);
  vi.useRealTimers();
  host.mockReset();
});

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(MARKED_PDF_DELAY_MS + 10);
});

describe("review mode's marked PDF", () => {
  it("is built only while it is asked for, and after each build of the paper", async () => {
    const { result, rerender } = renderHook(({ url }) => useMarkedPdf("/project", url), { initialProps: { url: "blob:paper-1" } });
    await settle();
    expect(result.current.url).toBeNull();
    expect(host).not.toHaveBeenCalledWith("review_changes_pdf", expect.anything());

    act(() => reviewMode.setMarked(true));
    await settle();
    expect(result.current).toEqual({ url: "blob:marked", building: false, error: null });
    expect(host).toHaveBeenCalledTimes(2);

    rerender({ url: "blob:paper-2" });
    await settle();
    expect(host.mock.calls.filter(([command]) => command === "review_changes_pdf")).toHaveLength(2);

    act(() => reviewMode.setMarked(false));
    await settle();
    expect(result.current.url).toBeNull();
  });

  it("falls back to the paper's own PDF with the reason when latexdiff fails or times out", async () => {
    host.mockImplementation(async (command: string) => {
      if (command === "review_changes_pdf") {
        throw new Error("latexdiff was stopped after 5 minutes without finishing.");
      }
      return null;
    });
    const { result } = renderHook(() => useMarkedPdf("/project", "blob:paper"));
    act(() => reviewMode.setMarked(true));
    await settle();
    expect(result.current.url).toBeNull();
    expect(result.current.building).toBe(false);
    expect(result.current.error).toContain("latexdiff was stopped");
  });

  it("drops an answer a newer build has replaced", async () => {
    let resolveFirst: (bytes: ArrayBuffer) => void = () => undefined;
    let builds = 0;
    host.mockImplementation((command: string) => {
      if (command !== "review_changes_pdf") return Promise.resolve(null);
      builds += 1;
      return builds === 1 ? new Promise((resolve) => { resolveFirst = resolve as never; }) : Promise.resolve(PDF);
    });
    const { result, rerender } = renderHook(({ url }) => useMarkedPdf("/project", url), { initialProps: { url: "blob:1" } });
    act(() => reviewMode.setMarked(true));
    await settle();
    rerender({ url: "blob:2" });
    await settle();
    expect(result.current.url).toBe("blob:marked");
    vi.mocked(URL.createObjectURL).mockClear();
    await act(async () => resolveFirst(PDF));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
