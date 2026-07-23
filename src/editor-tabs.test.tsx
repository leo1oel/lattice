import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./editor-tabs";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom gives every element a zero-size rect, so lay the tabs out by hand:
// 100px-wide tabs at x = 0, 100, 200, keyed off their data-tab-path.
function mockTabLayout(lefts: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const path = this.getAttribute("data-tab-path");
    const left = path ? lefts[path] ?? 0 : 0;
    return { left, right: left + 100, width: 100, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe("EditorTabs", () => {
  it("selects a tab on click", () => {
    const onSelect = vi.fn();
    render(
      <EditorTabs
        tabs={[
          { path: "main.tex" },
          { path: "sections/intro.tex" },
        ]}
        activePath="main.tex"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /intro\.tex/i }));
    expect(onSelect).toHaveBeenCalledWith("sections/intro.tex");
  });

  it("closes from the context menu", () => {
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={[
          { path: "main.tex" },
          { path: "sections/intro.tex" },
        ]}
        activePath="main.tex"
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />,
    );
    const introTab = screen.getByRole("tab", { name: /intro\.tex/i }).closest(".editor-tab");
    fireEvent.contextMenu(introTab as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledWith("sections/intro.tex");
  });

  it("drags a back tab to the front", () => {
    const onReorder = vi.fn();
    mockTabLayout({ "a.tex": 0, "b.tex": 100, "c.tex": 200 });
    render(
      <EditorTabs
        tabs={[{ path: "a.tex" }, { path: "b.tex" }, { path: "c.tex" }]}
        activePath="a.tex"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />,
    );
    const cTab = screen.getByRole("tab", { name: /c\.tex/i }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(cTab, { button: 0, clientX: 250 });
    fireEvent.pointerMove(window, { clientX: 10 });
    fireEvent.pointerUp(window, { clientX: 10 });
    expect(onReorder).toHaveBeenLastCalledWith(["c.tex", "a.tex", "b.tex"]);
  });

  it("does not reorder or select on a plain click (no drag)", () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    mockTabLayout({ "a.tex": 0, "b.tex": 100 });
    render(
      <EditorTabs
        tabs={[{ path: "a.tex" }, { path: "b.tex" }]}
        activePath="a.tex"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={onReorder}
      />,
    );
    const bTab = screen.getByRole("tab", { name: /b\.tex/i }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(bTab, { button: 0, clientX: 150 });
    fireEvent.pointerUp(window, { clientX: 150 });
    fireEvent.click(screen.getByRole("tab", { name: /b\.tex/i }));
    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b.tex");
  });
});
