import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { EditorDropPreviewPortal, EditorTabs, editorDropPreviewAt } from "./editor-tabs";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type TabsProps = ComponentProps<typeof EditorTabs>;

function tabsProps(overrides: Partial<TabsProps> = {}): TabsProps {
  return {
    tabs: [{ path: "main.tex" }, { path: "sections/intro.tex" }],
    activePath: "main.tex",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
}

function renderTabs(overrides: Partial<TabsProps> = {}) {
  const props = tabsProps(overrides);
  return { ...render(<EditorTabs {...props} />), props };
}

/** Tabs with a `.canvas-body` drop surface at x 200–1000, y 40–640. */
function renderTabsOverCanvas(overrides: Partial<TabsProps> = {}) {
  const props = tabsProps(overrides);
  const view = render(<><EditorTabs {...props} /><div className="canvas-body" /></>);
  mockRect(view.container.querySelector<HTMLElement>(".canvas-body")!, { left: 200, top: 40, width: 800, height: 600 });
  return {
    ...view,
    props,
    rerenderTabs: (next: Partial<TabsProps>) => view.rerender(<><EditorTabs {...tabsProps(next)} /><div className="canvas-body" /></>),
  };
}

function mockRect(element: HTMLElement, { left, top, width, height }: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
  } as DOMRect);
}

