import { describe, expect, it, vi } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis";
import { closeDocumentTab } from "./close-document-tab";
import { TrellisController } from "./trellis-controller";

type FakeView = { id: string; type: string; placement: "docked" | "hidden"; params?: { key: string } };

const VIEWS: FakeView[] = [
  { id: "project", type: "project", placement: "docked" },
  { id: "doc-main", type: "file", placement: "docked", params: { key: "main.tex" } },
  { id: "doc-refs", type: "file", placement: "docked", params: { key: "refs.bib" } },
  { id: "doc-old", type: "file", placement: "hidden", params: { key: "old.tex" } },
];

/** A controller on a workspace holding `views`, with `focusedView` focused and main.tex active. */
function controllerOn(views: FakeView[], focusedView: string | null) {
  const close = vi.fn(async () => true);
  const ws = {
    views: (filter?: { type?: string }) => views.filter((view) => !filter?.type || view.type === filter.type),
    getSnapshot: () => ({ focusedView }),
    close,
  };
  const controller = new TrellisController();
  controller.app.set({ activeKey: "main.tex" });
  controller.attachWorkspace(ws as unknown as WorkspaceHandle);
  return { controller, close };
}

describe("closeDocumentTab", () => {
  it("closes the focused document tab, else the active one, and never a panel that is not a document", () => {
    // Focus in the Project panel: the active document closes, not the panel.
    const inProject = controllerOn(VIEWS, "project");
    expect(closeDocumentTab(inProject.controller)).toBe(true);
    expect(inProject.close.mock.calls).toEqual([["doc-main"]]);

    const inRefs = controllerOn(VIEWS, "doc-refs");
    expect(closeDocumentTab(inRefs.controller)).toBe(true);
    expect(inRefs.close.mock.calls).toEqual([["doc-refs"]]);
  });

  it("closes nothing, so the window goes, once only a hidden document or none is left", () => {
    const onlyHidden = controllerOn([VIEWS[0], VIEWS[3]], "project");
    expect(closeDocumentTab(onlyHidden.controller)).toBe(false);
    expect(onlyHidden.close).not.toHaveBeenCalled();
    const noWorkspace = new TrellisController();
    expect(closeDocumentTab(noWorkspace)).toBe(false);
  });
});
