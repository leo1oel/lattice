import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDocument } from "@danfessler/trellis";
import { defaultLayout, withDocumentPanel } from "./trellis-layout";
import { arrangementOf, isDocumentSlot, WorkspaceLibrary } from "./trellis-workspaces";

beforeEach(() => localStorage.clear());

/** The default layout with `keys` open in one document panel. */
function withDocuments(keys: string[]): LayoutDocument {
  let doc = withDocumentPanel(defaultLayout(), { id: "doc-0", key: keys[0] }, { after: ["panel-project"] });
  keys.slice(1).forEach((key, index) => {
    const id = `doc-${index + 1}`;
    doc = { ...doc, views: { ...doc.views, [id]: { type: "file", params: { key } } } };
    const panel = (doc.root as { children: Array<{ id: string; views: string[] }> }).children.find((child) => child.id === "panel-doc-0")!;
    panel.views.push(id);
  });
  return doc;
}

describe("a workspace's arrangement", () => {
  it("keeps one slot where a panel's documents stood, and no documents", () => {
    const arrangement = arrangementOf(withDocuments(["main.tex", "notes.md"]));
    const documentViews = Object.entries(arrangement.views).filter(([, record]) => record.type === "file" || record.type === "slot");
    expect(documentViews).toEqual([["slot-panel-doc-0", { type: "slot", params: {} }]]);
    expect(isDocumentSlot(arrangement.views["slot-panel-doc-0"])).toBe(true);
    expect(JSON.stringify(arrangement)).not.toMatch(/main\.tex|notes\.md/);
    const panel = (arrangement.root as { children: Array<{ id: string; views: string[]; selected: string }> }).children[1];
    expect(panel).toMatchObject({ id: "panel-doc-0", views: ["slot-panel-doc-0"], selected: "slot-panel-doc-0" });
  });
});

describe("the workspace library", () => {
  it("starts with one workspace named Workspace, on the default layout until it is used", () => {
    const library = new WorkspaceLibrary();
    expect(library.list().map((entry) => entry.name)).toEqual(["Workspace"]);
    expect(library.get(library.recent())?.arrangement).toBeNull();
    // Persisted: another library (another window, the next launch) reads the same one.
    expect(new WorkspaceLibrary().list()).toEqual(library.list());
  });

  it("keeps names short, unique and non-empty", () => {
    const library = new WorkspaceLibrary();
    const [first] = library.list();
    const second = library.add("Workspace", null, first.id);
    expect(library.get(second)?.name).toBe("Workspace 2");
    expect(library.rename(second, "  workspace ")).toBe("taken");
    expect(library.rename(second, "   ")).toBe("empty");
    expect(library.rename(second, "Drafting with a very long name indeed")).toBe("renamed");
    expect(library.get(second)?.name).toBe("Drafting with a very lon");
    expect(library.uniqueName("Drafting with a very long name indeed")).toBe("Drafting with a very l 2");
  });

  it("tells the titlebar about a change of list, not of arrangement", () => {
    const library = new WorkspaceLibrary();
    const listener = vi.fn();
    library.subscribe(listener);
    const before = library.list();
    library.setArrangement(before[0].id, arrangementOf(defaultLayout()));
    expect(listener).not.toHaveBeenCalled();
    expect(library.list()).toBe(before);
    library.add("Review", null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(library.list()).not.toBe(before);
  });

  it("duplicates after the original, moves, and never deletes the last workspace", () => {
    const library = new WorkspaceLibrary();
    const [first] = library.list();
    library.setArrangement(first.id, arrangementOf(defaultLayout()));
    const review = library.add("Review", null);
    const copy = library.duplicate(first.id, "Workspace copy")!;
    expect(library.list().map((entry) => entry.name)).toEqual(["Workspace", "Workspace copy", "Review"]);
    expect(library.get(copy)?.arrangement).toEqual(library.get(first.id)?.arrangement);
    expect(library.get(copy)?.arrangement).not.toBe(library.get(first.id)?.arrangement);
    library.move(review, 0);
    expect(library.list().map((entry) => entry.name)).toEqual(["Review", "Workspace", "Workspace copy"]);
    const removed = library.remove(first.id)!;
    library.remove(copy);
    expect(library.remove(review)).toBeNull();
    library.restore(removed);
    expect(library.list().map((entry) => entry.name)).toEqual(["Review", "Workspace"]);
  });
});
