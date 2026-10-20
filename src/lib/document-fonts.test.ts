import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  document.documentElement.removeAttribute("style");
  Reflect.deleteProperty(document, "fonts");
});

/** A FontFaceSet whose loads finish when `settle` is called, recording what was asked for. */
function fakeFonts() {
  const requested: string[] = [];
  let settle = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: (font: string) => { requested.push(font); return settled.then(() => []); } },
  });
  return { requested, settle };
}

describe("document fonts", () => {
  it("loads every cut of the first family each document face names, once", async () => {
    document.documentElement.style.setProperty("--editor-font", "\"Ioskeley Mono\", Menlo, monospace");
    document.documentElement.style.setProperty("--reading-font", "\"Timeless Serif Text\", \"Inter Variable\", sans-serif");
    const { requested, settle } = fakeFonts();
    const { documentFontsReady } = await import("./document-fonts");
    const ready = documentFontsReady();
    void documentFontsReady();
    settle();
    await ready;
    expect(requested).toContain("italic 400 16px \"Ioskeley Mono\"");
    expect(requested).toContain("600 16px \"Timeless Serif Text\"");
    expect(requested.filter((font) => font.includes("Inter") || font.includes("Menlo"))).toEqual([]);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it("stops waiting for a face that never arrives", async () => {
    document.documentElement.style.setProperty("--editor-font", "\"Ioskeley Mono\"");
    fakeFonts();
    vi.useFakeTimers();
    const { documentFontsReady } = await import("./document-fonts");
    let done = false;
    void documentFontsReady().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
