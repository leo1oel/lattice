import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrellisController } from "./trellis-controller";
import { TrellisTitlebar } from "./trellis-titlebar";

afterEach(cleanup);

// Vitest empties CSS imports, so load the stylesheets off disk into jsdom's
// CSSOM: the assertions read parsed rules and computed styles, not source text.
function loadSheet(file: string): CSSRule[] {
  const style = document.createElement("style");
  style.textContent = readFileSync(file, "utf8");
  document.head.append(style);
  return [...style.sheet!.cssRules];
}
const trellisRules = loadSheet("src/trellis/trellis.css");
const shellRules = loadSheet("src/styles/app-shell.css");

const styleRules = (rules: Iterable<CSSRule>) => [...rules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
const containerRules = (rules: CSSRule[], name: string) => rules.filter((rule): rule is CSSContainerRule => rule instanceof CSSContainerRule && rule.containerName === name);
const maxWidth = (rule: CSSContainerRule) => Number(/max-width:\s*(\d+)px/.exec(rule.containerQuery)?.[1]);

/** The computed container of an element, from the shorthand or its longhands. */
function containerOf(element: Element) {
  const style = getComputedStyle(element);
  const [name = "", type = ""] = style.getPropertyValue("container").split("/").map((part) => part.trim());
  return { name: name || style.getPropertyValue("container-name"), type: type || style.getPropertyValue("container-type") };
}

/** The width of the `trellis-titlebar` container step that hides `selector`. */
function hiddenBelow(selector: string): number {
  const steps = containerRules(trellisRules, "trellis-titlebar").filter((step) => styleRules(step.cssRules).some((rule) => rule.selectorText === selector && rule.style.display === "none"));
  expect(steps).toHaveLength(1);
  return maxWidth(steps[0]);
}

describe("titlebar panel controls in a narrow window", () => {
  // At the window's 640px minimum (and in a browser tab, which has no floor)
  // the controls used to spill under the canvas actions beside them, so a
  // click on Maximize landed on Editor comments and Reset layout on Open from
  // Overleaf. The bar is now sized by what the canvas actions leave and clips
  // what does not fit; groups are shed by the bar's own width before that.
  it("takes only the room the canvas actions leave, and never paints over them", () => {
    const { container } = render(<div className="titlebar"><button className="project-title" /><TrellisTitlebar controller={new TrellisController()} /></div>);
    const bar = container.querySelector(".trellis-titlebar")!;
    expect(containerOf(bar)).toEqual({ name: "trellis-titlebar", type: "inline-size" });
    expect(getComputedStyle(bar).overflow).toBe("clip");
    expect(getComputedStyle(bar).minWidth).toBe("0px");
    // A viewport query cannot know how much of the bar the project name, the
    // traffic lights or interface zoom take, so none may size these controls.
    const mediaRules = trellisRules.filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
    for (const rule of mediaRules.flatMap((media) => styleRules(media.cssRules))) {
      expect(rule.selectorText).not.toMatch(/trellis-titlebar|trellis-preset/);
    }
    // A long project name gives way first, measured on the bar too.
    expect(containerOf(container.querySelector(".titlebar")!)).toEqual({ name: "titlebar", type: "inline-size" });
    const clamps = containerRules(shellRules, "titlebar").flatMap((step) => styleRules(step.cssRules)).filter((rule) => rule.selectorText === ".project-title");
    expect(clamps.map((rule) => rule.style.maxWidth)).toEqual(["var(--titlebar-project-title-max-width-compact)"]);
  });

  it("sheds the layout actions first, then the panel toggles, then the presets, then the Panels label", () => {
    const layoutActions = hiddenBelow(".trellis-titlebar-layout-actions");
    const panelToggles = hiddenBelow(".trellis-titlebar-panel-toggles");
    const presets = hiddenBelow(".trellis-titlebar-presets");
    const panelsLabel = hiddenBelow(".trellis-titlebar-menu > span");
    expect(layoutActions).toBeGreaterThan(panelToggles);
    expect(panelToggles).toBeGreaterThan(presets);
    expect(presets).toBeGreaterThan(panelsLabel);
  });

  it("keeps every shed control's action in the Panels menu", () => {
    const controller = new TrellisController();
    const presets: Array<string | null> = [];
    controller.installHandlers({ preset: (preset) => presets.push(preset) });
    const { container } = render(<TrellisTitlebar controller={controller} />);
    const shed = (selector: string) => [...container.querySelectorAll(`${selector} button`)].map((button) => button.getAttribute("aria-label"));
    expect(shed(".trellis-titlebar-layout-actions")).toEqual(["Maximize focused panel", "Reset layout"]);
    expect(shed(".trellis-titlebar-panel-toggles")).toEqual(["Show Project", "Show Papers", "Show Agent"]);
    expect([...container.querySelectorAll(".trellis-titlebar-presets button")].map((button) => button.textContent)).toEqual(["Workspace", "Writing", "Reading"]);

    const panels = screen.getByRole("button", { name: "Panels" });
    // The trigger keeps its name once only the icon is left.
    expect(panels.querySelector("span")).toHaveTextContent("Panels");
    fireEvent.pointerDown(panels, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = within(screen.getByRole("menu"));
    for (const name of ["Project", "Papers", "Agent", "Maximize focused panel", "Reset layout"]) {
      expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    expect(menu.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Workspace", "true"], ["Writing", "false"], ["Reading", "false"],
    ]);
    fireEvent.click(menu.getByRole("menuitemradio", { name: "Reading" }));
    expect(presets).toEqual(["reading"]);
  });
});

/** The titlebar's controls with the presets labelled and without, and the room the window leaves it. */
const LABELLED = 860;
const COMPACT = 640;
const layout = { room: 1200, chipsOverflow: 0, chipTruncated: 0 };
const observers = new Set<() => void>();

const bar = () => document.querySelector<HTMLElement>(".trellis-titlebar")!;
const resize = (room: number) => act(() => {
  layout.room = room;
  for (const notify of observers) notify();
});

describe("titlebar layout presets", () => {
  beforeEach(() => {
    layout.room = 1200;
    layout.chipsOverflow = 0;
    layout.chipTruncated = 0;
    vi.stubGlobal("ResizeObserver", class {
      private readonly notify: () => void;
      constructor(callback: () => void) { this.notify = () => callback(); }
      // Like a browser's, it reports a target once when it starts observing it.
      observe() {
        observers.add(this.notify);
        this.notify();
      }
      unobserve() {}
      disconnect() { observers.delete(this.notify); }
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("trellis-titlebar")) return layout.room;
      return this.classList.contains("trellis-titlebar-hidden") ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      // Content wider than the room overflows it; narrower, the bar is as wide as the room.
      if (this.classList.contains("trellis-titlebar")) return Math.max(layout.room, this.hasAttribute("data-compact") ? COMPACT : LABELLED);
      if (this.classList.contains("trellis-hidden-chip")) return layout.chipTruncated;
      return this.classList.contains("trellis-titlebar-hidden") ? 100 + layout.chipsOverflow : 0;
    });
  });

  afterEach(() => {
    observers.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps their labels while they fit the titlebar's room, whatever the window's width", () => {
    // 857px of room with an 860px need drops them; the labels are not tied to a viewport breakpoint.
    render(<TrellisTitlebar controller={new TrellisController()} />);
    expect(bar()).not.toHaveAttribute("data-compact");
    resize(LABELLED);
    expect(bar()).not.toHaveAttribute("data-compact");
    resize(LABELLED - 3);
    expect(bar()).toHaveAttribute("data-compact");
    // Compact, the room is held to the labelled need, so nothing flips back and forth.
    resize(LABELLED - 1);
    expect(bar()).toHaveAttribute("data-compact");
    resize(LABELLED);
    expect(bar()).not.toHaveAttribute("data-compact");
  });

  it("drops the labels before a hidden panel's restore chip is squeezed out", () => {
    const controller = new TrellisController();
    render(<TrellisTitlebar controller={controller} />);
    layout.chipsOverflow = 40;
    act(() => controller.ui.set({ hidden: [{ panelId: "panel-papers", title: "Papers" }] }));
    expect(bar()).toHaveAttribute("data-compact");
    // The chip shown in full again, there is room to label the presets.
    layout.chipsOverflow = 0;
    act(() => controller.ui.set({ hidden: [] }));
    expect(bar()).not.toHaveAttribute("data-compact");
  });

  it("drops the labels before a restore chip's title is cut to an ellipsis", () => {
    // The chips shrink one by one inside their row, so the row itself need not overflow.
    const controller = new TrellisController();
    render(<TrellisTitlebar controller={controller} />);
    layout.chipTruncated = 30;
    act(() => controller.ui.set({ hidden: [{ panelId: "panel-agent", title: "Agent" }] }));
    expect(bar()).toHaveAttribute("data-compact");
  });
});
