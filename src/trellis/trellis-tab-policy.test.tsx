import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrellisController } from "./trellis-controller";
import { withTabItems } from "./trellis-document-tabs";
import { loadLayout } from "./trellis-layout";
import { chooseEvictions, type TabCandidate } from "./trellis-tab-policy";
import TrellisWorkspace from "./trellis-workspace";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("chooseEvictions", () => {
  const tab = (key: string, marks: Partial<TabCandidate> = {}): TabCandidate => ({ id: `v-${key}`, key, preview: false, pinned: false, ...marks });
  const used: Record<string, number> = { "a.tex": 3, "b.tex": 1, "c.tex": 2 };
  const lastUsed = (key: string) => used[key] ?? 0;
  const none = () => false;

  it("closes the least recently used tabs first, those never used in strip order before them", () => {
    const tabs = [tab("a.tex"), tab("b.tex"), tab("c.tex"), tab("x.tex"), tab("y.tex")];
    expect(chooseEvictions(tabs, 1, { held: none, lastUsed })).toEqual(["v-x.tex"]);
    expect(chooseEvictions(tabs, 4, { held: none, lastUsed })).toEqual(["v-x.tex", "v-y.tex", "v-b.tex", "v-c.tex"]);
  });

  it("never closes a pinned tab, a preview or a held one (the active document, the one coming in)", () => {
    const tabs = [tab("a.tex"), tab("b.tex", { pinned: true }), tab("c.tex", { preview: true }), tab("x.tex")];
    expect(chooseEvictions(tabs, 3, { held: (key) => key === "x.tex", lastUsed })).toEqual(["v-a.tex"]);
    expect(chooseEvictions(tabs, 1, { held: (key) => key === "a.tex" || key === "x.tex", lastUsed })).toEqual([]);
  });

  it("closes nothing when the strip has room", () => {
    expect(chooseEvictions([tab("a.tex")], 0, { held: none, lastUsed })).toEqual([]);
    expect(chooseEvictions([tab("a.tex")], -Infinity, { held: none, lastUsed })).toEqual([]);
  });
});

/**
 * A workspace with one document panel, and App's side of it: explicit opens
 * (a quick look first marks itself, as the tree and Quick open do) and the
 * closes Trellis reports.
 */
async function openProject(openTabs: string[]) {
  const controller = new TrellisController();
  const closed: string[] = [];
  controller.setBridge({
    tabKind: () => "file",
    tabLabel: (key: string) => key,
    activate: () => {},
    viewState: () => undefined,
    rememberViewState: () => {},
    readText: async () => "",
    documentMode: () => "source",
    agentShown: () => {},
    openTool: () => {},
    panelMenu: () => [],
    shortcut: () => null,
    closeTab: async (key: string) => {
      closed.push(key);
      const app = controller.app.get();
      controller.app.set({ openTabs: app.openTabs.filter((tab) => tab !== key) });
      return true;
    },
  } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  controller.app.set({ projectRoot: "/p", activeKey: openTabs[0], openTabs, tabsReady: true });
  const view = render(<TrellisWorkspace controller={controller} projectRoot="/p" dark={false} focusMode={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(openTabs.length));
  const ws = controller.ws!;
  const open = async (key: string, { quick = false } = {}) => {
    if (quick) controller.tabs.preview(key);
    const { openTabs: tabs, revealRequest } = controller.app.get();
    act(() => controller.app.set({ openTabs: tabs.includes(key) ? tabs : [...tabs, key], activeKey: key, revealRequest: revealRequest + 1 }));
    // Closes run through Trellis's close guard, a microtask later.
    await act(async () => {});
  };
  const viewOf = (key: string) => ws.views({ type: "file" }).find((item) => item.params.key === key);
  /** The document panel's tabs, in strip order. */
  const strip = () => {
    const panel = viewOf(controller.app.get().activeKey)!.panelId;
    const doc = ws.getDocument();
    const find = (node: typeof doc.root): string[] | null => {
      if (!node) return null;
      if (node.kind === "panel") return node.id === panel ? node.views : null;
      if (node.kind === "stage") return find(node.child ?? null);
      for (const child of node.children) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return find(doc.root)!.map((id) => String(doc.views[id]?.params?.key));
  };
  return { controller, ws, closed, open, viewOf, strip, unmount: view.unmount };
}

describe("a preview tab", () => {
  it("opens for a quick look, and the next quick look in its panel takes its place", async () => {
    const { closed, open, viewOf, strip } = await openProject(["main.tex", "notes.md"]);
    await open("a.tex", { quick: true });
    expect(viewOf("a.tex")?.params.preview).toBe(true);
    expect(strip()).toEqual(["main.tex", "notes.md", "a.tex"]);
    await open("b.tex", { quick: true });
    expect(closed).toEqual(["a.tex"]);
    expect(viewOf("a.tex")).toBeUndefined();
    expect(viewOf("b.tex")?.params.preview).toBe(true);
    expect(strip()).toEqual(["main.tex", "notes.md", "b.tex"]);
  });

  it("stays a preview when looked at again, and is kept when opened any other way", async () => {
    const { open, viewOf } = await openProject(["main.tex"]);
    await open("a.tex", { quick: true });
    await open("main.tex", { quick: true });
    await open("a.tex", { quick: true });
    expect(viewOf("a.tex")?.params.preview).toBe(true);
    // An agent, a build problem or a link opens it for work.
    await open("a.tex");
    expect(viewOf("a.tex")?.params.preview).toBe(false);
  });

  it("is kept by an edit, a double-click on its tab, or Keep open, and a kept tab is never replaced", async () => {
    const { controller, ws, closed, open, viewOf } = await openProject(["main.tex"]);
    await open("a.tex", { quick: true });
    act(() => controller.app.set({ activeDirty: true }));
    expect(viewOf("a.tex")?.params.preview).toBe(false);
    act(() => controller.app.set({ activeDirty: false }));

    await open("b.tex", { quick: true });
    const tab = ws.element.querySelector(`[data-trellis-part="tab"][data-view="${viewOf("b.tex")!.id}"]`)!;
    fireEvent.doubleClick(tab);
    expect(viewOf("b.tex")?.params.preview).toBe(false);

    await open("c.tex", { quick: true });
    const menu = withTabItems(controller, viewOf("c.tex") as never, []);
    const keep = menu.find((entry) => entry !== "separator" && entry.id === "keep-open");
    act(() => { if (keep !== "separator") keep?.run?.(); });
    expect(viewOf("c.tex")?.params.preview).toBe(false);

    await open("d.tex", { quick: true });
    expect(closed).toEqual([]);
    expect(viewOf("d.tex")?.params.preview).toBe(true);
  });

  it("whose quick look is kept before the file has opened (a double-click in the tree) opens kept", async () => {
    const { controller, open, viewOf } = await openProject(["main.tex"]);
    controller.tabs.preview("a.tex");
    controller.tabs.keep("a.tex");
    await open("a.tex");
    expect(viewOf("a.tex")?.params.preview).toBeFalsy();
  });

  it("and a pinned tab are saved with the layout and come back as they were", async () => {
    const first = await openProject(["main.tex"]);
    await first.open("a.tex", { quick: true });
    act(() => first.controller.tabs.setPinned(first.viewOf("main.tex")!.id, true));
    first.unmount();
    const views = Object.values(loadLayout("/p")!.document.views).filter((view) => view.type === "file");
    expect(views.map((view) => view.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "main.tex", pinned: true }),
      expect.objectContaining({ key: "a.tex", preview: true }),
    ]));
    cleanup();
    const again = await openProject(["main.tex", "a.tex"]);
    expect(again.viewOf("main.tex")?.params.pinned).toBe(true);
    expect(again.viewOf("a.tex")?.params.preview).toBe(true);
  });
});

