import { describe, expect, it } from "vitest";
import {
  annotationBounds,
  closestPdfPageIndex,
  findPdfMatches,
  fitPdfScale,
  normalizePdfSelection,
  parsePdfZoomPercent,
  PdfCooperativeRenderQueue,
  PdfRenderQueue,
  PDF_MAX_CANVAS_PIXELS,
  PDF_RENDER_PRIORITY,
  pdfRenderPixelRatio,
  updatePdfRenderCache,
} from "./pdf-viewer-utils";

function runPending(callback: (() => void) | null) {
  callback?.();
}

describe("PDF viewer helpers", () => {
  it("finds the closest ordered page with logarithmic rect reads and first-page ties", () => {
    const rects = Array.from({ length: 128 }, (_, index) => ({
      top: index * 110,
      bottom: index * 110 + 100,
    }));
    let reads = 0;
    const find = (marker: number) => closestPdfPageIndex(rects.length, (index) => {
      reads += 1;
      return rects[index];
    }, marker);
    expect(find(105)).toBe(0);
    expect(find(106)).toBe(1);
    expect(find(5_555)).toBe(50);
    expect(find(-20)).toBe(0);
    expect(find(99_999)).toBe(127);
    expect(reads).toBeLessThan(55);
    expect(closestPdfPageIndex(0, () => ({ top: 0, bottom: 0 }), 0)).toBe(-1);
  });

  it("limits concurrent page renders and keeps visible pages in arrival order", async () => {
    const queue = new PdfRenderQueue();
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const enqueue = (page: number, priority: number = PDF_RENDER_PRIORITY.cached) => queue.enqueue(async () => {
      started.push(page);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, priority);

    enqueue(1);
    enqueue(2);
    const cancelPage3 = enqueue(3);
    const prioritizePage8 = enqueue(8);
    enqueue(9, PDF_RENDER_PRIORITY.nearby);
    prioritizePage8.prioritize();
    expect(started).toEqual([1, 2]);
    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 8]);
    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 2, 8, 9]);
    cancelPage3();
    finish.forEach((resolve) => resolve());
  });

  it("serializes canvas work and reorders pending pages as the viewport moves", async () => {
    const queue = new PdfRenderQueue(1);
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const enqueue = (page: number, priority: number) => queue.enqueue(async () => {
      started.push(page);
      await new Promise<void>((resolve) => finish.push(resolve));
    }, priority);

    enqueue(1, PDF_RENDER_PRIORITY.current);
    const page2 = enqueue(2, PDF_RENDER_PRIORITY.current);
    enqueue(3, PDF_RENDER_PRIORITY.nearby);
    const page4 = enqueue(4, PDF_RENDER_PRIORITY.cached);
    expect(started).toEqual([1]);

    // A fast scroll demotes the old target and promotes the new current page.
    page2.setPriority(PDF_RENDER_PRIORITY.cached);
    page4.setPriority(PDF_RENDER_PRIORITY.current);
    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 4]);

    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 4, 3]);

    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([1, 4, 3, 2]);
    finish.shift()?.();
  });

  it("pauses a background canvas at a continuation boundary and resumes it intact", async () => {
    const queue = new PdfCooperativeRenderQueue();
    const events: string[] = [];
    let yieldBackground: (() => void) | null = null;
    let finishBackground: (() => void) | null = null;
    let finishCurrent: (() => void) | null = null;

    queue.enqueue(async (onContinue) => {
      events.push("background:start");
      yieldBackground = () => onContinue(() => events.push("background:resume"));
      await new Promise<void>((resolve) => { finishBackground = resolve; });
    }, PDF_RENDER_PRIORITY.cached);
    queue.enqueue(async () => {
      events.push("current:start");
      await new Promise<void>((resolve) => { finishCurrent = resolve; });
    }, PDF_RENDER_PRIORITY.current);

    expect(events).toEqual(["background:start", "current:start"]);
    runPending(yieldBackground);
    expect(events).toEqual(["background:start", "current:start"]);

    runPending(finishCurrent);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([
      "background:start",
      "current:start",
      "background:resume",
    ]);
    runPending(finishBackground);
  });

  it("starts a newly current page while background work is waiting for PDF data", async () => {
    const queue = new PdfCooperativeRenderQueue();
    const events: string[] = [];
    let finishBackground: (() => void) | null = null;
    let finishCurrent: (() => void) | null = null;

    queue.enqueue(async () => {
      events.push("background:start");
      await new Promise<void>((resolve) => { finishBackground = resolve; });
    }, PDF_RENDER_PRIORITY.cached);
    queue.enqueue(async () => {
      events.push("current:start");
      await new Promise<void>((resolve) => { finishCurrent = resolve; });
    }, PDF_RENDER_PRIORITY.current);

    expect(events).toEqual(["background:start", "current:start"]);
    runPending(finishCurrent);
    runPending(finishBackground);
  });

  it("keeps equal-priority cooperative jobs in FIFO order", async () => {
    const queue = new PdfCooperativeRenderQueue();
    const events: number[] = [];
    let finishFirst: (() => void) | null = null;

    queue.enqueue(async () => {
      events.push(1);
      await new Promise<void>((resolve) => { finishFirst = resolve; });
    }, PDF_RENDER_PRIORITY.current);
    queue.enqueue(async () => {
      events.push(2);
    }, PDF_RENDER_PRIORITY.current);

    expect(events).toEqual([1]);
    runPending(finishFirst);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([1, 2]);
  });

  it("returns canvas priority to a promoted displaced page", () => {
    const queue = new PdfCooperativeRenderQueue();
    const events: string[] = [];
    let yieldFirst: (() => void) | null = null;
    let yieldSecond: (() => void) | null = null;

    const first = queue.enqueue(async (onContinue) => {
      yieldFirst = () => onContinue(() => events.push("first:continue"));
      await new Promise<void>(() => undefined);
    }, PDF_RENDER_PRIORITY.current);
    first.setPriority(PDF_RENDER_PRIORITY.nearby);
    const second = queue.enqueue(async (onContinue) => {
      yieldSecond = () => onContinue(() => events.push("second:continue"));
      await new Promise<void>(() => undefined);
    }, PDF_RENDER_PRIORITY.current);

    second.setPriority(PDF_RENDER_PRIORITY.nearby);
    first.setPriority(PDF_RENDER_PRIORITY.current);
    runPending(yieldSecond);
    runPending(yieldFirst);
    expect(events).toEqual(["first:continue"]);

    first();
    second();
  });

  it("drops cancelled paused canvas work without blocking later pages", async () => {
    const queue = new PdfCooperativeRenderQueue();
    const events: string[] = [];
    let yieldBackground: (() => void) | null = null;
    let finishBackground: (() => void) | null = null;
    let finishCurrent: (() => void) | null = null;

    const cancelBackground = queue.enqueue(async (onContinue) => {
      events.push("background:start");
      yieldBackground = () => onContinue(() => events.push("background:resume"));
      await new Promise<void>((resolve) => { finishBackground = resolve; });
    }, PDF_RENDER_PRIORITY.cached);
    queue.enqueue(async () => {
      events.push("current:start");
      await new Promise<void>((resolve) => { finishCurrent = resolve; });
    }, PDF_RENDER_PRIORITY.current);

    runPending(yieldBackground);
    cancelBackground();
    runPending(finishBackground);
    runPending(finishCurrent);
    await Promise.resolve();
    await Promise.resolve();

    queue.enqueue(async () => {
      events.push("next:start");
    }, PDF_RENDER_PRIORITY.current);
    await Promise.resolve();
    expect(events).toEqual(["background:start", "current:start", "next:start"]);
  });

  it("normalizes PDF text-layer selections for agent context", () => {
    expect(normalizePdfSelection("  Attention\u00a0is\nall   you need.  ")).toBe("Attention is all you need.");
    expect(normalizePdfSelection("\n\t")).toBe("");
  });

  it("finds every case-insensitive occurrence across pages", () => {
    expect(findPdfMatches(
      ["Attention is all you need. Attention scales.", "No match.", "attention again"],
      "ATTENTION",
    )).toEqual([
      { page: 1, occurrence: 0 },
      { page: 1, occurrence: 1 },
      { page: 3, occurrence: 0 },
    ]);
    expect(findPdfMatches(["text"], "   ")).toEqual([]);
  });

  it("normalizes and scales annotation rectangles", () => {
    expect(annotationBounds([30, 50, 10, 20], 2)).toEqual({
      left: 20,
      top: 40,
      width: 40,
      height: 60,
    });
    expect(annotationBounds([0, 0, Number.NaN, 10], 1)).toBeNull();
  });

  it("supersamples PDF pages on low-DPI displays without over-scaling", () => {
    expect(pdfRenderPixelRatio(1)).toBe(2);
    expect(pdfRenderPixelRatio(1.5)).toBe(2);
    expect(pdfRenderPixelRatio(2)).toBe(2);
    expect(pdfRenderPixelRatio(3)).toBe(2.5);
    expect(PDF_MAX_CANVAS_PIXELS).toBe(2 ** 24);
    expect(pdfRenderPixelRatio(2, { width: 6_000, height: 6_000 }))
      .toBeCloseTo(Math.sqrt((2 ** 24) / 36_000_000));
  });

  it("bounds rendered PDF pages while retaining every page near the viewport", () => {
    const nearby = new Set([10, 11]);
    expect(updatePdfRenderCache(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      nearby,
      11,
      true,
    )).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(updatePdfRenderCache([8, 9, 10, 11], nearby, 10, true))
      .toEqual([8, 9, 11, 10]);
    expect(updatePdfRenderCache([8, 9, 10, 11], new Set([8, 9, 10]), 11, false, 3))
      .toEqual([8, 9, 10]);
  });

  it("computes fit-to-width and fit-to-height scales", () => {
    expect(fitPdfScale("width", { width: 600, height: 800 }, { width: 648, height: 400 }, { x: 48, y: 40 }))
      .toBe(1);
    expect(fitPdfScale("height", { width: 600, height: 800 }, { width: 1248, height: 1240 }, { x: 48, y: 40 }))
      .toBe(1.5);
    expect(fitPdfScale("width", { width: 100, height: 100 }, { width: 1000, height: 1000 }))
      .toBe(5);
    expect(fitPdfScale("height", { width: 600, height: 800 }, { width: 200, height: 200 }))
      .toBe(0.3);
  });

  it("accepts directly entered zoom percentages and bounds them", () => {
    expect(parsePdfZoomPercent("46")).toBe(0.46);
    expect(parsePdfZoomPercent(" 193% ")).toBe(1.93);
    expect(parsePdfZoomPercent("5")).toBe(0.3);
    expect(parsePdfZoomPercent("900")).toBe(5);
    expect(parsePdfZoomPercent("nope")).toBeNull();
  });
});
