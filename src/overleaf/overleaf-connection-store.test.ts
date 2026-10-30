import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverleafConnectionStore, projectAccess } from "./overleaf-connection-store";

const ROOT = "/tmp/project";

describe("Overleaf connection store", () => {
  afterEach(() => localStorage.clear());

  it("starts disconnected with nothing linked, and keeps each window's store apart", () => {
    const store = createOverleafConnectionStore();
    expect(store.getState()).toMatchObject({
      linkFor: null, syncing: false, syncMode: "live", remoteDelete: "ask", remoteChanges: false,
      pickerOpen: false, reviewOpen: false, collabOpen: false, collabTab: "comments", conflictPath: null, selfId: null,
      status: "off", detail: null, liveFile: false, unacknowledged: false,
      projectPermission: { projectRoot: null, permission: "unknown" }, livePaths: [],
    });
    expect(store.getState().docs.size).toBe(0);
    store.getState().setStatus("live");
    expect(createOverleafConnectionStore().getState().status).toBe("off");
  });

  it("starts from the sync and remote-delete choices saved in Settings", () => {
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    localStorage.setItem("lattice.overleaf.remote-delete.v1", "never");
    expect(createOverleafConnectionStore().getState()).toMatchObject({ syncMode: "manual", remoteDelete: "never" });
  });

  it("lands every write at once, so async work reads the latest without waiting for a render", () => {
    const store = createOverleafConnectionStore();
    const { setSyncing, setProjectPermission, setCollabOpen } = store.getState();
    setSyncing(true);
    setProjectPermission({ projectRoot: ROOT, permission: "review" });
    setCollabOpen((open) => !open);
    expect(store.getState()).toMatchObject({
      syncing: true, collabOpen: true, projectPermission: { projectRoot: ROOT, permission: "review" },
    });
  });

  it("grants write access only for the project Overleaf named the role for, and fails closed", () => {
    const writer = { projectRoot: ROOT, permission: "readAndWrite" } as const;
    expect(projectAccess(writer, ROOT)).toEqual({ permission: "readAndWrite", canWrite: true });
    expect(projectAccess(writer, "/tmp/other")).toEqual({ permission: "unknown", canWrite: false });
    expect(projectAccess({ projectRoot: ROOT, permission: "review" }, ROOT).canWrite).toBe(false);
    expect(projectAccess(createOverleafConnectionStore().getState().projectPermission, ROOT).canWrite).toBe(false);
  });

  it("keys the channel's tree by path, with each entity's id and kind", () => {
    const store = createOverleafConnectionStore();
    store.getState().showDocumentTree(
      [{ id: "doc-a", path: "a.tex" }],
      [{ id: "doc-a", path: "a.tex", kind: "doc" }, { id: "file-1", path: "fig.png", kind: "file" }],
    );
    expect([...store.getState().docs]).toEqual([["a.tex", "doc-a"]]);
    expect(store.getState().entities.get("fig.png")).toEqual({ id: "file-1", kind: "file" });
    // A connect result without entities still names its documents.
    store.getState().showDocumentTree([{ id: "doc-b", path: "b.tex" }]);
    expect([...store.getState().docs]).toEqual([["b.tex", "doc-b"]]);
    expect(store.getState().entities.size).toBe(0);
  });

  it("keeps the live paths' array while the set is unchanged, so nothing re-renders", () => {
    const store = createOverleafConnectionStore();
    const { publishLivePaths } = store.getState();
    publishLivePaths(["a.tex", "b.tex"]);
    const published = store.getState().livePaths;
    const listener = vi.fn();
    store.subscribe((state, previous) => { if (state.livePaths !== previous.livePaths) listener(); });
    publishLivePaths(["a.tex", "b.tex"]);
    expect(store.getState().livePaths).toBe(published);
    expect(listener).not.toHaveBeenCalled();
    publishLivePaths(["a.tex"]);
    expect(store.getState().livePaths).toEqual(["a.tex"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows the channel's identity and tree for presence, and forgets both with the link", () => {
    const store = createOverleafConnectionStore();
    const { noteChannelEvent, forgetChannel } = store.getState();
    noteChannelEvent({ type: "connected", publicId: "me", projectRoot: ROOT });
    noteChannelEvent({ type: "treeChanged", docs: [{ id: "doc-a", path: "a.tex" }], entities: [], projectRoot: ROOT });
    expect(store.getState().selfId).toBe("me");
    expect([...store.getState().docPaths]).toEqual([["doc-a", "a.tex"]]);
    // A connection Overleaf has not named yet leaves the last id alone.
    noteChannelEvent({ type: "connected", publicId: "", projectRoot: ROOT });
    expect(store.getState().selfId).toBe("me");
    noteChannelEvent({ type: "disconnected", reason: "network", projectRoot: ROOT });
    expect(store.getState().selfId).toBeNull();
    expect(store.getState().docPaths.size).toBe(1);
    forgetChannel();
    expect(store.getState().docPaths.size).toBe(0);
  });
});
