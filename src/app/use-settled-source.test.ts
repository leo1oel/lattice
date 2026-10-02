import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_SOURCE_CHARS, useSettledSource } from "./use-settled-source";

const long = (tail: string) => `${"x".repeat(LONG_SOURCE_CHARS)}${tail}`;
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** The hook's result past the long prefix, so a failure prints something readable. */
function renderSettled(key: string, source: string) {
  const hook = renderHook(({ key, source }) => useSettledSource(key, source), { initialProps: { key, source } });
  return { ...hook, settled: () => hook.result.current.replace(/^x+/, "") };
}

describe("useSettledSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows a short buffer on every edit", () => {
    const { settled, rerender } = renderSettled("main.tex", "a");
    rerender({ key: "main.tex", source: "ab" });
    expect(settled()).toBe("ab");
  });

  it("holds a long buffer's text until typing pauses", () => {
    const { settled, rerender } = renderSettled("long.tex", long("a"));
    rerender({ key: "long.tex", source: long("ab") });
    rerender({ key: "long.tex", source: long("abc") });
    expect(settled()).toBe("a");
    advance(499);
    expect(settled()).toBe("a");
    advance(1);
    expect(settled()).toBe("abc");
  });

  it("catches up during continuous typing", () => {
    const { settled, rerender } = renderSettled("long.tex", long(""));
    // A key every 100 ms from t = 0 to 4.9 s: no pause reaches the idle wait.
    for (let typed = 1; typed <= 50; typed += 1) {
      rerender({ key: "long.tex", source: long("a".repeat(typed)) });
      expect(settled()).toBe("");
      advance(100);
    }
    // Five seconds after the first unsettled edit, it catches up anyway.
    expect(settled()).toBe("a".repeat(50));
  });

  it("starts another document from its live text", () => {
    const { settled, rerender } = renderSettled("long.tex", long("a"));
    rerender({ key: "long.tex", source: long("ab") });
    rerender({ key: "other.tex", source: long("other") });
    expect(settled()).toBe("other");
    // Coming back reads the text it returns to, not the snapshot it left.
    rerender({ key: "long.tex", source: long("abc") });
    expect(settled()).toBe("abc");
  });

  it("reads a buffer that has just grown long live", () => {
    const { settled, rerender } = renderSettled("main.tex", "");
    rerender({ key: "main.tex", source: long("loaded") });
    expect(settled()).toBe("loaded");
    advance(500);
    rerender({ key: "main.tex", source: long("loaded!") });
    expect(settled()).toBe("loaded");
  });
});
