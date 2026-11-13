import { describe, expect, it } from "vitest";
import { inlineText, renderInline } from "./visual-inline";

const holder = (source: string, macros?: Record<string, string>) => {
  const span = document.createElement("span");
  span.append(renderInline(source, { macros }));
  return span;
};

describe("renderInline", () => {
  // TeX: arguments end where their braces do, and a control word swallows the blanks after it.
  it("expands a macro without adding or keeping space TeX would not print", () => {
    const macros = { "\\aff": "\\textsuperscript{#1}", "\\leadmark": "\\textsuperscript{*}", "\\mark": "\\textdagger" };
    expect(inlineText("\\aff{1}University of Washington", { macros })).toBe("1University of Washington");
    expect(inlineText("\\leadmark Project lead", { macros })).toBe("*Project lead");
    expect(inlineText("\\mark Equal", { macros })).toBe("†Equal");
    expect(inlineText("A \\aff{2} B", { macros })).toBe("A 2 B");
  });

  // `\small` is an absolute size: repeating it, or switching to another, never compounds.
  it("sets each size switch at its own size, keeping the other switches in force", () => {
    const dom = holder("\\bfseries\\small one \\\\ \\normalfont\\small two \\\\ \\small three \\large four");
    const sizes = [...dom.querySelectorAll("[class^='lx-tex-size-']")];
    expect(sizes.map((span) => span.className)).toEqual(["lx-tex-size-small", "lx-tex-size-small", "lx-tex-size-small", "lx-tex-size-large"]);
    for (const span of sizes) expect(span.parentElement?.closest("[class^='lx-tex-size-']")).toBeNull();
    const four = sizes[3];
    expect(four.textContent?.trim()).toBe("four");
    expect(four.querySelector(".lx-tex-normalfont")).not.toBeNull();
    expect(four.closest(".lx-tex-bold")).not.toBeNull();
  });
});