describe("a panel out of room", () => {
  // jsdom lays nothing out: give the tab strips room for three tabs at their 100px minimum.
  const natives = {
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!,
    getClientRects: Element.prototype.getClientRects,
  };
  const isStrip = (element: Element) => element.getAttribute("data-trellis-part") === "tabs";
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) { return isStrip(this) ? 330 : natives.clientWidth.get!.call(this); },
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return isStrip(this) ? ([new DOMRect(0, 0, 330, 28)] as unknown as DOMRectList) : natives.getClientRects.call(this);
    });
  });
  afterEach(() => {
    Object.defineProperty(Element.prototype, "clientWidth", natives.clientWidth);
    vi.restoreAllMocks();
  });

  it("closes its least recently used tab for the one coming in", async () => {
    const { closed, open, viewOf, strip } = await openProject(["main.tex", "a.tex", "b.tex"]);
    await open("a.tex");
    await open("b.tex");
    await open("main.tex");
    await open("c.tex");
    expect(closed).toEqual(["a.tex"]);
    expect(strip()).toEqual(["main.tex", "b.tex", "c.tex"]);
    expect(viewOf("c.tex")?.params.preview).toBeFalsy();
  });

  it("never closes a pinned tab, a preview or the active document, and squeezes when none may go", async () => {
    const { controller, closed, open, viewOf, strip } = await openProject(["main.tex", "a.tex"]);
    await open("p.tex", { quick: true });
    act(() => controller.tabs.setPinned(viewOf("main.tex")!.id, true));
    act(() => controller.tabs.setPinned(viewOf("a.tex")!.id, true));
    // The preview is replaced in place, so a quick look needs no room.
    await open("q.tex", { quick: true });
    expect(closed).toEqual(["p.tex"]);
    await open("c.tex");
    expect(closed).toEqual(["p.tex"]);
    expect(strip()).toEqual(["main.tex", "a.tex", "q.tex", "c.tex"]);
  });

  it("leaves the tabs restored with the project alone", async () => {
    const { controller, closed, ws } = await openProject(["main.tex"]);
    act(() => controller.app.set({ openTabs: ["main.tex", "a.tex", "b.tex", "c.tex", "d.tex"] }));
    await act(async () => {});
    expect(ws.views({ type: "file" })).toHaveLength(5);
    expect(closed).toEqual([]);
  });
});
