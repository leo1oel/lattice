import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const load = () => import("./latex-view-choice");

describe("the Source / Visual choice for .tex files", () => {
  it("starts as Source, and is remembered once Visual is chosen", async () => {
    const { latexView, chooseLatexView, LATEX_VIEW_KEY } = await load();
    expect(latexView()).toBe("source");
    chooseLatexView("visual");
    expect(latexView()).toBe("visual");
    expect(localStorage.getItem(LATEX_VIEW_KEY)).toBe("visual");
    vi.resetModules();
    expect((await load()).latexView()).toBe("visual");
  });

  it("is its own choice, whatever Markdown's views are, and ignores what it cannot read", async () => {
    localStorage.setItem("lattice.latex-view.v1", "pdf");
    localStorage.setItem("lattice.workspace-layout.v1", JSON.stringify({ "/p": { documentMode: "pdf" } }));
    expect((await load()).latexView()).toBe("source");
  });

  it("tells subscribers when it changes, and only then", async () => {
    const { chooseLatexView } = await load();
    const { renderHook, act } = await import("@testing-library/react");
    const { useLatexView } = await load();
    const renders: string[] = [];
    renderHook(() => renders.push(useLatexView()));
    act(() => chooseLatexView("source"));
    act(() => chooseLatexView("visual"));
    expect(renders).toEqual(["source", "visual"]);
  });

  it("knows a LaTeX document from packages, classes and other files", async () => {
    const { isLatexDocumentPath } = await load();
    expect(["main.tex", "ch/Intro.TEX"].map(isLatexDocumentPath)).toEqual([true, true]);
    expect(["style.sty", "class.cls", "notes.md", "tex"].map(isLatexDocumentPath)).toEqual([false, false, false, false]);
  });
});
