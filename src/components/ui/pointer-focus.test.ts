import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installPointerFocus } from "./pointer-focus";

const MARK = "data-pointer-focus";

const pointer = (type = "pointerdown") => window.dispatchEvent(new Event(type));
const key = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

function button(parent: Node = document.body) {
  const element = document.createElement("button");
  parent.appendChild(element);
  return element;
}

describe("pointer focus", () => {
  // The listeners install once for the page, as main.tsx does.
  beforeAll(() => installPointerFocus());
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.replaceChildren();
  });

  it("marks focus a pointer press caused, and not focus after a key press", () => {
    const first = button();
    const second = button();
    pointer();
    first.focus();
    expect(first.hasAttribute(MARK)).toBe(true);
    key();
    second.focus();
    expect(second.hasAttribute(MARK)).toBe(false);
    // Losing focus drops the mark, so it never outlives the focus it was for.
    expect(first.hasAttribute(MARK)).toBe(false);
  });

  it("treats a moving pointer as the last hand, as a menu focusing the hovered row", () => {
    const row = button();
    key();
    pointer("pointermove");
    row.focus();
    expect(row.hasAttribute(MARK)).toBe(true);
  });

  it("lets Tab after a click ring the element focus returns to", () => {
    const trigger = button();
    pointer();
    trigger.focus();
    trigger.blur();
    key();
    trigger.focus();
    expect(trigger.hasAttribute(MARK)).toBe(false);
  });

  it("leaves editable text alone", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    // jsdom does not compute isContentEditable; WebKit derives it from the attribute.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    pointer();
    editor.focus();
    expect(editor.hasAttribute(MARK)).toBe(false);
  });

  it("marks rows inside an open shadow root, row to row too", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const first = button(root);
    const second = button(root);
    pointer();
    first.focus();
    expect(first.hasAttribute(MARK)).toBe(true);
    second.focus();
    expect(second.hasAttribute(MARK)).toBe(true);
    expect(first.hasAttribute(MARK)).toBe(false);
    key();
    first.focus();
    expect(first.hasAttribute(MARK)).toBe(false);
  });
});
