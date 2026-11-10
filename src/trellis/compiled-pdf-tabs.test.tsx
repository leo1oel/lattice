import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, layout as L } from "@danfessler/trellis";
import { pdfTabLabel, ROOT_PDF, rootPdfId, slotOf } from "./compiled-pdf-tabs";
import { TrellisController } from "./trellis-controller";
import { defaultLayout, returnLayout } from "./trellis-layout";
import TrellisWorkspace from "./trellis-workspace";
import { arrangementOf, layoutShape } from "./trellis-workspaces";

vi.mock("../canvas/canvas-lazy-editors", () => ({
  PdfPreview: () => null,
  PdfPreviewLoading: () => null,
}));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("pdfTabLabel", () => {
  it("names a tab by its PDF, with the folder only when another tab's PDF has the same name", () => {
    expect(pdfTabLabel("main.tex", ["main.tex", "supplement/SI.tex"])).toBe("main.pdf");
    expect(pdfTabLabel("supplement/SI.tex", ["main.tex", "supplement/SI.tex"])).toBe("SI.pdf");
    expect(pdfTabLabel("cvpr/main.tex", ["cvpr/main.tex", "arxiv/main.tex"])).toBe("cvpr/main.pdf");
    expect(pdfTabLabel("a/b/main.tex", ["a/b/main.tex", "main.tex"])).toBe("b/main.pdf");
  });
});

/** A project whose workspace has the default layout: the live PDF alone in its panel. */
async function openProject() {
  const controller = new TrellisController();
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
    closeTab: async () => true,
  } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  controller.app.set({ projectRoot: "/p", activeKey: "main.tex", openTabs: ["main.tex"], tabsReady: true });
  const view = render(<TrellisWorkspace controller={controller} projectRoot="/p" dark={false} focusMode={false} />);
  await waitFor(() => expect(controller.ws?.views({ type: "file" })).toHaveLength(1));
  const ws = controller.ws!;
  const tabs = controller.pdfTabs;
  /** The PDF panel's tabs in order, by the document each shows ("live" for the live tab). */
  const strip = () => {
    const panel = slotOf(ws.getDocument(), "pdf")?.panel ?? ws.views({ type: ROOT_PDF })[0]?.panelId;
    return ws.views()
      .filter((item) => item.panelId === panel && (item.type === "pdf" || item.type === ROOT_PDF))
      .sort((a, b) => slotOf(ws.getDocument(), a.id)!.index - slotOf(ws.getDocument(), b.id)!.index)
      .map((item) => `${item.type === "pdf" ? "live" : String(item.params.document)}${item.selected ? "*" : ""}`);
  };
  const built = async (document: string, requested = false) => {
    act(() => tabs.shown("/p", document, { requested }));
    await act(async () => {});
  };
  return { controller, ws, tabs, strip, built, unmount: view.unmount };
}

