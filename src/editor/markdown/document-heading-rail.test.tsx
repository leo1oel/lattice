import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentHeadingRail, type DocumentHeadingItem } from "./document-heading-rail";

/** Where each heading sits in the document, in pixels from its top: a short Introduction, then long sections. */
const SECTIONS = [
  { id: "introduction", label: "Introduction", top: 100 },
  { id: "method", label: "Method", top: 300 },
  { id: "results", label: "Results", top: 1500 },
  { id: "discussion", label: "Discussion", top: 3000 },
  { id: "appendix", label: "Appendix", top: 4700 },
];
const VIEWPORT = 800;
const DOCUMENT = 5000;

/**
 * The rail over a document laid out as SECTIONS in a scroller VIEWPORT tall,
 * which jsdom cannot lay out itself. `onSelect` scrolls like a jump: the
 * heading to the middle, as far as the scroller goes.
 */
function renderRail() {
  let scrollTop = 0;
  let width = 900;
  const items: DocumentHeadingItem[] = SECTIONS.map(({ id, label, top }) => ({ id, label, level: 2, position: top / DOCUMENT }));
  const scrollTo = (top: number) => {
    scrollTop = Math.max(0, Math.min(DOCUMENT - VIEWPORT, top));
  };
  const onSelect = vi.fn((item: DocumentHeadingItem) => {
    scrollTo(SECTIONS.find((section) => section.id === item.id)!.top - VIEWPORT / 2);
  });
  // Laid out before the rail mounts, which measures as it does.
  const isScroller = (element: HTMLElement) => element.classList.contains("editor-doc-scroll");
  const zero = new DOMRect();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (isScroller(this)) return new DOMRect(0, 0, 900, VIEWPORT);
    const heading = SECTIONS.find((section) => section.id === this.id);
    return heading ? new DOMRect(0, heading.top - scrollTop, 600, 30) : zero;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? scrollTop : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? VIEWPORT : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? DOCUMENT : 0;
  });
  // The scroll area's scrollbar sits beside its viewport, not inside it.
  const view = render(
    <div data-slot="scroll-area">
      <div className="editor-doc-scroll">
        <div className="lx-md-editor">
          <DocumentHeadingRail items={items} onSelect={onSelect} />
          <div className="ProseMirror" contentEditable suppressContentEditableWarning>
            {SECTIONS.map(({ id, label }) => <h2 key={id} id={id}>{label}</h2>)}
          </div>
        </div>
      </div>
      <div data-slot="scroll-area-scrollbar" />
    </div>,
  );
  const scroller = view.container.querySelector<HTMLElement>(".editor-doc-scroll")!;
  return {
    onSelect,
    scroller,
    scrollbar: view.container.querySelector<HTMLElement>("[data-slot='scroll-area-scrollbar']")!,
    /** The preview lays out at `next` pixels wide, and the rail measures it. */
    resize: async (next: number) => {
      width = next;
      // The async act lets the rail's mutation observer schedule its measuring
      // frame before the wait below asks for one, so the measure lands first.
      await act(async () => scroller.querySelector(".ProseMirror")!.append(""));
      await nextFrame();
    },
    /** The writer scrolls the document to `top`. */
    scroll: (top: number) => {
      scrollTo(top);
      fireEvent.scroll(scroller);
    },
  };
}

