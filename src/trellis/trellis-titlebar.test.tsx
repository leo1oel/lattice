import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { activateAppLocale } from "../i18n";
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
/** A restore chip's width cap (`.trellis-hidden-chip`'s max-width). */
const CHIP_CAP = 140;
/** `chipText` is a chip's title at full width; `chipWidth` what the row gives it. */
const layout = { room: 1200, chipsOverflow: 0, chipText: 0, chipWidth: 0 };
const observers = new Set<() => void>();

const bar = () => document.querySelector<HTMLElement>(".trellis-titlebar")!;
const resize = (room: number) => act(() => {
  layout.room = room;
  for (const notify of observers) notify();
});
const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0 }) as DOMRect;

describe("titlebar layout presets", () => {
  beforeEach(() => {
    Object.assign(layout, { room: 1200, chipsOverflow: 0, chipText: 0, chipWidth: 0 });
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
    // A browser's geometry: the bar is a flex row as wide as its room, so its
    // scrollWidth never reads less than the room, and its controls end where
    // their need does (clipped at the room).
    const need = () => (bar().hasAttribute("data-compact") ? COMPACT : LABELLED);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("trellis-titlebar")) return layout.room;
      if (this.classList.contains("trellis-hidden-chip")) return layout.chipWidth;
      return this.classList.contains("trellis-titlebar-hidden") ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("trellis-hidden-chip") ? layout.chipWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("trellis-titlebar")) return Math.max(layout.room, need());
      if (this.classList.contains("trellis-hidden-chip")) return layout.chipText;
      return this.classList.contains("trellis-titlebar-hidden") ? 100 + layout.chipsOverflow : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("trellis-titlebar")) return rect(0, layout.room);
      if (this.classList.contains("trellis-hidden-chip")) return rect(0, layout.chipWidth);
      // The row's controls end where the need does.
      if (this.parentElement?.classList.contains("trellis-titlebar")) return rect(0, Math.min(need(), layout.room));
      return rect(0, 0);
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
    // A row squeezed for room fills it.
    resize(LABELLED);
    layout.chipsOverflow = 40;
    act(() => controller.ui.set({ hidden: [{ panelId: "panel-papers", title: "Papers" }] }));
    expect(bar()).toHaveAttribute("data-compact");
    // The chip shown in full again, there is room to label the presets.
    layout.chipsOverflow = 0;
    act(() => controller.ui.set({ hidden: [] }));
    expect(bar()).not.toHaveAttribute("data-compact");
  });

  it("drops the labels before the room squeezes a restore chip below its own cap", () => {
    // The chips shrink one by one inside their row, so the row itself need not overflow.
    const controller = new TrellisController();
    render(<TrellisTitlebar controller={controller} />);
    resize(LABELLED);
    Object.assign(layout, { chipText: 90, chipWidth: 60 });
    act(() => controller.ui.set({ hidden: [{ panelId: "panel-agent", title: "Agent" }] }));
    expect(bar()).toHaveAttribute("data-compact");
  });

  it("keeps the labels beside a long restore chip that ends in an ellipsis at its cap", () => {
    // A hidden document's tab titles run far past the chip's cap, which cuts
    // them whatever the window: that cut is no shortage of room.
    const controller = new TrellisController();
    render(<TrellisTitlebar controller={controller} />);
    resize(2007);
    Object.assign(layout, { chipText: 533, chipWidth: CHIP_CAP });
    act(() => controller.ui.set({
      hidden: [{ panelId: "panel-doc", title: "main.tex, Grounded Visual Reasoning in Long Contexts with Sparse Multimodal Supervision" }],
    }));
    expect(bar()).not.toHaveAttribute("data-compact");
    resize(1407);
    expect(bar()).not.toHaveAttribute("data-compact");
    // Short of room, the same chip squeezed below its cap drops them after all.
    layout.chipWidth = CHIP_CAP - 50;
    resize(LABELLED - 20);
    expect(bar()).toHaveAttribute("data-compact");
  });

  it("reads the chip's cap from the stylesheet the measurement relies on", () => {
    const chip = styleRules(trellisRules).find((rule) => rule.selectorText === ".trellis-titlebar .trellis-hidden-chip");
    expect(chip?.style.maxWidth).toBe(`${CHIP_CAP}px`);
  });
});

