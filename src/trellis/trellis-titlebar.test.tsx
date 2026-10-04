import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { activateAppLocale } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { TrellisController } from "./trellis-controller";
import { TrellisTitlebar } from "./trellis-titlebar";
import { LayoutSwitch } from "./trellis-workspace-switch";

vi.mock("../telemetry/app-notify", async (importOriginal) => ({ ...await importOriginal<object>(), notifyInfo: vi.fn() }));

afterEach(cleanup);
beforeEach(() => localStorage.clear());

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
    const chosen: Array<string | null> = [];
    controller.installHandlers({ preset: (preset) => chosen.push(preset) });
    const { container } = render(<TrellisTitlebar controller={controller} />);
    const shed = (selector: string) => [...container.querySelectorAll(`${selector} button`)].map((button) => button.getAttribute("aria-label"));
    expect(shed(".trellis-titlebar-layout-actions")).toEqual(["Maximize focused panel", "Reset layout"]);
    expect(shed(".trellis-titlebar-panel-toggles")).toEqual(["Show Project", "Show Papers", "Show Agent"]);
    const presets = container.querySelector<HTMLElement>(".trellis-titlebar-presets")!;
    expect(within(presets).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Workspace", "Writing", "Reading"]);
    expect(within(presets).getByRole("button", { name: "New workspace" })).toBeInTheDocument();

    const panels = screen.getByRole("button", { name: "Panels" });
    // The trigger keeps its name once only the icon is left.
    expect(panels.querySelector("span")).toHaveTextContent("Panels");
    fireEvent.pointerDown(panels, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = within(screen.getByRole("menu"));
    for (const name of ["Project", "Papers", "Agent", "Maximize focused panel", "Reset layout"]) {
      expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    expect(menu.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Workspace⌘1", "true"], ["Writing", "false"], ["Reading", "false"],
    ]);
    fireEvent.click(menu.getByRole("menuitemradio", { name: "Reading" }));
    expect(chosen).toEqual(["reading"]);
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
      constructor(callback: (entries: ResizeObserverEntry[]) => void) { this.notify = () => callback([]); }
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

  it("stays folded through a move from the workspace menu, keeping the keyboard on its button", async () => {
    // A reorder changes no width: a re-measure would unfold the switch for a
    // frame and take the open menu's button, and the keyboard, with it.
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    render(<TrellisTitlebar controller={controller} />);
    resize(LABELLED - 20);
    expect(bar()).toHaveAttribute("data-compact");
    const trigger = screen.getByRole("button", { name: "Workspace: Workspace" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move right" }));
    expect(library.list().map((entry) => entry.name)).toEqual(["Review", "Workspace"]);
    expect(bar()).toHaveAttribute("data-compact");
    expect(trigger.isConnected).toBe(true);
    await waitFor(() => expect(trigger).toHaveFocus());
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

/**
 * A controller whose workspace handlers do what the mounted workspace's do to
 * the titlebar's state: switching enters a workspace (leaving any preset), and
 * a new workspace is added after the current one and entered.
 */
function withWorkspaces() {
  const controller = new TrellisController();
  const library = controller.workspaces;
  controller.installHandlers({
    workspace: (id) => controller.ui.set({ workspace: id, preset: null }),
    newWorkspace: (name) => {
      const id = library.add(name, null, controller.ui.get().workspace);
      controller.ui.set({ workspace: id, preset: null });
      return id;
    },
    preset: (preset) => controller.ui.set({ preset }),
  });
  controller.ui.set({ workspace: library.recent() });
  return { controller, library };
}

const tabNames = () => within(screen.getByRole("tablist", { name: "Workspaces" })).getAllByRole("tab").map((tab) => tab.textContent);
const announced = () => document.querySelector("[data-workspace-announcement]");
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

describe("named workspaces in the titlebar", () => {
  it("makes a workspace from the + and names it in place", async () => {
    const { controller } = withWorkspaces();
    render(<TrellisTitlebar controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field.value).toBe("Workspace 2");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "Workspace 2".length]);
    fireEvent.change(field, { target: { value: "Review" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(tabNames()).toEqual(["Workspace", "Review"]);
    expect(selectedTab()).toBe("Review");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Review" })).toHaveFocus());
  });

  it("renames on double-click, refuses a name in use, and keeps the old one on Escape", () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    render(<TrellisTitlebar controller={controller} />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Review" }));
    const field = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(field, { target: { value: "workspace" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(tabNames()).toEqual(["Workspace", "Review"]);
    // F2 renames the focused workspace; leaving the field keeps a free name.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), { key: "F2" });
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Proofs" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Workspace name" }));
    expect(tabNames()).toEqual(["Workspace", "Proofs"]);
  });

  // `size` counts characters at the average Latin width, about half a CJK
  // glyph's, so "工作区 副本" overflowed its field and scrolled its first
  // character out of view. A hidden copy of the draft now sizes the field.
  it("sizes the name field to its draft, CJK included, wide or folded", () => {
    const { controller } = withWorkspaces();
    const { rerender } = render(<LayoutSwitch controller={controller} compact={false} />);
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Workspace" }));
    const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
    const sizer = field.parentElement!;
    fireEvent.change(field, { target: { value: "工作区 副本" } });
    expect(sizer).toHaveAttribute("data-value", "工作区 副本");
    rerender(<LayoutSwitch controller={controller} compact />);
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(field);
    fireEvent.change(field, { target: { value: "工作区副本工作区副本" } });
    expect(sizer).toHaveAttribute("data-value", "工作区副本工作区副本");
  });

  it("duplicates and deletes from the context menu, and Undo brings a deleted workspace back", async () => {
    const { controller, library } = withWorkspaces();
    render(<TrellisTitlebar controller={controller} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Workspace" }));
    // The last workspace cannot go.
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    const field = await screen.findByRole("textbox", { name: "Workspace name" });
    expect((field as HTMLInputElement).value).toBe("Workspace copy");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(tabNames()).toEqual(["Workspace", "Workspace copy"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Deleting the workspace the project is in moves it to the next one.
    const first = library.list()[0].id;
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(tabNames()).toEqual(["Workspace copy"]);
    expect(selectedTab()).toBe("Workspace copy");
    const [, title, options] = vi.mocked(notifyInfo).mock.lastCall!;
    expect(title).toBe("Deleted “Workspace”");
    act(() => options!.primaryAction!.onClick());
    expect(tabNames()).toEqual(["Workspace", "Workspace copy"]);
    expect(controller.ui.get().workspace).toBe(first);
  });

  it("marks the workspace the project differs from, and offers to save to it or revert to it", async () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    const save = vi.spyOn(controller, "saveWorkspace");
    const revert = vi.spyOn(controller, "revertWorkspace");
    render(<TrellisTitlebar controller={controller} />);
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Workspace" }));
    await screen.findByRole("menuitem", { name: "Duplicate" });
    expect(screen.queryByRole("menuitem", { name: "Save to workspace" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    act(() => controller.ui.set({ dirty: true }));
    const tab = screen.getByRole("tab", { name: /^Workspace/ });
    expect(within(tab).getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: "Review" })).queryByRole("img")).toBeNull();
    // Only the workspace the project is in offers them.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Review" }));
    await screen.findByRole("menuitem", { name: "Duplicate" });
    expect(screen.queryByRole("menuitem", { name: "Save to workspace" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save to workspace" }));
    expect(save).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revert to saved" }));
    expect(revert).toHaveBeenCalledOnce();
  });

  it("marks the folded workspace menu while the project differs from its workspace", async () => {
    const { controller } = withWorkspaces();
    const save = vi.spyOn(controller, "saveWorkspace");
    act(() => controller.ui.set({ dirty: true }));
    render(<LayoutSwitch controller={controller} compact />);
    const trigger = screen.getByRole("button", { name: "Workspace: Workspace" });
    expect(within(trigger).getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save to workspace" }));
    expect(save).toHaveBeenCalledOnce();
  });

  it("moves along workspaces and presets with the arrow keys, choosing each", () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    render(<TrellisTitlebar controller={controller} />);
    const first = screen.getByRole("tab", { name: "Workspace" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(selectedTab()).toBe("Review");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Review" }), { key: "ArrowRight" });
    expect(controller.ui.get().preset).toBe("writing");
    // The workspace under the preset is marked, and choosing it again returns from the preset.
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("data-underlying", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(controller.ui.get().preset).toBeNull();
  });

  it("reorders workspaces by dragging one past a neighbour's middle", () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    library.add("Proofs", null);
    render(<TrellisTitlebar controller={controller} />);
    // Each tab is 80px wide, in list order.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = library.list().findIndex((entry) => entry.id === this.dataset.workspace);
      return rect(index * 80, index < 0 ? 0 : 80);
    });
    const tab = screen.getByRole("tab", { name: "Workspace" });
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 42 });
    expect(tabNames()).toEqual(["Workspace", "Review", "Proofs"]);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 130 });
    expect(tabNames()).toEqual(["Review", "Workspace", "Proofs"]);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 230 });
    expect(tabNames()).toEqual(["Review", "Proofs", "Workspace"]);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 230 });
    fireEvent.click(tab);
    // The drop is not a click: the project stays where it was.
    expect(controller.ui.get().workspace).toBe(library.list()[2].id);
    expect(new TrellisController().workspaces.list().map((entry) => entry.name)).toEqual(["Review", "Proofs", "Workspace"]);
    vi.restoreAllMocks();
  });

  it("folds the workspaces into a menu when short of room", async () => {
    const { controller, library } = withWorkspaces();
    const review = library.add("Review", null);
    render(<LayoutSwitch controller={controller} compact />);
    expect(screen.queryByRole("tablist", { name: "Workspaces" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Workspace: Workspace" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Workspace⌘1", "Review⌘2"]);
    expect(menu.getByRole("menuitem", { name: "New workspace" })).toBeInTheDocument();
    fireEvent.click(menu.getByRole("menuitemradio", { name: /^Review/ }));
    expect(controller.ui.get().workspace).toBe(review);
  });

  it("keeps a name being edited, its draft and selection, through folding and unfolding", () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    const view = render(<LayoutSwitch controller={controller} compact={false} />);
    // Not the workspace the project is in, as a copy just made is not.
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Review" }));
    const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Draft review" } });
    field.setSelectionRange(2, 5);
    for (const compact of [true, false]) {
      view.rerender(<LayoutSwitch controller={controller} compact={compact} />);
      expect(screen.getByRole("textbox", { name: "Workspace name" })).toBe(field);
      expect(field).toHaveFocus();
      expect(field.value).toBe("Draft review");
      expect([field.selectionStart, field.selectionEnd]).toEqual([2, 5]);
    }
    fireEvent.keyDown(field, { key: "Enter" });
    expect(tabNames()).toEqual(["Workspace", "Draft review"]);
  });

  it("keeps the keyboard on the workspaces through folding and unfolding", async () => {
    const { controller, library } = withWorkspaces();
    const review = library.add("Review", null);
    act(() => controller.switchWorkspace(review));
    const view = render(<LayoutSwitch controller={controller} compact={false} />);
    act(() => screen.getByRole("tab", { name: "Review" }).focus());
    view.rerender(<LayoutSwitch controller={controller} compact />);
    expect(screen.getByRole("button", { name: "Workspace: Review" })).toHaveFocus();
    view.rerender(<LayoutSwitch controller={controller} compact={false} />);
    expect(screen.getByRole("tab", { name: "Review" })).toHaveFocus();
    // Not where focus has left the switch.
    act(() => screen.getByRole("tab", { name: "Review" }).blur());
    await act(async () => {});
    view.rerender(<LayoutSwitch controller={controller} compact />);
    expect(document.body).toHaveFocus();
  });

  describe("keeps the keyboard on the workspaces when the switch folds or unfolds with a menu open", () => {
    /** The context menu of the focused tab `name`, opened from the keyboard, with focus in it. */
    const keyboardMenuOf = async (name: string) => {
      const tab = screen.getByRole("tab", { name });
      act(() => tab.focus());
      fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
      const menu = await screen.findByRole("menu");
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
      return within(menu);
    };
    const setUp = () => {
      const { controller, library } = withWorkspaces();
      const review = library.add("Review", null);
      library.add("Proofs", null);
      act(() => controller.switchWorkspace(review));
      return { controller, library };
    };

    it("returns from a context menu that outlived folding to the folded button on Escape", async () => {
      const { controller } = setUp();
      const view = render(<LayoutSwitch controller={controller} compact={false} />);
      await keyboardMenuOf("Review");
      view.rerender(<LayoutSwitch controller={controller} compact />);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: "Workspace: Review" })).toHaveFocus());
    });

    it("returns from an action of a context menu that outlived folding to the folded button", async () => {
      const { controller, library } = setUp();
      const view = render(<LayoutSwitch controller={controller} compact={false} />);
      const menu = await keyboardMenuOf("Proofs");
      view.rerender(<LayoutSwitch controller={controller} compact />);
      fireEvent.click(menu.getByRole("menuitem", { name: "Move left" }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(library.list().map((entry) => entry.name)).toEqual(["Workspace", "Proofs", "Review"]);
      await waitFor(() => expect(screen.getByRole("button", { name: "Workspace: Review" })).toHaveFocus());
      // Unfolded again, at the tab it opened from, wherever the move put it.
      view.rerender(<LayoutSwitch controller={controller} compact={false} />);
      expect(screen.getByRole("tab", { name: "Review" })).toHaveFocus();
    });

    it("still hands Rename to the name field from a context menu that outlived folding", async () => {
      const { controller } = setUp();
      const view = render(<LayoutSwitch controller={controller} compact={false} />);
      const menu = await keyboardMenuOf("Proofs");
      view.rerender(<LayoutSwitch controller={controller} compact />);
      fireEvent.click(menu.getByRole("menuitem", { name: "Rename" }));
      const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
      expect(field.value).toBe("Proofs");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(field).toHaveFocus();
    });

    it("returns from the folded menu, removed by unfolding, to the current workspace's tab", async () => {
      const { controller } = setUp();
      const view = render(<LayoutSwitch controller={controller} compact />);
      const trigger = screen.getByRole("button", { name: "Workspace: Review" });
      act(() => trigger.focus());
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const menu = await screen.findByRole("menu");
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
      view.rerender(<LayoutSwitch controller={controller} compact={false} />);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("tab", { name: "Review" })).toHaveFocus();
      // Folded again, its menu starts closed and the keyboard is on its button.
      view.rerender(<LayoutSwitch controller={controller} compact />);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("button", { name: "Workspace: Review" })).toHaveFocus();
    });

    it("leaves focus where a click outside a menu put it, through folding too", async () => {
      const { controller } = setUp();
      const view = render(<LayoutSwitch controller={controller} compact={false} />);
      await keyboardMenuOf("Review");
      view.rerender(<LayoutSwitch controller={controller} compact />);
      // Radix starts listening for a press outside a tick after opening.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(document.body).toHaveFocus();
      view.rerender(<LayoutSwitch controller={controller} compact={false} />);
      expect(document.body).toHaveFocus();
    });
  });

  it("names a copy made from the folded menu in place, without entering it", async () => {
    const { controller, library } = withWorkspaces();
    render(<LayoutSwitch controller={controller} compact />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Workspace: Workspace" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
    expect(field.value).toBe("Workspace copy");
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: "Proofs" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(library.list().map((entry) => entry.name)).toEqual(["Workspace", "Proofs"]);
    expect(controller.ui.get().workspace).toBe(library.list()[0].id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Workspace: Workspace" })).toHaveFocus());
  });

  it("moves a workspace left or right from its menu, keeping it focused and saying where it went", async () => {
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    library.add("Proofs", null);
    render(<LayoutSwitch controller={controller} compact={false} />);
    const menuOf = async (name: string) => {
      fireEvent.contextMenu(screen.getByRole("tab", { name }));
      return within(await screen.findByRole("menu"));
    };
    const moveBy = async (name: string, item: "Move left" | "Move right") => {
      fireEvent.click((await menuOf(name)).getByRole("menuitem", { name: item }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(screen.getByRole("tab", { name })).toHaveFocus());
    };
    // Neither past either end.
    expect((await menuOf("Workspace")).getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect((await menuOf("Proofs")).getByRole("menuitem", { name: "Move right" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await moveBy("Workspace", "Move right");
    expect(tabNames()).toEqual(["Review", "Workspace", "Proofs"]);
    expect(announced()).toHaveTextContent("Moved “Workspace” to position 2 of 3");
    // From the keyboard: Shift+F10 on the focused tab, then the item.
    const proofs = screen.getByRole("tab", { name: "Proofs" });
    proofs.focus();
    fireEvent.keyDown(proofs, { key: "F10", shiftKey: true });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move left" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(screen.getByRole("tab", { name: "Proofs" })).toHaveFocus());
    expect(tabNames()).toEqual(["Review", "Proofs", "Workspace"]);
    expect(announced()).toHaveTextContent("Moved “Proofs” to position 2 of 3");
    // The project stays where it was, and the order is the library's.
    expect(controller.ui.get().workspace).toBe(library.list()[2].id);
    expect(new TrellisController().workspaces.list().map((entry) => entry.name)).toEqual(["Review", "Proofs", "Workspace"]);
  });

  it("moves the workspace from the folded menu too, in either language", async () => {
    await activateAppLocale("zh-CN");
    const { controller, library } = withWorkspaces();
    library.add("Review", null);
    render(<LayoutSwitch controller={controller} compact />);
    const trigger = screen.getByRole("button", { name: "工作区：工作区" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "左移" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(menu.getByRole("menuitem", { name: "右移" }));
    expect(library.list().map((entry) => entry.name)).toEqual(["Review", "工作区"]);
    expect(announced()).toHaveTextContent("已将“工作区”移到第 2 位，共 2 个");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("folded, moves along the workspaces' button and the presets with the arrow keys, choosing each", () => {
    const { controller } = withWorkspaces();
    render(<LayoutSwitch controller={controller} compact />);
    const trigger = screen.getByRole("button", { name: "Workspace: Workspace" });
    const writing = screen.getByRole("tab", { name: "Writing" });
    const reading = screen.getByRole("tab", { name: "Reading" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    expect(writing).toHaveFocus();
    expect(controller.ui.get().preset).toBe("writing");
    fireEvent.keyDown(writing, { key: "ArrowRight" });
    expect(reading).toHaveFocus();
    expect(controller.ui.get().preset).toBe("reading");
    // Round to the workspace: it is chosen, not its menu opened.
    fireEvent.keyDown(reading, { key: "ArrowRight" });
    expect(trigger).toHaveFocus();
    expect(controller.ui.get().preset).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(trigger, { key: "End" });
    expect(reading).toHaveFocus();
    fireEvent.keyDown(reading, { key: "Home" });
    expect(trigger).toHaveFocus();
    expect(controller.ui.get().preset).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowLeft" });
    expect(reading).toHaveFocus();
  });

  it("reaches each of the first nine workspaces by position", () => {
    const { controller, library } = withWorkspaces();
    const review = library.add("Review", null);
    controller.switchWorkspaceAt(1);
    expect(controller.ui.get().workspace).toBe(review);
    controller.switchWorkspaceAt(5);
    expect(controller.ui.get().workspace).toBe(review);
  });
});
