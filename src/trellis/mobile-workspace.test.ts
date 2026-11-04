import { createWorkspace, layout as L, type WorkspaceHandle } from "@danfessler/trellis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { TrellisController } from "./trellis-controller";
import { installMobileWorkspace } from "./mobile-workspace";

vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => true }));
let ws: WorkspaceHandle;
let cleanup: () => void;
let media: EventTarget & { matches: boolean };
let controller: TrellisController;
beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(650);
  const parent = document.createElement("div");
  parent.className = "workspace trellis-workspace";
  const wrapper = document.createElement("div");
  wrapper.className = "lattice-trellis";
  const host = document.createElement("div");
  wrapper.append(host);
  parent.append(wrapper);
  document.body.append(parent);
  const mount = () => () => undefined;
  ws = createWorkspace(host, {
    navigation: "free", motion: "reduced",
    types: { project: { mount }, file: { mount }, pdf: { mount }, agent: { mount } },
    defaultLayout: L.row([
      L.panel({ id: "project-panel" }, L.view("project", { id: "project" })),
      L.panel({ id: "editor-panel" }, L.view("file", { id: "editor", params: { key: "main.tex" } })),
      L.panel({ id: "pdf-panel" }, L.view("pdf", { id: "pdf" })),
    ]),
  });
  controller = new TrellisController();
  controller.attachWorkspace(ws);
  controller.app.set({ activeKey: "main.tex" });
});
afterEach(() => {
  cleanup?.();
  ws.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("navigates real Trellis panels and restores desktop framing without replacing its arrangement", async () => {
  ws.navigation.frame("project-panel");
  const original = ws.getDocument();
  cleanup = installMobileWorkspace(controller, ws);
  const nav = document.querySelector(".mobile-workspace-nav")!;
  const workspace = document.querySelector(".workspace.trellis-workspace")!;
  expect(nav.parentElement).toBe(workspace);
  expect(workspace).toHaveClass("mobile-workspace");
  expect(document.querySelector(".lattice-trellis")?.nextElementSibling).toBe(nav);
  await waitFor(() => expect(ws.navigation.framed).toBe("editor-panel"));
  const editorSurface = ws.view("editor")!.element;
  fireEvent.click(document.querySelector(".mobile-workspace-nav button:nth-child(3)")!);
  expect(ws.navigation.framed).toBe("pdf-panel");
  expect(ws.getDocument().root).toEqual(original.root);
  expect(ws.view("editor")!.element).toBe(editorSurface);
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(ws.navigation.framed).toBe("project-panel");
  expect(document.querySelector(".mobile-workspace-nav")).toBeNull();
  expect(workspace).not.toHaveClass("mobile-workspace");
  expect(ws.getDocument().root).toEqual(original.root);
});
it("reflects dirty edits in a touch Save control and follows an explicit document reveal", async () => {
  const save = vi.fn().mockResolvedValue(true);
  controller.bridge = { save } as unknown as NonNullable<TrellisController["bridge"]>;
  cleanup = installMobileWorkspace(controller, ws);
  const saveButton = document.querySelector<HTMLButtonElement>(".mobile-workspace-nav button:nth-last-child(2)")!;
  expect(saveButton.disabled).toBe(true);
  controller.app.set({ activeDirty: true });
  fireEvent.click(saveButton);
  expect(save).toHaveBeenCalledOnce();
  ws.navigation.frame("pdf-panel");
  controller.app.set({ revealRequest: 1 });
  await waitFor(() => expect(ws.navigation.framed).toBe("editor-panel"));
});
