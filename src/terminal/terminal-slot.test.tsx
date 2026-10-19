import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ScreenSlot, SETTLE_MS } from "./terminal-slot";

/** Each observer the slot starts; `resize()` reports a new size to all of them, as a frame of layout would. */
const observers = new Set<() => void>();
const resize = () => { for (const notify of [...observers]) notify(); };

function fakeScreen() {
  const element = document.createElement("div");
  return { element, attach: vi.fn((slot: HTMLElement) => slot.appendChild(element)), fit: vi.fn(), focus: vi.fn(), setShown: vi.fn() };
}

describe("terminal slot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class {
      private readonly notify: () => void;
      constructor(callback: (entries: ResizeObserverEntry[]) => void) { this.notify = () => callback([]); }
      // Like a browser's, it reports a target once when it starts observing it.
      observe() {
        observers.add(this.notify);
        this.notify();
      }
      unobserve() {}
      disconnect() { observers.delete(this.notify); }
    });
  });
  afterEach(() => {
    observers.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fits the grid once the slot's size has held, not on every frame of an animation", () => {
    const screen = fakeScreen();
    render(<ScreenSlot screen={screen} shown focused={false} moving={false} />);
    expect(screen.fit).not.toHaveBeenCalled();
    for (let frame = 0; frame < 10; frame += 1) {
      resize();
      vi.advanceTimersByTime(16);
    }
    expect(screen.fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(screen.fit).toHaveBeenCalledTimes(1);
  });

  it("keeps the grid's size while a panel is dragged, however long the drag holds still, and fits after the drop", () => {
    const screen = fakeScreen();
    const view = render(<ScreenSlot screen={screen} shown focused={false} moving={false} />);
    vi.advanceTimersByTime(SETTLE_MS);
    screen.fit.mockClear();
    view.rerender(<ScreenSlot screen={screen} shown focused={false} moving />);
    // Trellis shrinks the dragged panel to a strip; the pointer then rests.
    resize();
    vi.advanceTimersByTime(10 * SETTLE_MS);
    expect(screen.fit).not.toHaveBeenCalled();
    view.rerender(<ScreenSlot screen={screen} shown focused={false} moving={false} />);
    resize();
    vi.advanceTimersByTime(16);
    resize();
    expect(screen.fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(screen.fit).toHaveBeenCalledTimes(1);
  });

  it("does not fit a hidden tab's grid", () => {
    const screen = fakeScreen();
    render(<ScreenSlot screen={screen} shown={false} focused={false} moving={false} />);
    resize();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(screen.fit).not.toHaveBeenCalled();
    expect(screen.setShown).toHaveBeenCalledWith(false);
  });
});
