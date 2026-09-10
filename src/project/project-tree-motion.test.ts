import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachProjectTreeMotion } from "./project-tree-motion";

const effects: { element: Element; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
let dispose: (() => void) | undefined;
let reduce = false;
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
beforeEach(() => {
  effects.length = 0;
  reduce = false;
  vi.spyOn(window, "matchMedia").mockImplementation(() => ({
    get matches() { return reduce; }, addEventListener() {}, removeEventListener() {},
  }) as unknown as MediaQueryList);
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: function (this: Element, frames: Keyframe[]) {
    const effect = { element: this, frames, cancel: vi.fn(), onfinish: null };
    effects.push(effect);
    return effect;
  } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(9, Number(this.dataset.y ?? 0), 240, 32);
  });
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function row(path: string, y: number, expanded?: boolean) {
  const element = document.createElement("button");
  element.dataset.type = "item";
  element.dataset.itemPath = path;
  element.dataset.y = String(y);
  element.textContent = path;
  element.id = path;
  if (expanded !== undefined) element.setAttribute("aria-expanded", String(expanded));
  return element;
}
function setup(open = false) {
  const scroller = document.createElement("div");
  const window = document.createElement("div");
  window.dataset.fileTreeVirtualizedSticky = "true";
  const folder = row("a/", 10, open);
  const child = row("a/file.tex", 42);
  const sibling = row("b.tex", open ? 74 : 42);
  window.append(folder, ...(open ? [child] : []), sibling);
  scroller.append(window);
  document.body.append(scroller);
  dispose = attachProjectTreeMotion(scroller);
  return { scroller, window, folder, child, sibling };
}

it("matches paths rather than recycled DOM slots when expanding", async () => {
  const { folder, sibling, window } = setup();
  // Pierre reuses b's node for the new child, moving b into a new slot.
  sibling.dataset.itemPath = "a/file.tex";
  sibling.textContent = "a/file.tex";
  const movedSibling = row("b.tex", 74);
  window.append(movedSibling);
  folder.setAttribute("aria-expanded", "true");
  await flush();
  expect(effects.find(e => e.element === movedSibling)?.frames[0]).toEqual({ transform: "translateY(-32px)" });
  expect(effects.find(e => e.element === sibling)?.frames[0].clipPath).toBe("inset(0 0 100% 0)");
});

it("reveals later children only as the displaced sibling makes room", async () => {
  const { folder, sibling, window } = setup();
  const children = [row("a/one.tex", 42), row("a/two.tex", 74), row("a/three.tex", 106)];
  window.insertBefore(children[0], sibling);
  window.insertBefore(children[1], sibling);
  window.insertBefore(children[2], sibling);
  sibling.dataset.y = "138";
  folder.setAttribute("aria-expanded", "true");
  await flush();
  expect(effects.find(e => e.element === sibling)?.frames[0].transform).toBe("translateY(-96px)");
  expect(effects.find(e => e.element === children[2])?.frames[1]).toEqual({ offset: 2 / 3, clipPath: "inset(0 0 100% 0)" });
});

it("clips inert exit pictures and moves surviving rows up, then cancels them on scroll", async () => {
  const { folder, child, sibling, scroller, window } = setup(true);
  child.remove();
  sibling.dataset.y = "42";
  folder.setAttribute("aria-expanded", "false");
  await flush();
  expect(effects.find(e => e.element === sibling)?.frames[0]).toEqual({ transform: "translateY(32px)" });
  const picture = window.querySelector<HTMLElement>("[data-tree-exit]")!;
  expect(picture.inert).toBe(true);
  expect(picture).toHaveAttribute("aria-hidden", "true");
  expect(picture.querySelector("[id]")).toBeNull();
  expect(picture.textContent).toBe("a/file.tex");
  expect(effects.find(e => e.element === picture)?.frames[1]).toEqual({ clipPath: "inset(0 0 100% 0)" });
  scroller.dispatchEvent(new Event("scroll"));
  expect(window.querySelector("[data-tree-exit]")).toBeNull();
  expect(effects.every(e => e.cancel.mock.calls.length === 1)).toBe(true);
});

it("does not animate filtering, reduced motion, or a scroll-clamped collapse", async () => {
  const { window, folder, child, sibling, scroller } = setup(true);
  sibling.remove();
  await flush();
  expect(effects).toHaveLength(0);
  reduce = true;
  folder.setAttribute("aria-expanded", "false");
  child.remove();
  await flush();
  expect(effects).toHaveLength(0);
  reduce = false;
  scroller.scrollTop = 64;
  folder.setAttribute("aria-expanded", "true");
  window.append(child);
  await flush();
  expect(effects).toHaveLength(0);
});
