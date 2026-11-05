import { afterEach, expect, it, vi } from "vitest";
import { createWorkspace, layout as L, type WorkspaceHandle } from "@danfessler/trellis";

let ws: WorkspaceHandle | undefined;
afterEach(() => {
  ws?.destroy();
  ws = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The Trellis patch's header fit (patches/@danfessler__trellis@0.2.0.patch)
// re-lays the document out when a panel's measured header minimum changes.
// Without a nav.sync() after that relayout, a panel framed before the change
// keeps the camera on its old rect and drifts out of a narrow window.
// Adapted from knightnemo's https://github.com/leo1oel/lattice/pull/614.
// Desktop uses navigation "free" (trellis-workspace.tsx); the PR's original
// case used "focus". Both widths below fail without the fix.
it.each([
  { navigation: "free" as const, width: 390 },
  { navigation: "free" as const, width: 700 },
  { navigation: "focus" as const, width: 390 },
])("keeps the framed editor inside a $width px viewport ($navigation navigation) after a new tab changes its measured header minimum", ({ navigation, width: viewport }) => {
  let now = 0;
  let next = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const advance = () => {
    for (let tick = 0; tick < 8; tick++) {
      now += 16;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(now));
    }
  };
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(viewport);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(650);
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, viewport, 28)] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    const part = element.dataset.trellisPart;
    const panel = element.closest<HTMLElement>("[data-trellis-part=panel]");
    const width = Number.parseFloat(panel?.style.width ?? "") || viewport;
    // Real header fitting reads DOM measurements after mounting another tab.
    // The wider action row raises contentMin, redistributing the underlying
    // split after navigation has already framed the editor's previous rect.
    const chrome = panel?.querySelectorAll("[data-trellis-part=tab]").length === 2 ? 300 : 60;
    const measured = part === "tabbar" ? width : part === "tabs" ? width - chrome : part === "tab" ? 120 : part === "tab-title" ? 60 : width;
    return new DOMRect(0, 0, measured, 28);
  });
  const css = document.createElement("style");
  css.textContent = '[data-trellis-part="tab"] { min-width: 80px; }';
  const host = document.createElement("div");
  document.body.append(css, host);
  const mount = () => () => undefined;
  ws = createWorkspace(host, {
    motion: "reduced", navigation,
    types: { file: { minSize: { width: 180, height: 140 }, scaling: false, mount }, project: { singleton: true, mount } },
    defaultLayout: L.row([
      L.panel({ id: "project-panel" }, L.view("project", { id: "project" })),
      L.panel({ id: "editor-panel" }, L.view("file", { id: "first" })),
    ]),
  });
  advance();
  ws.navigation.frame("editor-panel");
  advance();
  const original = ws.getDocument().root;
  ws.open("file", { id: "second", placement: { into: "editor-panel" }, focus: false });
  advance();
  const layout = ws.getLayoutRects().get("editor-panel")!.rect;
  expect(ws.navigation.camera).toEqual(layout);
  const panel = host.querySelector<HTMLElement>('[data-trellis-part="panel"][data-panel="editor-panel"]')!;
  expect(Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(viewport);
  expect(ws.getDocument().root?.kind).toBe(original?.kind);
  if (original?.kind === "split") expect(ws.getDocument().root).toMatchObject({ weights: original.weights });
});
