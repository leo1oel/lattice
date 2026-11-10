import { afterEach, expect, it } from "vitest";
import { observeTabStripFades, updateTabStripFade } from "./trellis-tab-fades";

afterEach(() => {
  document.body.replaceChildren();
});

/** jsdom lays nothing out: give a strip the scroll geometry a browser would. */
function strip(scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  const element = document.createElement("div");
  element.dataset.trellisPart = "tabs";
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(element, "scrollLeft", { configurable: true, writable: true, value: scrollLeft });
  return element;
}

const flags = (element: HTMLElement) => [element.hasAttribute("data-fade-start"), element.hasAttribute("data-fade-end")];

it("fades only the sides of a strip that hide tabs", () => {
  const fits = strip(300, 300);
  updateTabStripFade(fits);
  expect(flags(fits)).toEqual([false, false]);

  const atStart = strip(600, 300, 0);
  updateTabStripFade(atStart);
  expect(flags(atStart)).toEqual([false, true]);

  const between = strip(600, 300, 120);
  updateTabStripFade(between);
  expect(flags(between)).toEqual([true, true]);

  const atEnd = strip(600, 300, 300);
  updateTabStripFade(atEnd);
  expect(flags(atEnd)).toEqual([true, false]);
});

it("follows a strip's scrolling and the layout's changes", async () => {
  const root = document.createElement("div");
  const tabs = strip(600, 300, 0);
  root.append(tabs);
  document.body.append(root);
  let notify = () => {};
  const stop = observeTabStripFades(root, (listener) => {
    notify = listener;
    return () => { notify = () => {}; };
  });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(flags(tabs)).toEqual([false, true]);

  tabs.scrollLeft = 300;
  tabs.dispatchEvent(new Event("scroll"));
  expect(flags(tabs)).toEqual([true, false]);

  // A new strip arrives with the next layout.
  const added = strip(500, 200, 0);
  root.append(added);
  notify();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(flags(added)).toEqual([false, true]);

  stop();
  tabs.scrollLeft = 0;
  tabs.dispatchEvent(new Event("scroll"));
  expect(flags(tabs)).toEqual([true, false]);
});