// jsdom gives every element a zero-size rect, so lay the tabs out by hand:
// 100px-wide tabs at x = 0, 100, 200, keyed off their data-tab-path.
function mockTabLayout(lefts: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const path = this.getAttribute("data-tab-path");
    const left = path ? lefts[path] ?? 0 : 0;
    return { left, right: left + 100, width: 100, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

const tab = (name: RegExp | string) => screen.getByRole("tab", { name }).closest<HTMLElement>(".editor-tab")!;
const dropPreview = () => document.querySelector(".editor-tab-split-drop-preview");

describe("EditorTabs", () => {
  it("exposes distinct paths for same-name tabs on focus", async () => {
    renderTabs({
      tabs: [{ path: "chapters/intro.tex" }, { path: "appendices/intro.tex", label: "intro.tex" }],
      activePath: "chapters/intro.tex",
    });
    const tabs = screen.getAllByRole("tab", { name: "intro.tex" });
    fireEvent.focus(tabs[0]);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("chapters/intro.tex");
    fireEvent.blur(tabs[0]);
    fireEvent.focus(tabs[1]);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("appendices/intro.tex");
    expect(tabs[1]).not.toHaveAttribute("title");
  });

  it("renders the active filename when only one tab is open", () => {
    renderTabs({ tabs: [{ path: "main.tex", dirty: true }] });
    expect(screen.getByRole("tab", { name: /main\.tex/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close main.tex" })).not.toBeInTheDocument();
  });

  it("keeps the tab strip mounted when the PDF has no open tabs", () => {
    const { container } = renderTabs({ tabs: [], activePath: "", canCloseLast: true });
    expect(container.querySelector(".editor-tabs")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Open files" })
      .querySelector(".editor-tabs-content")).toBeEmptyDOMElement();
  });

  it("uses the shared horizontal scroll area and maps a plain wheel vertically", () => {
    const { container } = renderTabs();
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
    const { props } = renderTabs({ tabs: [{ path: "main.tex" }], canCloseLast: true });
    fireEvent.click(screen.getByRole("button", { name: "Close main.tex" }));
    expect(props.onClose).toHaveBeenCalledWith("main.tex");
  });

  it("selects a tab on click", () => {
    const { props } = renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: /intro\.tex/i }));
    expect(props.onSelect).toHaveBeenCalledWith("sections/intro.tex");
  });

  it("closes without selecting or starting a drag", () => {
    const { props } = renderTabs();
    const close = screen.getByRole("button", { name: "Close intro.tex" });
    expect(close).toHaveClass("editor-tab-close");
    fireEvent.pointerDown(close, { button: 0, clientX: 150 });
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledWith("sections/intro.tex");
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass("reordering-tabs");
  });

  it("localizes tab actions and the close tooltip in Chinese", async () => {
    await activateAppLocale("zh-CN");
    renderTabs({ tabs: [{ path: "sections/intro.tex" }], activePath: "sections/intro.tex", canCloseLast: true });
    fireEvent.contextMenu(tab("intro.tex"));
    expect(await screen.findByRole("menuitem", { name: "打开" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "关闭" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "固定标签页" })).toBeInTheDocument();
    expect(screen.getByTitle("关闭 intro.tex")).toHaveAttribute("aria-label", "关闭 intro.tex");
  });

  it("closes from the context menu", async () => {
    const { props } = renderTabs();
    fireEvent.contextMenu(tab(/intro\.tex/i));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^close$/i }));
    expect(props.onClose).toHaveBeenCalledWith("sections/intro.tex");
  });

  it("pins and unpins from the context menu and protects pinned tabs from closing", async () => {
    const onClose = vi.fn();
    const onSetPinned = vi.fn();
    const { rerender } = renderTabs({
      tabs: [{ path: "main.tex", pinned: true }, { path: "notes.tex" }],
      onClose,
      onSetPinned,
    });
    const mainTab = tab(/main\.tex/i);
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close main.tex" })).toBeNull();
    fireEvent(mainTab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.contextMenu(mainTab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin tab" }));
    expect(onSetPinned).toHaveBeenCalledWith("main.tex", false);

    rerender(<EditorTabs {...tabsProps({ tabs: [{ path: "main.tex" }, { path: "notes.tex" }], onClose, onSetPinned })} />);
    fireEvent.contextMenu(tab(/main\.tex/i));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin tab" }));
    expect(onSetPinned).toHaveBeenLastCalledWith("main.tex", true);
  });

  it.each([
    {
      name: "drags a back tab to the front",
      tabs: [{ path: "a.tex" }, { path: "b.tex" }, { path: "c.tex" }],
      drag: "c.tex",
      expected: ["c.tex", "a.tex", "b.tex"],
    },
    {
      name: "keeps pinned and ordinary tabs in separate drag partitions",
      tabs: [{ path: "pinned.tex", pinned: true }, { path: "a.tex" }, { path: "b.tex" }],
      drag: "b.tex",
      expected: ["pinned.tex", "b.tex", "a.tex"],
    },
  ])("$name", ({ tabs, drag, expected }) => {
    mockTabLayout(Object.fromEntries(tabs.map((item, index) => [item.path, index * 100])));
    const { props } = renderTabs({ tabs, activePath: "a.tex" });
    fireEvent.pointerDown(tab(new RegExp(drag.replace(".", "\\."))), { button: 0, clientX: 250 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window, { clientX: 0 });
    expect(props.onReorder).toHaveBeenLastCalledWith(expected);
  });

  it("reports the selected left, center, or right drop zone", () => {
    const { props } = renderTabsOverCanvas({ onDropTab: vi.fn() });
    fireEvent.pointerDown(tab(/intro\.tex/i), { button: 0, clientX: 150, clientY: 16 });
    for (const [clientX, zone] of [[250, "left"], [600, "center"], [850, "right"]] as const) {
      fireEvent.pointerMove(window, { clientX, clientY: 300 });
      expect(dropPreview()).toHaveAttribute("data-drop-zone", zone);
      expect(document.querySelector(".editor-tab-split-drop-target")).toHaveAttribute("data-drop-target", zone);
    }
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });
    expect(props.onDropTab).toHaveBeenCalledWith("sections/intro.tex", "right");
    expect(dropPreview()).toBeNull();
  });

  it("localizes every split drop target", async () => {
    await activateAppLocale("zh-CN");
    const preview = { path: "main.tex", left: 0, top: 0, width: 900, height: 600, dividerLeft: null, dividerRight: null };
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
    mockRect(container.querySelector<HTMLElement>(".canvas-body")!, { left: 200, top: 40, width: 800, height: 600 });
    mockRect(container.querySelector<HTMLElement>(".split-resizer")!, { left: 720, top: 40, width: 1, height: 600 });

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
    const { props } = renderTabsOverCanvas({ onDropTab: vi.fn() });
    fireEvent.pointerDown(tab(/main\.tex/i), { button: 0, clientX: 50, clientY: 16 });
    fireEvent.pointerMove(window, { clientX: 850, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 850, clientY: 300 });
    expect(props.onDropTab).toHaveBeenCalledWith("main.tex", "right");
    expect(dropPreview()).toBeNull();
  });

  it("cancels a pending drop when the layout stops accepting file drops", () => {
    const onDropTab = vi.fn();
    const { rerenderTabs } = renderTabsOverCanvas({ onDropTab });
    fireEvent.pointerDown(tab(/intro\.tex/i), { button: 0, pointerId: 7, clientX: 150, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 850, clientY: 300 });
    expect(dropPreview()).not.toBeNull();

    rerenderTabs({});
    expect(dropPreview()).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 850, clientY: 300 });
    expect(onDropTab).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass("reordering-tabs");
  });

  it("does not reorder or select on a plain click (no drag)", () => {
    mockTabLayout({ "a.tex": 0, "b.tex": 100 });
    const { props } = renderTabs({ tabs: [{ path: "a.tex" }, { path: "b.tex" }], activePath: "a.tex" });
    fireEvent.pointerDown(tab(/b\.tex/i), { button: 0, clientX: 150 });
    fireEvent.pointerUp(window, { clientX: 150 });
    fireEvent.click(screen.getByRole("tab", { name: /b\.tex/i }));
    expect(props.onReorder).not.toHaveBeenCalled();
    expect(props.onSelect).toHaveBeenCalledWith("b.tex");
  });
});
