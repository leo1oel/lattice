import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewInfo } from "@danfessler/trellis";
import { paperTabKey } from "../app-utils";
import { paperPdfReading } from "../papers/paper-pdf-reading";
import { TrellisController } from "./trellis-controller";
import { besideTarget, openToTheSide } from "./open-beside";
import TrellisWorkspace from "./trellis-workspace";

vi.mock("../canvas/canvas-lazy-editors", () => ({
  PdfPreview: ({ url }: { url: string }) => <div className="stub-pdf" data-url={url} />,
  PdfPreviewLoading: () => null,
}));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const isReading = (key: string) => key.endsWith(".pdf");

describe("besideTarget", () => {
  const view = (id: string, panelId: string, marks: Partial<ViewInfo> = {}): ViewInfo => ({
    id, type: "file", params: { key: id }, title: id, panelId, placement: "docked", selected: true, ...marks,
  });

  it("prefers an empty document slot, then a panel showing a PDF, then any other document panel", () => {
    const views = [
      view("main.tex", "left"),
      view("notes.md", "middle"),
      view("a.pdf", "right"),
      view("slot-x", "spare", { type: "slot", params: {} }),
    ];
    expect(besideTarget(views, "left", isReading)).toBe("spare");
    expect(besideTarget(views.slice(0, 3), "left", isReading)).toBe("right");
    expect(besideTarget(views.slice(0, 2), "left", isReading)).toBe("middle");
  });

  it("never picks the panel asked from, a hidden panel, or a panel of something else", () => {
    const views = [
      view("main.tex", "left"),
      view("b.pdf", "left", { selected: false }),
      view("a.pdf", "hidden", { placement: "hidden" }),
      view("pdf", "pdf-panel", { type: "pdf", params: {} }),
    ];
    expect(besideTarget(views, "left", isReading)).toBeNull();
  });
});

/** A workspace with one document panel, beside the compiled PDF's, and App's side of opening a document. */
async function openProject(openTabs: string[]) {
  const controller = new TrellisController();
  controller.setBridge({
    tabKind: (key: string) => (key.endsWith(".pdf") ? "asset" : key.startsWith(".research/") ? "paper" : "file"),
    readPaper: async () => ({ path: ".research/papers/1706.03762/paper.md", text: "# Attention" }),
    tabLabel: (key: string) => key,
    activate: () => {},
    viewState: () => undefined,
    rememberViewState: () => {},
    readText: async () => "",
    readAsset: () => new Promise(() => {}),
    documentMode: () => "source",
    agentShown: () => {},
    openTool: () => {},
    panelMenu: () => [],
    shortcut: () => null,
    closeTab: async () => true,
  } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  controller.app.set({ projectRoot: "/p", activeKey: openTabs[0], openTabs, tabsReady: true });
  const view = render(<TrellisWorkspace controller={controller} projectRoot="/p" dark={false} focusMode={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(openTabs.length));
  const ws = controller.ws!;
  // As App opens a document: it becomes the active one, its tab added if new.
  const open = async (key: string) => {
    const { openTabs: tabs, activeKey, revealRequest } = controller.app.get();
    act(() => controller.app.set({
      openTabs: tabs.includes(key) ? tabs : [...tabs, key],
      activeKey: key,
      revealRequest: key === activeKey ? revealRequest + 1 : revealRequest,
    }));
    await act(async () => {});
  };
  const viewOf = (key: string) => ws.views({ type: "file" }).find((item) => item.params.key === key)!;
  const shownIn = (panelId: string) => ws.views().find((item) => item.panelId === panelId && item.selected)?.params.key;
  return { controller, ws, open, viewOf, shownIn, unmount: view.unmount };
}

describe("open to the side", () => {
  it("opens a PDF in a new split beside the document in front, which stays on screen", async () => {
    const { controller, ws, open, viewOf, shownIn } = await openProject(["main.tex"]);
    const from = viewOf("main.tex").panelId;
    openToTheSide(controller, "a.pdf");
    await open("a.pdf");
    const side = viewOf("a.pdf").panelId;
    expect(side).not.toBe(from);
    expect(shownIn(from)).toBe("main.tex");
    expect(shownIn(side)).toBe("a.pdf");
    // The compiled PDF keeps its own panel.
    expect(ws.view("pdf")?.panelId).not.toBe(side);
  });

  it("uses the other side once there is one: the next PDF joins the PDF already beside", async () => {
    const { controller, open, viewOf, shownIn } = await openProject(["main.tex"]);
    openToTheSide(controller, "a.pdf");
    await open("a.pdf");
    const side = viewOf("a.pdf").panelId;
    await open("main.tex");
    openToTheSide(controller, "b.pdf");
    await open("b.pdf");
    expect(viewOf("b.pdf").panelId).toBe(side);
    expect(shownIn(viewOf("main.tex").panelId)).toBe("main.tex");
  });

  it("moves a document already open in the panel in front to the side", async () => {
    const { controller, open, viewOf, shownIn } = await openProject(["main.tex", "a.pdf"]);
    const from = viewOf("main.tex").panelId;
    expect(viewOf("a.pdf").panelId).toBe(from);
    openToTheSide(controller, "a.pdf");
    await open("a.pdf");
    expect(viewOf("a.pdf").panelId).not.toBe(from);
    expect(shownIn(from)).toBe("main.tex");
  });

  it("leaves a plain open where it was, and drops an ask whose document never came", async () => {
    const { controller, open, viewOf } = await openProject(["main.tex"]);
    const from = viewOf("main.tex").panelId;
    await open("a.pdf");
    expect(viewOf("a.pdf").panelId).toBe(from);
    openToTheSide(controller, "b.pdf");
    await open("c.pdf");
    expect(viewOf("c.pdf").panelId).toBe(from);
    await open("b.pdf");
    expect(viewOf("b.pdf").panelId).toBe(from);
  });
});

describe("a Paper opened to the side", () => {
  const key = paperTabKey("1706.03762");
  // jsdom has no layout: the workspace host gets a window's box, so its panels are on screen.
  const natives = (["clientWidth", "clientHeight"] as const).map((axis) => [axis, Object.getOwnPropertyDescriptor(Element.prototype, axis)!] as const);
  beforeEach(() => {
    for (const [axis, native] of natives) {
      Object.defineProperty(Element.prototype, axis, {
        configurable: true,
        get(this: Element) { return this.hasAttribute("data-trellis-host") ? (axis === "clientWidth" ? 1440 : 900) : native.get!.call(this); },
      });
    }
  });
  afterEach(() => {
    for (const [axis, native] of natives) Object.defineProperty(Element.prototype, axis, native);
    paperPdfReading.set("1706.03762", null);
  });

  it("shows its original PDF beside the document in front while it is read as its PDF, and its text otherwise", async () => {
    const { controller, open } = await openProject(["main.tex"]);
    openToTheSide(controller, key);
    await open(key);
    act(() => paperPdfReading.set("1706.03762", {
      key: "https://arxiv.org/pdf/1706.03762", url: "https://arxiv.org/pdf/1706.03762", fileName: "1706.03762.pdf", generic: false, path: key,
    }));
    await open("main.tex");
    await waitFor(() => expect(document.querySelector(".stub-pdf")?.getAttribute("data-url")).toBe("https://arxiv.org/pdf/1706.03762"));
    expect(document.querySelector(".trellis-paper-snapshot")).toBeNull();
    act(() => paperPdfReading.set("1706.03762", null));
    await waitFor(() => expect(document.querySelector(".trellis-paper-snapshot")).not.toBeNull());
    expect(document.querySelector(".stub-pdf")).toBeNull();
  });
});
