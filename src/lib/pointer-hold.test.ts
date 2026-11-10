import { afterEach, describe, expect, it, vi } from "vitest";
import { watchPointerHold } from "./pointer-hold";

const press = (target: EventTarget, button = 0) => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button }));

afterEach(() => {
  document.body.replaceChildren();
});

describe("watchPointerHold", () => {
  it("holds from a primary press inside the element until the button is let go anywhere", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const child = root.appendChild(document.createElement("span"));
    const onRelease = vi.fn();
    const hold = watchPointerHold(root, onRelease);

    press(child);
    expect(hold.held()).toBe(true);
    // Let go outside the element: the drag ran past its edge.
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(hold.held()).toBe(false);
    expect(onRelease).toHaveBeenCalledOnce();
    // The mouseup of the same release, and later ones, are not another release.
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("ends a hold the pointer never lets go of: text dragged away, or the window losing focus", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const onRelease = vi.fn();
    const hold = watchPointerHold(root, onRelease);
    for (const end of [() => window.dispatchEvent(new Event("dragend")), () => window.dispatchEvent(new Event("blur"))]) {
      press(root);
      expect(hold.held()).toBe(true);
      end();
      expect(hold.held()).toBe(false);
    }
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it("ignores other buttons and presses elsewhere, and stops watching once disposed", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const elsewhere = document.body.appendChild(document.createElement("div"));
    const onRelease = vi.fn();
    const hold = watchPointerHold(root, onRelease);
    press(root, 2);
    press(elsewhere);
    expect(hold.held()).toBe(false);

    press(root);
    hold.dispose();
    expect(hold.held()).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerup"));
    press(root);
    expect(hold.held()).toBe(false);
    expect(onRelease).not.toHaveBeenCalled();
  });
});
