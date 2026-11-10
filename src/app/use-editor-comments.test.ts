import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { notifyInfo } from "../telemetry/app-notify";
import { showError } from "./notify";
import { anchorCitationReasons, createCitationReason } from "../editor/latex/citation-reasons";
import { useEditorComments } from "./use-editor-comments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(notifyInfo).mockReset();
  vi.mocked(showError).mockReset();
});

const comment = (id: string): EditorComment => ({
  id, path: "main.tex", from: 0, to: 5, quote: "alpha", prefix: "", suffix: "",
  body: `Note ${id}`, authorId: "me", authorName: "Me", resolved: false, replies: [],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});

/** The comment list over one project, not linked to Overleaf, holding `initial` once loaded. */
async function renderComments(initial: EditorComment[]) {
  vi.mocked(invoke).mockImplementation(async (command) => (command === "list_annotations" ? { annotations: initial, rounds: [] } : undefined));
  const project = { root: "/project" } as unknown as ProjectSnapshot;
  const projectRootRef = { current: "/project" as string | null };
  const overleaf = {
    overleafLink: null,
    overleafComments: { threads: [], anchors: new Map() },
    overleafCommentsRef: { current: { threads: [] } },
    overleafDocPaths: new Map(),
    overleafRealtime: { docId: null, liveFile: null },
    overleafEditorComments: [],
    setOverleafCollabOpen: vi.fn(),
    setOverleafCollabTab: vi.fn(),
  } as unknown as Parameters<typeof useEditorComments>[0]["overleaf"];
  const activeFileRef = { current: "" };
  const openProjectFile = vi.fn(async (path: string) => {
    activeFileRef.current = path;
  });
  const view = renderHook(() => useEditorComments({
    project, projectRootRef, activeFileRef, openProjectFile, overleaf, author: { id: "me", name: "Me" },
    openSources: () => new Map(), agentOptionsRef: { current: null },
  }));
  await act(() => view.result.current.load());
  return { view, projectRootRef, activeFileRef, openProjectFile };
}

const saved = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_annotations")
  .map(([, args]) => (args as { annotations: EditorComment[] }).annotations.map((item) => item.id));
const ids = (comments: EditorComment[]) => comments.map((item) => item.id);

/** The Undo on the toast the last delete raised. */
function lastUndo() {
  const options = vi.mocked(notifyInfo).mock.calls.at(-1)?.[2];
  return () => options?.primaryAction?.onClick();
}

it("deletes a comment at once and its undo puts it back where it was, keeping later changes", async () => {
  const { view } = await renderComments([comment("a"), comment("b"), comment("c")]);
  act(() => view.result.current.deleteComment("b"));
  expect(ids(view.result.current.comments)).toEqual(["a", "c"]);
  const undo = lastUndo();

  // Something else changes before the undo; the undo must not lose it.
  act(() => view.result.current.create(comment("d"), vi.fn()));
  act(() => undo());
  expect(ids(view.result.current.comments)).toEqual(["a", "b", "c", "d"]);
  expect(saved().at(-1)).toEqual(["a", "b", "c", "d"]);
});

it("does nothing on undo once another project is open, or for a comment that is not there", async () => {
  const { view, projectRootRef } = await renderComments([comment("a")]);
  act(() => view.result.current.deleteComment("missing"));
  expect(notifyInfo).not.toHaveBeenCalled();

  act(() => view.result.current.deleteComment("a"));
  const undo = lastUndo();
  const saves = saved().length;
  projectRootRef.current = "/other";
  act(() => undo());
  expect(saved()).toHaveLength(saves);
  expect(view.result.current.comments).toEqual([]);
});

it("opens a comment's file and asks the editor to focus it, unless a newer comment was opened first", async () => {
  const { view, openProjectFile } = await renderComments([comment("a"), { ...comment("b"), path: "intro.tex" }]);
  await act(async () => view.result.current.openComment(view.result.current.comments[0]));
  // The focus places the editor, so the file's remembered position must not land after it.
  expect(openProjectFile).toHaveBeenCalledWith("main.tex", { restoreView: false });
  expect(view.result.current.activeId).toBe("a");
  const request = view.result.current.focusRequest;
  expect(request?.id).toBe("a");
  act(() => view.result.current.focusHandled(request!.nonce));
  expect(view.result.current.focusRequest).toBeNull();

  let finishFirst: () => void = () => undefined;
  openProjectFile.mockImplementationOnce(() => new Promise((resolve) => {
    finishFirst = resolve;
  }));
  act(() => view.result.current.openComment(view.result.current.comments[0]));
  await act(async () => view.result.current.openComment(view.result.current.comments[1]));
  expect(view.result.current.focusRequest?.id).toBe("b");
  await act(async () => finishFirst());
  expect(view.result.current.focusRequest?.id).toBe("b");
  expect(view.result.current.activeId).toBe("b");
});

