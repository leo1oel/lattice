import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectTreeHover } from "./project-tree-hover";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(32);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const scroller = document.createElement("div");
  scroller.innerHTML = `<div data-file-tree-virtualized-sticky="true">
    <button data-type="item" data-item-path="a.tex">A</button>
    <button data-type="item" data-item-path="b.tex" data-item-selected="true">B</button>
  </div>`;
  document.body.append(scroller);
  const view = render(<ProjectTreeHover getViewport={() => scroller} />);
  const first = scroller.querySelector("button")!;
  const selected = scroller.querySelectorAll("button")[1];
  const move = (element = first) => fireEvent(element, new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  return { scroller, first, selected, move, ...view };
}

it("keeps stationary hover, suspends through wheel and inertial scroll, then restores it on the recycled row", async () => {
  const { scroller, first, selected, move } = setup();
  move();
  expect(first).toHaveAttribute("data-fluid-hover-active");
  move(selected);
  expect(selected).not.toHaveAttribute("data-fluid-hover-active");
  move();
  fireEvent.wheel(scroller);
  expect(scroller).toHaveAttribute("data-tree-scrolling");
  expect(first).not.toHaveAttribute("data-fluid-hover-item");
  expect(scroller.querySelector('[data-slot="fluid-hover-highlight"]')).toBeNull();

  await act(async () => {
    vi.advanceTimersByTime(100);
    first.dataset.itemPath = "c.tex";
  });
  fireEvent.scroll(scroller);
  act(() => vi.advanceTimersByTime(100));
  move();
  expect(first).not.toHaveAttribute("data-fluid-hover-active");
  expect(scroller).toHaveAttribute("data-tree-scrolling");
  act(() => vi.advanceTimersByTime(50));
  expect(scroller).not.toHaveAttribute("data-tree-scrolling");
  expect(first).toHaveAttribute("data-fluid-hover-item");
  expect(first).not.toHaveAttribute("data-fluid-hover-active");
  move();
  expect(first).toHaveAttribute("data-fluid-hover-active");
  expect(selected).toHaveAttribute("data-item-selected", "true");
});

it("does not react to another scroller and cleans up an active scroll session", () => {
  const { scroller, first, move, unmount } = setup();
  move();
  fireEvent.scroll(document);
  expect(scroller).not.toHaveAttribute("data-tree-scrolling");
  fireEvent.scroll(scroller);
  expect(first).not.toHaveAttribute("data-fluid-hover-item");
  unmount();
  expect(scroller).not.toHaveAttribute("data-tree-scrolling");
  expect(first.parentElement).not.toHaveClass("fluid-hover-surface");
  act(() => vi.advanceTimersByTime(200));
  fireEvent.wheel(scroller);
  expect(scroller).not.toHaveAttribute("data-tree-scrolling");
});
