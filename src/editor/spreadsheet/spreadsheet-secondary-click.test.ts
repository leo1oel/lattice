import { afterEach, describe, expect, it, vi } from "vitest";
import { secondaryClickAsRightButton } from "./spreadsheet-secondary-click";

type Seen = { type: string; button: number; buttons: number; ctrlKey: boolean; clientX: number };

function sheetHost() {
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  const seen: Seen[] = [];
  const record = (event: PointerEvent) => seen.push({
    type: event.type, button: event.button, buttons: event.buttons, ctrlKey: event.ctrlKey, clientX: event.clientX,
  });
  canvas.addEventListener("pointerdown", record);
  canvas.addEventListener("pointerup", record);
  return { host, canvas, seen };
}

const press = (canvas: HTMLElement, type: "pointerdown" | "pointerup", init: PointerEventInit) => (
  canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: 40, ...init }))
);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("secondaryClickAsRightButton", () => {
  it("hands Univer a Control-click as the right-button press and release it stands for", () => {
    const { host, canvas, seen } = sheetHost();
    const stop = secondaryClickAsRightButton(host);
    press(canvas, "pointerdown", { button: 0, buttons: 1, ctrlKey: true });
    press(canvas, "pointerup", { button: 0, buttons: 0, ctrlKey: true });
    expect(seen).toEqual([
      { type: "pointerdown", button: 2, buttons: 2, ctrlKey: false, clientX: 40 },
      { type: "pointerup", button: 2, buttons: 0, ctrlKey: false, clientX: 40 },
    ]);
    stop();
  });

  it("hands Univer a Command-click as the Ctrl-click that adds a range", () => {
    const { host, canvas, seen } = sheetHost();
    const stop = secondaryClickAsRightButton(host);
    press(canvas, "pointerdown", { button: 0, buttons: 1, metaKey: true });
    press(canvas, "pointerup", { button: 0, buttons: 0, metaKey: true });
    expect(seen).toEqual([
      { type: "pointerdown", button: 0, buttons: 1, ctrlKey: true, clientX: 40 },
      { type: "pointerup", button: 0, buttons: 0, ctrlKey: false, clientX: 40 },
    ]);
    stop();
  });

  it("leaves plain, Shift, Control-Command and right clicks alone", () => {
    const { host, canvas, seen } = sheetHost();
    const stop = secondaryClickAsRightButton(host);
    for (const init of [{}, { shiftKey: true }, { ctrlKey: true, metaKey: true }, { button: 2, buttons: 2 }]) {
      press(canvas, "pointerdown", { button: 0, buttons: 1, ...init });
      press(canvas, "pointerup", { button: 0, buttons: 0, ...init });
    }
    expect(seen.map(({ button }) => button)).toEqual([0, 0, 0, 0, 0, 0, 2, 2]);
    expect(seen.every(({ ctrlKey }, index) => ctrlKey === (index === 4 || index === 5))).toBe(true);
    stop();
  });

  it("stops converting once disposed", () => {
    const { host, canvas, seen } = sheetHost();
    secondaryClickAsRightButton(host)();
    press(canvas, "pointerdown", { button: 0, buttons: 1, ctrlKey: true });
    expect(seen).toEqual([{ type: "pointerdown", button: 0, buttons: 1, ctrlKey: true, clientX: 40 }]);
  });

  it("does nothing off a Mac, where Control-click adds a range", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const { host, canvas, seen } = sheetHost();
    const stop = secondaryClickAsRightButton(host);
    press(canvas, "pointerdown", { button: 0, buttons: 1, ctrlKey: true });
    expect(seen[0]).toMatchObject({ button: 0, ctrlKey: true });
    stop();
  });
});