it("resolves and reopens from the panel with a toast whose undo puts it back", async () => {
  const { view, projectRootRef } = await renderComments([comment("a")]);
  act(() => view.result.current.toggleResolved("a"));
  expect(view.result.current.comments[0]?.resolved).toBe(true);
  expect(vi.mocked(notifyInfo).mock.calls.at(-1)?.slice(0, 2)).toEqual(["Comments", "Comment resolved"]);
  act(lastUndo());
  expect(view.result.current.comments[0]?.resolved).toBe(false);

  act(() => view.result.current.resolve("a"));
  act(() => view.result.current.toggleResolved("a"));
  expect(view.result.current.comments[0]?.resolved).toBe(false);
  expect(vi.mocked(notifyInfo).mock.calls.at(-1)?.[1]).toBe("Comment reopened");
  const undo = lastUndo();
  act(undo);
  expect(view.result.current.comments[0]?.resolved).toBe(true);

  // Undo belongs to the project it happened in.
  act(() => view.result.current.toggleResolved("a"));
  const later = lastUndo();
  projectRootRef.current = "/other";
  act(later);
  expect(view.result.current.comments[0]?.resolved).toBe(false);
});

// A note made on the PDF of a linked project is an Overleaf comment, which
// Overleaf takes only on the document the live channel holds.
it("sends a PDF note to Overleaf only for the live file, and keeps one for a file Overleaf lacks", () => {
  const destinationIn = (docPaths: Map<string, string>, realtime: { status: string; docId: string | null; liveFile: boolean }, linked = true) => {
    const overleaf = {
      overleafLink: linked ? { projectId: "p" } : null, overleafComments: { threads: [], anchors: new Map() },
      overleafCommentsRef: { current: { threads: [] } }, overleafDocPaths: docPaths, overleafRealtime: realtime,
      overleafEditorComments: [], setOverleafCollabOpen: vi.fn(), setOverleafCollabTab: vi.fn(),
    } as unknown as Parameters<typeof useEditorComments>[0]["overleaf"];
    const { result } = renderHook(() => useEditorComments({
      project: { root: "/project" } as unknown as ProjectSnapshot, projectRootRef: { current: "/project" },
      activeFileRef: { current: "main_v2.tex" }, openProjectFile: vi.fn(), overleaf, author: { id: "me", name: "Me" },
      openSources: () => new Map(), agentOptionsRef: { current: null },
    }));
    return result.current.destination;
  };
  const docs = new Map([["doc-v2", "main_v2.tex"], ["doc-intro", "intro.tex"]]);
  const live = destinationIn(docs, { status: "live", docId: "doc-v2", liveFile: true });
  expect(live("main_v2.tex")).toBe("overleaf");
  expect(live("intro.tex")).toBe("other-file");
  // Connected, with a tab Overleaf cannot edit live open (an image, a Paper): open the file, not reconnect.
  expect(destinationIn(docs, { status: "live", docId: null, liveFile: false })("main_v2.tex")).toBe("other-file");
  // A file Overleaf does not have stays an annotation here, as in the editor.
  expect(live("notes.tex")).toBe("annotation");
  // Disconnected, or connected before the channel named its documents: never quietly kept here.
  expect(destinationIn(docs, { status: "error", docId: null, liveFile: false })("main_v2.tex")).toBe("offline");
  expect(destinationIn(new Map(), { status: "connecting", docId: null, liveFile: false })("main_v2.tex")).toBe("offline");
  expect(destinationIn(docs, { status: "live", docId: "doc-v2", liveFile: true }, false)("main_v2.tex")).toBe("annotation");
});