describe("a PDF tab per compiled root document", () => {
  it("keeps the PDF panel as it was while one document is built", async () => {
    const { tabs, strip, built } = await openProject();
    await built("main.tex");
    await built("main.tex");
    expect(strip()).toEqual(["live*"]);
    expect(tabs.liveLabel()).toBeNull();
  });

  it("keeps the document built before in its own tab, named for its file, where the live tab stood", async () => {
    const { tabs, strip, built } = await openProject();
    await built("main.tex");
    await built("supplement/SI.tex");
    expect(strip()).toEqual(["main.tex", "live*"]);
    expect(tabs.liveLabel()).toBe("SI.pdf");
    expect(tabs.label("main.tex")).toBe("main.pdf");
  });

  it("updates a rebuilt document's own tab in its place, and keeps the reader on the tab they were reading", async () => {
    const { ws, strip, built } = await openProject();
    await built("main.tex");
    await built("supplement/SI.tex");
    // An autosave build of the manuscript while the supplement is read.
    await built("main.tex");
    expect(strip()).toEqual(["live", "supplement/SI.tex*"]);
    // Clicking the manuscript's tab and building the supplement on request brings its tab forward.
    act(() => ws.select("pdf"));
    await built("supplement/SI.tex", true);
    expect(strip()).toEqual(["main.tex", "live*"]);
  });

  it("shows a rebuilt document when its own tab was the one in front", async () => {
    const { ws, strip, built } = await openProject();
    await built("main.tex");
    await built("supplement/SI.tex");
    act(() => ws.select(rootPdfId("main.tex")));
    await built("main.tex");
    expect(strip()).toEqual(["live*", "supplement/SI.tex"]);
  });

  it("opens a third document's tab beside the live one, and keeps every tab's place and name", async () => {
    const { tabs, strip, built } = await openProject();
    await built("main.tex");
    await built("supplement/SI.tex");
    await built("figures/plot.tex");
    expect(strip()).toEqual(["main.tex", "supplement/SI.tex", "live*"]);
    expect(tabs.liveLabel()).toBe("plot.pdf");
    await built("main.tex");
    expect(strip()).toEqual(["live", "supplement/SI.tex", "figures/plot.tex*"]);
  });

  it("leaves a tab the writer closed closed through autosave's builds, until a build asked for", async () => {
    const { ws, strip, built } = await openProject();
    await built("main.tex");
    await built("supplement/SI.tex");
    // The writer closes the live tab (the supplement's).
    await act(async () => { await ws.close("pdf"); });
    expect(strip()).toEqual(["main.tex*"]);
    await built("supplement/SI.tex");
    expect(strip()).toEqual(["main.tex*"]);
    await built("supplement/SI.tex", true);
    expect(strip()).toEqual(["main.tex", "live*"]);
    // A closed tab of the document leaving is not brought back for it.
    await act(async () => { await ws.close(rootPdfId("main.tex")); });
    await built("figures/plot.tex");
    expect(strip()).toEqual(["supplement/SI.tex", "live*"]);
  });

  it("gives the live tab the place of a restored tab of the document now live", async () => {
    const { ws, tabs, strip } = await openProject();
    act(() => { ws.open(ROOT_PDF, { id: rootPdfId("SI.tex"), params: { document: "SI.tex" }, focus: false, placement: { into: slotOf(ws.getDocument(), "pdf")!.panel } }); });
    await act(async () => {});
    expect(strip()).toEqual(["live", "SI.tex*"]);
    act(() => tabs.shown("/p", "SI.tex"));
    await act(async () => {});
    expect(strip()).toEqual(["live*"]);
  });

  it("starts over in another project", async () => {
    const { ws, tabs, strip, built } = await openProject();
    await built("main.tex");
    await act(async () => { await ws.close("pdf"); });
    act(() => tabs.shown("/q", "main.tex"));
    await act(async () => {});
    expect(strip()).toEqual([]);
    expect(ws.view("pdf")).toBeNull();
  });
});

describe("the compiled documents' tabs in layouts", () => {
  const withTabs = () => createDocument(
    L.row([
      L.panel({ id: "panel-docs" }, L.view("file", { id: "file-main", params: { key: "main.tex" } })),
      L.panel({ id: "panel-pdf" }, L.view(ROOT_PDF, { id: rootPdfId("main.tex"), params: { document: "main.tex" } }), L.view("pdf", { id: "pdf" })),
    ], [0.5, 0.5]),
  );

  it("are the project's, never part of a named workspace's arrangement", () => {
    const arrangement = arrangementOf(withTabs());
    expect(Object.values(arrangement.views).some((record) => record.type === ROOT_PDF)).toBe(false);
    expect(layoutShape(arrangement)).toContain("pdf");
  });

  it("join the live PDF's panel when one was opened during a preset", () => {
    const previous = createDocument(L.row([
      L.panel({ id: "panel-docs" }, L.view("file", { id: "file-main", params: { key: "main.tex" } })),
      L.panel({ id: "panel-pdf" }, L.view("pdf", { id: "pdf" })),
    ], [0.5, 0.5]));
    const back = returnLayout(previous, withTabs(), { activeKey: "main.tex", openTabs: ["main.tex"] });
    expect(slotOf(back, rootPdfId("main.tex"))?.panel).toBe("panel-pdf");
    expect(slotOf(back, "file-main")?.panel).toBe("panel-docs");
    expect(defaultLayout().views.pdf.type).toBe("pdf");
  });
});
