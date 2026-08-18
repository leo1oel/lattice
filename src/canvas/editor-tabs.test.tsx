import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { EditorDropPreviewPortal, EditorTabs, editorDropPreviewAt } from "./editor-tabs";

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
  it("renders the active filename when only one tab is open", () => {
    render(
      <EditorTabs
        tabs={[{ path: "main.tex", dirty: true }]}
        activePath="main.tex"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: /main\.tex/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close main.tex" })).not.toBeInTheDocument();
  });

  it("keeps the tab strip mounted when the PDF has no open tabs", () => {
    const { container } = render(
      <EditorTabs
        tabs={[]}
        activePath=""
        canCloseLast
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(container.querySelector(".editor-tabs")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Open files" })
      .querySelector(".editor-tabs-content")).toBeEmptyDOMElement();
  });

  it("uses the shared horizontal scroll area and maps a plain wheel vertically", () => {
    const { container } = render(
      <EditorTabs
        tabs={[{ path: "a.tex" }, { path: "b.tex" }]}
        activePath="a.tex"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    const root = container.querySelector(".editor-tabs-scroll");
    const viewport = screen.getByRole("tablist", { name: "Open files" });
    expect(root).toHaveAttribute("data-slot", "scroll-area");
    expect(viewport).toHaveAttribute("data-slot", "scroll-area-viewport");
    expect(viewport.querySelector(".editor-tabs-content")).toBeInTheDocument();
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.wheel(viewport, { deltaX: 0, deltaY: 64 });
    expect(viewport.scrollLeft).toBe(64);
  });

  it("allows PDF mode to close its last tab", () => {
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={[{ path: "main.tex" }]}
        activePath="main.tex"
        canCloseLast
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close main.tex" }));
    expect(onClose).toHaveBeenCalledWith("main.tex");
  });

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

  it("closes without selecting or starting a drag", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={[{ path: "main.tex" }, { path: "sections/intro.tex" }]}
        activePath="main.tex"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={vi.fn()}
      />,
    );
    const close = screen.getByRole("button", { name: "Close intro.tex" });
    expect(close).toHaveClass("editor-tab-close");
    fireEvent.pointerDown(close, { button: 0, clientX: 150 });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith("sections/intro.tex");
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass("reordering-tabs");
  });

  it("closes from the context menu", async () => {
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
    fireEvent.click(await screen.findByRole("menuitem", { name: /^close$/i }));
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

  it("reports the selected left, center, or right drop zone", () => {
    const onDropTab = vi.fn();
    const { container } = render(
      <>
        <EditorTabs
          tabs={[{ path: "main.tex" }, { path: "sections/intro.tex" }]}
          activePath="main.tex"
          onDropTab={onDropTab}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
        <div className="canvas-body" />
      </>,
    );
    const canvas = container.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    const introTab = screen.getByRole("tab", { name: /intro\.tex/i }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(introTab, { button: 0, clientX: 150, clientY: 16 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 300 });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "left");
    expect(document.querySelector(".editor-tab-split-drop-target"))
      .toHaveAttribute("data-drop-target", "left");
    fireEvent.pointerMove(window, { clientX: 600, clientY: 300 });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "center");
    expect(document.querySelector(".editor-tab-split-drop-target"))
      .toHaveAttribute("data-drop-target", "center");
    fireEvent.pointerMove(window, { clientX: 850, clientY: 300 });
    expect(document.querySelector(".editor-tab-split-drop-preview"))
      .toHaveAttribute("data-drop-zone", "right");
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });
    expect(onDropTab).toHaveBeenCalledWith("sections/intro.tex", "right");
    expect(document.querySelector(".editor-tab-split-drop-preview")).toBeNull();
  });

  it("localizes every split drop target", async () => {
    await activateAppLocale("zh-CN");
    const preview = {
      path: "main.tex",
      left: 0,
      top: 0,
      width: 900,
      height: 600,
      dividerLeft: null,
      dividerRight: null,
    };
    render(
      <>
        <EditorDropPreviewPortal preview={{ ...preview, zone: "left" }} />
        <EditorDropPreviewPortal preview={{ ...preview, zone: "center" }} />
        <EditorDropPreviewPortal preview={{ ...preview, zone: "right" }} />
      </>,
    );

    expect(screen.getByText("在左侧打开")).toBeInTheDocument();
    expect(screen.getByText("在此打开")).toBeInTheDocument();
    expect(screen.getByText("在右侧打开")).toBeInTheDocument();
  });

  it("uses the live split divider for full-bleed left and right targets", () => {
    const { container } = render(
      <div className="canvas-body">
        <div className="split-canvas">
          <div />
          <div className="split-resizer" />
          <div />
        </div>
      </div>,
    );
    const canvas = container.querySelector<HTMLElement>(".canvas-body")!;
    const divider = container.querySelector<HTMLElement>(".split-resizer")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({
      left: 720,
      right: 721,
      width: 1,
      top: 40,
      bottom: 640,
      height: 600,
      x: 720,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);

    expect(editorDropPreviewAt("main.tex", 250, 300)).toMatchObject({
      zone: "left",
      dividerLeft: 520,
      dividerRight: 521,
      width: 800,
      height: 600,
    });
    expect(editorDropPreviewAt("main.tex", 900, 300)).toMatchObject({
      zone: "right",
      dividerLeft: 520,
      dividerRight: 521,
    });
  });

  it("reports active-tab drops so the owner can move or replace panes safely", () => {
    const onDropTab = vi.fn();
    const { container } = render(
      <>
        <EditorTabs
          tabs={[{ path: "main.tex" }, { path: "sections/intro.tex" }]}
          activePath="main.tex"
          onDropTab={onDropTab}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
        <div className="canvas-body" />
      </>,
    );
    const canvas = container.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    const mainTab = screen.getByRole("tab", { name: /main\.tex/i }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(mainTab, { button: 0, clientX: 50, clientY: 16 });
    fireEvent.pointerMove(window, { clientX: 850, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });
    expect(onDropTab).toHaveBeenCalledWith("main.tex", "right");
    expect(document.querySelector(".editor-tab-split-drop-preview")).toBeNull();
  });

  it("cancels a pending drop when the layout stops accepting file drops", () => {
    const onDropTab = vi.fn();
    const commonProps = {
      tabs: [{ path: "main.tex" }, { path: "sections/intro.tex" }],
      activePath: "main.tex",
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onReorder: vi.fn(),
    };
    const { container, rerender } = render(
      <>
        <EditorTabs
          {...commonProps}
          onDropTab={onDropTab}
        />
        <div className="canvas-body" />
      </>,
    );
    const canvas = container.querySelector<HTMLElement>(".canvas-body")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 1000,
      width: 800,
      top: 40,
      bottom: 640,
      height: 600,
      x: 200,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect);
    const introTab = screen.getByRole("tab", { name: /intro\.tex/i }).closest(".editor-tab") as HTMLElement;
    fireEvent.pointerDown(introTab, { button: 0, pointerId: 7, clientX: 150, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 850, clientY: 300 });
    expect(document.querySelector(".editor-tab-split-drop-preview")).not.toBeNull();

    rerender(
      <>
        <EditorTabs {...commonProps} />
        <div className="canvas-body" />
      </>,
    );
    expect(document.querySelector(".editor-tab-split-drop-preview")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 850, clientY: 300 });
    expect(onDropTab).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass("reordering-tabs");
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