// Reported: a comment on a Markdown file the Agent had just
// rewritten was refused with "not live with Overleaf, reconnect". The editor
// had let go of the file until a sync settled the Agent's write; Overleaf
// takes the comment anyway, on a connection of the backend's own. Nothing
// here depends on the file type: a .tex file in the same state is the same.
describe.each(["cvpr/outline.md", "sections/intro.tex"])("an editor comment on %s, linked to Overleaf", (path) => {
  const source = "The reader sees every visual token.\n";
  const from = source.indexOf("visual token");
  const note = { ...comment("new"), path, from, to: from + 12, quote: "visual token", body: "Name the encoder." };
  const target = { projectRoot: "/project", docId: "doc", path };
  const name = path.split("/").pop();
  const sending = { saving: `Commenting on ${name} on Overleaf…`, error: null };
  const waiting = { saving: `Waiting for ${name} to finish syncing with Overleaf…`, error: null };
  afterEach(() => vi.useRealTimers());

  /** The comment store over a project whose channel is in `realtime`, and whose sync owes `path` while `owed` holds. */
  function commentsOn(realtime: { status: string; docId: string | null; liveFile: boolean }, owed = { current: false }) {
    const comments = { create: vi.fn(async () => "thread"), createInDocument: vi.fn(async (): Promise<"placed" | "notFound"> => "placed") };
    const overleaf = {
      overleafLink: { projectId: "p" }, overleafComments: { threads: [], anchors: new Map(), ...comments },
      overleafCommentsRef: { current: { threads: [] } }, overleafDocPaths: new Map([["doc", path]]), overleafRealtime: realtime,
      overleafEditorComments: [], setOverleafCollabOpen: vi.fn(), setOverleafCollabTab: vi.fn(),
      overleafSyncOwed: (owedPath: string) => owedPath === path && owed.current,
    } as unknown as Parameters<typeof useEditorComments>[0]["overleaf"];
    const store = renderHook(() => useEditorComments({
      project: { root: "/project" } as unknown as ProjectSnapshot, projectRootRef: { current: "/project" },
      activeFileRef: { current: path }, openProjectFile: vi.fn(), overleaf, author: { id: "me", name: "Me" },
      openSources: () => new Map([[path, source]]), agentOptionsRef: { current: null },
    })).result.current;
    return { store, comments };
  }
  const handedToSync = { status: "live", docId: null, liveFile: false };

  it("anchors it in the editor's own document while the editor holds it live, holding the composer until Overleaf has it", async () => {
    const { store, comments } = commentsOn({ status: "live", docId: "doc", liveFile: true });
    const report = vi.fn();
    await act(async () => { expect(store.create(note, report)).toBe("overleaf"); });
    expect(comments.create).toHaveBeenCalledWith(target, from, "visual token", "Name the encoder.");
    expect(report.mock.calls).toEqual([[sending], [null]]);
  });

  it("posts it through the backend when the editor let go of the file, or while the channel reconnects", async () => {
    for (const realtime of [handedToSync, { status: "connecting", docId: null, liveFile: false }]) {
      const { store, comments } = commentsOn(realtime);
      const report = vi.fn();
      await act(async () => { expect(store.create(note, report)).toBe("overleaf"); });
      expect(comments.createInDocument).toHaveBeenCalledWith(target, source, from, "visual token", "Name the encoder.");
      expect(report.mock.calls).toEqual([[sending], [null]]);
    }
    expect(showError).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("save_annotations", expect.anything());
  });

  it("waits for the sync owed the file when Overleaf's copy does not hold the passage yet, then places it", async () => {
    vi.useFakeTimers();
    const owed = { current: true };
    const { store, comments } = commentsOn(handedToSync, owed);
    comments.createInDocument.mockImplementation(async () => (owed.current ? "notFound" : "placed"));
    const report = vi.fn();
    await act(async () => { store.create(note, report); });
    expect(report.mock.calls).toEqual([[sending], [waiting]]);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(comments.createInDocument).toHaveBeenCalledTimes(1);
    owed.current = false;
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(comments.createInDocument).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it("says what went wrong, keeping the composer, when the comment cannot land", async () => {
    vi.useFakeTimers();
    const { store, comments } = commentsOn(handedToSync, { current: true });
    comments.createInDocument.mockResolvedValue("notFound");
    const report = vi.fn();
    await act(async () => { store.create(note, report); });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(comments.createInDocument).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({
      saving: null, error: `${name} is still syncing with Overleaf, so your comment is not on it yet. Try again once the sync finishes.`,
    });

    const settled = commentsOn(handedToSync);
    settled.comments.createInDocument.mockResolvedValue("notFound");
    await act(async () => { settled.store.create(note, report); });
    expect(settled.comments.createInDocument).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({
      saving: null,
      error: `Your comment on ${name} did not reach Overleaf: its copy reads differently around the selected text, which changed here since the last sync. Try again once the file has synced.`,
    });

    const unreachable = commentsOn({ status: "connecting", docId: null, liveFile: false });
    unreachable.comments.createInDocument.mockRejectedValue(new Error("Overleaf could not be reached."));
    await act(async () => { unreachable.store.create(note, report); });
    expect(report).toHaveBeenLastCalledWith({ saving: null, error: `Your comment on ${name} did not reach Overleaf: Overleaf could not be reached.` });
    expect(showError).not.toHaveBeenCalled();
  });
});

// A save replaces the whole of annotations.json, so state that was never read
// from it must not be saved over it (implicit-state audit S1).
it("saves nothing until the project's annotations have been read", async () => {
  const { view } = await renderComments([comment("old-1"), comment("old-2")]);
  act(() => view.result.current.reset());
  let created: ReturnType<typeof view.result.current.create> = comment("x");
  act(() => {
    created = view.result.current.create(comment("new"), vi.fn());
  });
  expect(created).toBeNull();
  expect(saved()).toEqual([]);
  expect(view.result.current.comments).toEqual([]);
  expect(showError).toHaveBeenLastCalledWith("This project's annotations are still being read. Try again in a moment.");

  await act(() => view.result.current.load());
  act(() => view.result.current.create(comment("new"), vi.fn()));
  expect(saved().at(-1)).toEqual(["old-1", "old-2", "new"]);
});

it("keeps a file it cannot read unsaved and says why, rather than reading it as empty", async () => {
  const { view } = await renderComments([comment("old-1")]);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_annotations") throw new Error("expected value at line 1 column 1");
    return undefined;
  });
  act(() => view.result.current.reset());
  await act(() => view.result.current.load());
  expect(showError).toHaveBeenLastCalledWith(
    "This project's annotations could not be read, so changes to them are not saved: expected value at line 1 column 1",
  );
  act(() => {
    view.result.current.create(comment("new"), vi.fn());
  });
  expect(saved()).toEqual([]);
  expect(view.result.current.comments).toEqual([]);
});

