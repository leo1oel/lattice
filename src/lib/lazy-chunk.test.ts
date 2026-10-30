import { describe, expect, it, vi } from "vitest";
import { chunk } from "./lazy-chunk";

describe("chunk", () => {
  it("imports once for every caller", async () => {
    const load = vi.fn(() => Promise.resolve({ value: 1 }));
    const source = chunk(load);
    expect(source.loaded()).toBeUndefined();
    const [first, second] = await Promise.all([source(), source()]);
    expect(first).toBe(second);
    expect(source.loaded()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  // A prewarm, the PDF panel's ChunkGate and its lazy component each ask for
  // the PDF viewer's chunk. When the first import's module evaluation threw,
  // asking again gave WebKit's module map a second import of a half-evaluated
  // graph, which failed on an uninitialized binding instead (#506).
  it("hands every later caller the first failure instead of importing again", async () => {
    const evaluationError = new ReferenceError("Can't find variable: Iterator");
    const load = vi.fn()
      .mockRejectedValueOnce(evaluationError)
      .mockRejectedValue(new ReferenceError("Cannot access uninitialized variable."));
    const source = chunk(load);
    await expect(source()).rejects.toBe(evaluationError);
    await expect(source()).rejects.toBe(evaluationError);
    expect(load).toHaveBeenCalledTimes(1);
    expect(source.loaded()).toBeUndefined();
  });
});