describe("the Panels menu", () => {
  /** Open the menu from the keyboard, as a writer tabbing to Panels does. */
  async function openFromKeyboard() {
    const panels = screen.getByRole("button", { name: "Panels" });
    act(() => panels.focus());
    fireEvent.keyDown(panels, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    return { panels, menu: within(menu) };
  }
  /** The menu is gone and Radix's close-time focus pass (a macrotask after unmount) has run. */
  async function closed() {
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  // Narrow windows reach the layout presets only through this menu, so closing
  // it must leave the keyboard where it was: focus used to fall to <body>, and
  // the next Tab started over at the PDF's page controls.
  it("returns focus to Panels after Escape and after a layout command", async () => {
    const controller = new TrellisController();
    controller.installHandlers({ preset: () => {}, reset: async () => {} });
    render(<TrellisTitlebar controller={controller} />);

    const escaped = await openFromKeyboard();
    fireEvent.keyDown(escaped.menu.getAllByRole("menuitem")[0], { key: "Escape" });
    await closed();
    expect(document.activeElement).toBe(escaped.panels);

    for (const [role, name] of [["menuitemradio", /^Reading/], ["menuitem", /^Reset layout/]] as const) {
      const chosen = await openFromKeyboard();
      const item = chosen.menu.getByRole(role, { name });
      act(() => item.focus());
      fireEvent.keyDown(item, { key: "Enter" });
      await closed();
      expect(document.activeElement).toBe(chosen.panels);
    }
  });

  it("leaves focus with a panel it brings forward", async () => {
    const controller = new TrellisController();
    const target = document.body.appendChild(document.createElement("button"));
    // Trellis moves DOM focus into the panel on the next frame, before the menu's close settles.
    const focus = vi.fn(() => requestAnimationFrame(() => target.focus()));
    controller.attachWorkspace({ view: () => ({ placement: "docked", visible: true }), focus } as unknown as WorkspaceHandle);
    render(<TrellisTitlebar controller={controller} />);

    const { menu } = await openFromKeyboard();
    const project = menu.getByRole("menuitem", { name: /^Project/ });
    act(() => project.focus());
    fireEvent.keyDown(project, { key: "Enter" });
    await closed();
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(focus).toHaveBeenCalledWith("project");
    expect(document.activeElement).toBe(target);
    target.remove();

    // The handoff is for that one close: the next Escape returns to Panels again.
    const again = await openFromKeyboard();
    fireEvent.keyDown(again.menu.getAllByRole("menuitem")[0], { key: "Escape" });
    await closed();
    expect(document.activeElement).toBe(again.panels);
  });

  // Once the inline Maximize/Restore button is shed, this command is the only
  // way back from a maximized panel, so it must say what it will do.
  it.each([
    ["en", "Panels", "Maximize focused panel", "Restore the layout"],
    ["zh-CN", "面板", "最大化当前面板", "恢复布局"],
  ] as const)("names and runs Maximize or Restore by the framing (%s)", async (locale, panelsName, maximize, restore) => {
    await activateAppLocale(locale);
    const controller = new TrellisController();
    const navigation = { toggle: vi.fn(), frame: vi.fn() };
    controller.attachWorkspace({ navigation, view: () => null } as unknown as WorkspaceHandle);
    render(<TrellisTitlebar controller={controller} />);
    const panels = screen.getByRole("button", { name: panelsName });
    const choose = async (name: string) => {
      fireEvent.pointerDown(panels, { button: 0, ctrlKey: false, pointerType: "mouse" });
      const item = within(await screen.findByRole("menu")).getByRole("menuitem", { name: new RegExp(`^${name}`) });
      fireEvent.click(item);
      await closed();
    };

    await choose(maximize);
    expect(navigation.toggle).toHaveBeenCalledTimes(1);
    expect(navigation.frame).not.toHaveBeenCalled();

    act(() => controller.ui.set({ framed: "panel-writing" }));
    // The shed inline button and the menu agree.
    expect(screen.getByRole("button", { name: restore, pressed: true })).toBeInTheDocument();
    await choose(restore);
    expect(navigation.frame).toHaveBeenCalledWith("all");
    expect(navigation.toggle).toHaveBeenCalledTimes(1);
  });
});