it("drops a read that lands after another project opened", async () => {
  const { view, projectRootRef } = await renderComments([]);
  let answer: (value: unknown) => void = () => undefined;
  vi.mocked(invoke).mockImplementation((command) => (command === "list_annotations"
    ? new Promise((resolve) => { answer = resolve; })
    : Promise.resolve(undefined)));
  act(() => view.result.current.reset());
  const loading = view.result.current.load();
  // Entering another project resets the store before its own read.
  projectRootRef.current = "/other";
  act(() => view.result.current.reset());
  await act(async () => {
    answer({ annotations: [comment("stale")], rounds: [] });
    await loading;
  });
  act(() => {
    view.result.current.create(comment("new"), vi.fn());
  });
  expect(saved()).toEqual([]);
  expect(view.result.current.comments).toEqual([]);
});

it("moves the reasons on a renamed citation key to the new key, keeping where they sit", async () => {
  const source = "Holds \\cite{Smith2020}; see \\cite{jones2019}.";
  const reasonOn = (key: string, from: number) => createCitationReason({
    path: "main.tex", source, site: { from, to: from + key.length, key }, role: "supporting", body: "",
    authorId: "me", authorName: "Me",
  })!;
  const smith = reasonOn("Smith2020", 12);
  const jones = reasonOn("jones2019", 34);
  const { view } = await renderComments([comment("plain"), smith, jones]);
  act(() => view.result.current.renameCitationKey("smith2020", "smith2020a"));

  const after = view.result.current.citationReasons;
  const renamed = after.find((item) => item.id === smith.id)!;
  expect(renamed.citation).toEqual({ key: "smith2020a", role: "supporting" });
  expect(renamed).toMatchObject({ from: smith.from, to: smith.to, prefix: smith.prefix, suffix: smith.suffix });
  expect(after.find((item) => item.id === jones.id)).toEqual(jones);
  expect(view.result.current.comments.map((item) => item.id)).toEqual(["plain"]);
  // The renamed file still places it on its cite, rather than orphaning it.
  const renamedSource = source.replace("Smith2020", "smith2020a");
  expect(anchorCitationReasons(renamedSource, "main.tex", after).get(smith.id)?.key).toBe("smith2020a");
  expect(saved().at(-1)).toEqual(["plain", smith.id, jones.id]);
});

it("counts the panel's open orphaned citation reasons in the toolbar's open notes", async () => {
  const { view } = await renderComments([comment("a"), { ...comment("b"), resolved: true }]);
  expect(view.result.current.unresolved).toBe(1);
  act(() => view.result.current.setOpenOrphans(2));
  expect(view.result.current.unresolved).toBe(3);
});

it("drops, without an error, an editor's last anchor save that arrives after the project's annotations were let go", async () => {
  const source = "Holds \\cite{smith2020}.";
  const reason = createCitationReason({
    path: "main.tex", source, site: { from: 12, to: 21, key: "smith2020" }, role: "supporting", body: "",
    authorId: "me", authorName: "Me",
  })!;
  const { view } = await renderComments([reason]);
  const saves = saved().length;
  // Switching projects lets the old annotations go before the old editor is torn down and flushes.
  act(() => view.result.current.reset());
  act(() => view.result.current.reanchorCitationReasons(new Map([[reason.id, { from: 12, to: 21, quote: "smith2020", prefix: "x", suffix: "y" }]])));
  expect(showError).not.toHaveBeenCalled();
  expect(saved().length).toBe(saves);
});
