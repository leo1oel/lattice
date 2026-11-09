import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendVerticalScrollbar } from "./dom-scrollbar";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** A 100px viewport over `content` px of rows, inside its surface. */
function mount(content: number) {
  const surface = document.body.appendChild(document.createElement("div"));
  const viewport = surface.appendChild(document.createElement("ul"));
  Object.defineProperties(viewport, {
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: content, configurable: true },
  });
  const track = appendVerticalScrollbar(viewport, surface);
  return { viewport, track, thumb: track.firstElementChild as HTMLElement };
}

describe("appendVerticalScrollbar", () => {
  it("reveals the Lattice bar only while the pointer is over the list or it scrolls", () => {
    vi.useFakeTimers();
    const { viewport, track, thumb } = mount(400);
    expect(track).toHaveClass("lattice-scrollbar");
    expect(track.parentElement).toBe(viewport.parentElement);
    expect(track).not.toHaveAttribute("data-hovering");

    fireEvent.pointerEnter(viewport);
    expect(track).toHaveAttribute("data-hovering");
    expect(track).toHaveAttribute("data-overflow-y-end");
    expect(track.style.height).toBe("100px");
    // A quarter of the 92px inset track, the viewport's share of the content.
    expect(thumb.style.height).toBe("23px");
    fireEvent.pointerLeave(viewport);
    expect(track).not.toHaveAttribute("data-hovering");

    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    expect(track).toHaveAttribute("data-scrolling");
    expect(track).toHaveAttribute("data-overflow-y-start");
    expect(track).not.toHaveAttribute("data-overflow-y-end");
    vi.advanceTimersByTime(600);
    expect(track).not.toHaveAttribute("data-scrolling");
  });

  it("stays hidden for a list that fits, and passes a wheel over the bar to the list", () => {
    const short = mount(100);
    fireEvent.pointerEnter(short.viewport);
    expect(short.track).not.toHaveAttribute("data-overflow-y-end");

    const long = mount(400);
    fireEvent.pointerEnter(long.viewport);
    fireEvent.wheel(long.track, { deltaY: 40 });
    expect(long.viewport.scrollTop).toBe(40);
  });
});
