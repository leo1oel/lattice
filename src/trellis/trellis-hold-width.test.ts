import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLDS_WIDTH_ATTRIBUTE, holdWidthsWhileResizing } from "./trellis-hold-width";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function workspace() {
  const root = document.createElement("div");
  const held = document.createElement("div");
  held.setAttribute(HOLDS_WIDTH_ATTRIBUTE, "");
  held.style.width = "50%";
  const free = document.createElement("div");
  root.append(held, free);
  document.body.append(root);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => (
    { width: element === held ? "412px" : "100px" } as CSSStyleDeclaration
  ));
  return { root, held, free };
}

describe("holdWidthsWhileResizing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("keeps opted-in content at its width for the length of a resize drag", async () => {
    const { root, held, free } = workspace();
    const stop = holdWidthsWhileResizing(root);

    root.setAttribute("data-resizing", "x");
    await settle();
    expect(held.style.width).toBe("412px");
    expect(free.style.width).toBe("");

    root.removeAttribute("data-resizing");
    await settle();
    expect(held.style.width).toBe("50%");
    stop();
  });

  it("gives the width back when the workspace goes away mid-drag", async () => {
    const { root, held } = workspace();
    const stop = holdWidthsWhileResizing(root);
    root.setAttribute("data-resizing", "float");
    await settle();
    expect(held.style.width).toBe("412px");

    stop();
    expect(held.style.width).toBe("50%");
  });
});