const rail = () => screen.getByRole("navigation", { name: "Document sections" });
const section = (name: string) => within(rail()).getByRole("button", { name });
/** The one section the rail announces as current, and the one it lets Tab reach. */
const current = () => ({
  location: within(rail()).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "location").map((button) => button.getAttribute("aria-label")),
  tabStop: within(rail()).getAllByRole("button").filter((button) => button.tabIndex === 0).map((button) => button.getAttribute("aria-label")),
});
const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DocumentHeadingRail's current section", () => {
  it("is the section in the middle of the viewport, where every jump centers its target", async () => {
    const { scroll } = renderRail();
    // A target centered in Results (a TODO, a comment) makes Results current.
    scroll(1700 - VIEWPORT / 2);
    await waitFor(() => expect(current()).toEqual({ location: ["Results"], tabStop: ["Results"] }));
    scroll(3200 - VIEWPORT / 2);
    expect(current()).toEqual({ location: ["Discussion"], tabStop: ["Discussion"] });
  });

  it.each([
    // The scroller cannot center the last heading: the middle stays in Discussion.
    { name: "Appendix", from: 0, back: { to: 1200, current: "Results" } },
    // Nor the short first section's: the middle is already in Method.
    { name: "Introduction", from: 2000, back: { to: 1200, current: "Results" } },
  ])("is $name once the writer jumps there, where it cannot be centered, until reading moves on", async ({ name, from, back }) => {
    const { onSelect, scroll } = renderRail();
    scroll(from);
    await nextFrame();
    fireEvent.click(section(name));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: name }));
    expect(current()).toEqual({ location: [name], tabStop: [name] });
    // The jump's own scroll, and the measuring after it, keep the landing.
    fireEvent.scroll(screen.getByRole("navigation").closest(".editor-doc-scroll")!);
    await nextFrame();
    await nextFrame();
    expect(current()).toEqual({ location: [name], tabStop: [name] });
    // Scrolling to another section hands the rail back to reading.
    scroll(back.to);
    expect(current()).toEqual({ location: [back.current], tabStop: [back.current] });
  });

  it.each([
    { input: "the wheel", start: (scroller: HTMLElement) => fireEvent.wheel(scroller, { deltaY: 250 }) },
    { input: "a touch", start: (scroller: HTMLElement) => fireEvent.touchMove(scroller) },
    { input: "the keyboard", start: (scroller: HTMLElement) => fireEvent.keyDown(scroller, { key: "PageDown" }) },
    { input: "the scrollbar", start: (_scroller: HTMLElement, scrollbar: HTMLElement) => fireEvent.pointerDown(scrollbar) },
  ])("hands back to reading once the writer scrolls with $input, even within the section reading settled in", async ({ start }) => {
    const { scroll, scroller, scrollbar } = renderRail();
    scroll(2000);
    await nextFrame();
    // Introduction cannot be centered: the jump settles at the top, reading in Method.
    fireEvent.click(section("Introduction"));
    await nextFrame();
    expect(current()).toEqual({ location: ["Introduction"], tabStop: ["Introduction"] });
    // The writer scrolls Introduction out of view, still reading in Method.
    start(scroller, scrollbar);
    scroll(250);
    expect(current()).toEqual({ location: ["Method"], tabStop: ["Method"] });
  });

  it.each([
    { input: "the wheel", start: (button: HTMLElement) => fireEvent.wheel(button, { deltaY: 250 }) },
    { input: "a touch", start: (button: HTMLElement) => fireEvent.touchMove(button) },
    { input: "Page Down", start: (button: HTMLElement) => fireEvent.keyDown(button, { key: "PageDown" }) },
  ])("hands back to reading once the writer scrolls with $input over the rail", async ({ start }) => {
    const { scroll } = renderRail();
    scroll(2000);
    await nextFrame();
    fireEvent.click(section("Introduction"));
    await nextFrame();
    start(section("Introduction"));
    scroll(250);
    expect(current()).toEqual({ location: ["Method"], tabStop: ["Method"] });
  });

  it.each([
    { key: "ArrowDown", focused: "Method" },
    { key: "End", focused: "Appendix" },
    { key: " ", focused: "Introduction" },
  ])("keeps the jump's section while $key moves through the rail, also after it hides and returns", async ({ key, focused }) => {
    const { scroll, resize } = renderRail();
    scroll(2000);
    await nextFrame();
    // The viewport narrows past the rail and widens again.
    await resize(300);
    expect(screen.queryByRole("navigation")).toBeNull();
    await resize(900);
    fireEvent.click(section("Introduction"));
    await nextFrame();
    act(() => section("Introduction").focus());
    fireEvent.keyDown(section("Introduction"), { key });
    expect(section(focused)).toHaveFocus();
    expect(current()).toEqual({ location: ["Introduction"], tabStop: ["Introduction"] });
  });

  it.each([
    { input: "a click in its text", act: (heading: HTMLElement) => fireEvent.pointerDown(heading) },
    { input: "typing in its text", act: (heading: HTMLElement) => fireEvent.keyDown(heading, { key: "a" }) },
    { input: "a caret move in its text", act: (heading: HTMLElement) => fireEvent.keyDown(heading, { key: "ArrowDown" }) },
    { input: "a tap in its text", act: (heading: HTMLElement) => fireEvent.touchStart(heading) },
  ])("keeps the jump's section through $input, which does not scroll", async ({ act: input }) => {
    const { scroll, scroller } = renderRail();
    scroll(2000);
    await nextFrame();
    fireEvent.click(section("Introduction"));
    await nextFrame();
    input(scroller.querySelector<HTMLElement>("#introduction")!);
    expect(current()).toEqual({ location: ["Introduction"], tabStop: ["Introduction"] });
  });

  it("follows a jump activated from the keyboard", async () => {
    const { onSelect } = renderRail();
    await nextFrame();
    act(() => section("Method").focus());
    fireEvent.keyDown(section("Method"), { key: "End" });
    expect(section("Appendix")).toHaveFocus();
    fireEvent.click(section("Appendix"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ label: "Appendix" }));
    await nextFrame();
    expect(current()).toEqual({ location: ["Appendix"], tabStop: ["Appendix"] });
  });
});
