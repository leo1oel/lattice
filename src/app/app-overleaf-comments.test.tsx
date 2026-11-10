import {
  deferred, dirNode, fileNode, invokeCalls, MAIN_DOCUMENT, overleafProbe, overleafSession, overleafSyncResult, persistLayout, projectSnapshot,
  visualEditorOf, emitTauriEvent, expectInvoked, type Commands,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { formatAppLogs } from "../telemetry/app-log-store";

const { renderOverleafPaper } = appHarness({ documentCanvas });

const ROOT = "/tmp/lattice-overleaf-comments";
const OUTLINE = "cvpr/outline.md";
const DOCS = [{ id: "main", path: "main.tex" }, { id: "outline", path: OUTLINE }];
const QUOTE = "visual token";
const BODY = "Name the encoder here.";

type CommentArgs = { docId: string; quote: string };

/** Overleaf places a comment only on words its copy holds. */
const placedIfHeld = ({ docId, quote }: CommentArgs, remote: Record<string, string>) => (
  remote[DOCS.find((doc) => doc.id === docId)!.path].includes(quote) ? "placed" : "notFound"
);

/**
 * A live-synced project with the outline open, which the Agent rewrites on
 * disk; the outline's sync to Overleaf waits for `upload`. `remote` is
 * Overleaf's copy of each file: what joining its document reads, and what the
 * sync replaces with Lattice's text once it is let through. With
 * `syncedFirst`, an automatic sync, let through at once, ran just before.
 */
async function rewriteOpenOutline(
  commentInDocument: (args: CommentArgs, remote: Record<string, string>) => unknown, { syncedFirst = false } = {},
) {
  const files: Record<string, string> = {
    "main.tex": "\\documentclass{article}",
    [OUTLINE]: "# Outline\n\nThe reader sees every token.\n",
  };
  const remote = { ...files };
  const mtimes: Record<string, number> = { "main.tex": 1, [OUTLINE]: 1 };
  const pathOf = (args: unknown) => (args as { path: string }).path;
  const byId = Object.fromEntries(DOCS.map((doc) => [doc.id, doc.path]));
  const upload = deferred();
  if (syncedFirst) upload.resolve();
  let probes = 0;
  const commands: Commands = {
    read_project_file: (args) => files[pathOf(args)] ?? "",
    stat_project_file: (args) => ({ exists: true, mtimeMs: mtimes[pathOf(args)] ?? 1, fileId: pathOf(args) }),
    write_project_file: (args) => {
      const { path, content } = args as { path: string; content: string };
      files[path] = content;
      mtimes[path] += 1;
      return { content, hadConflicts: false };
    },
    overleaf_rt_connect: () => {
      // The channel names its documents in an event of its own as well.
      setTimeout(() => emitTauriEvent("overleaf-realtime", {
        type: "projectJoined", projectRoot: ROOT, rootFolderId: "root", docs: DOCS, permission: "owner",
      }));
      return overleafSession({ publicId: "me", userId: "me", docs: DOCS });
    },
    overleaf_rt_join_doc: (args) => ({
      text: remote[byId[(args as { docId: string }).docId]], version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
    }),
    overleaf_rt_leave_doc: null,
    overleaf_rt_update_position: null,
    overleaf_sync: async () => {
      await upload.promise;
      remote[OUTLINE] = files[OUTLINE];
      return overleafSyncResult({ pushed: [OUTLINE] });
    },
    overleaf_comment_in_document: (args) => commentInDocument(args as CommentArgs, remote),
    // The first probe on opening finds Overleaf ahead, which is what starts a sync then.
    overleaf_probe: () => overleafProbe({ changed: syncedFirst && probes++ === 0 }),
  };
  persistLayout(ROOT, { openTabs: [OUTLINE], activeFile: OUTLINE, canvasMode: "split" });
  renderOverleafPaper(commands, {
    snapshot: projectSnapshot({
      root: ROOT, projectId: "overleaf-comments", name: "Native VLM", rootDocuments: MAIN_DOCUMENT,
      files: [fileNode("main.tex"), dirNode("cvpr", [fileNode(OUTLINE)])],
    }),
    syncMode: "live",
  });
  const left = () => invokeCalls("overleaf_rt_leave_doc", (args) => (args as { docId: string }).docId === "outline").length;
  await waitFor(() => expect(invokeCalls("overleaf_rt_join_doc", (args) => (args as { docId: string }).docId === "outline"))
    .toHaveLength(1), { timeout: 15_000 });
  if (syncedFirst) await waitFor(() => expect(invokeCalls("overleaf_sync")).toHaveLength(1), { timeout: 6_000 });

  // The Agent rewrites the open file on disk; the next poll takes it in and
  // hands the file to regular sync.
  files[OUTLINE] = "# Outline\n\nThe reader sees every visual token.\n";
  mtimes[OUTLINE] += 1;
  await waitFor(() => expect(left()).toBe(1), { timeout: 6_000 });
  const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
  await waitFor(() => expect(surface).toHaveTextContent("every visual token"));
  return { files, upload, surface };
}

/** Select the passage in the visual editor and send a comment on it; the composer, still open. */
async function commentOnQuote(surface: HTMLElement) {
  const editor = visualEditorOf(surface);
  act(() => {
    editor.view.focus();
    let from = 0;
    editor.state.doc.descendants((node, position) => {
      const at = node.isText ? node.text!.indexOf(QUOTE) : -1;
      if (at >= 0) from = position + at;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + QUOTE.length)));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
  const composer = await screen.findByRole("dialog", { name: "Add comment" });
  fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: BODY } });
  fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
  return composer;
}

describe("Overleaf comments", () => {
  // Reported: in a live-synced project, a comment on a Markdown
  // file the Agent had just rewritten was refused with "This file is not live
  // with Overleaf right now. Reconnect before commenting." Nothing needed
  // reconnecting. An outside write hands the open file to regular sync until
  // a sync settles it (the live channel would be editing from a stale base
  // otherwise), and the comment was refused for as long as that lasted,
  // though Overleaf takes a comment on any of its documents through a
  // connection of the backend's own. Overleaf's copy holds the Agent's words
  // only once that sync uploads them, so the comment waits for it.
  it("posts a comment on a file the live channel let go of after an outside write, once its sync settles", async () => {
    const { files, upload, surface } = await rewriteOpenOutline(placedIfHeld);
    const composer = await commentOnQuote(surface);

    const source = files[OUTLINE];
    await expectInvoked("overleaf_comment_in_document", expect.objectContaining({
      projectRoot: ROOT, docId: "outline", source, from: source.indexOf(QUOTE), quote: QUOTE, content: BODY,
    }));
    await within(composer).findByText("Waiting for outline.md to finish syncing with Overleaf…");
    expect(within(composer).getByRole("textbox", { name: "Comment" })).toHaveValue(BODY);
    expect(within(composer).getByRole("button", { name: "Add comment" })).toBeDisabled();

    act(() => upload.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull(), { timeout: 10_000 });
    expect(invokeCalls("overleaf_comment_in_document")).toHaveLength(2);
    expect(formatAppLogs()).not.toMatch(/not live with Overleaf|did not reach Overleaf/);
    // Not kept as a Lattice-only annotation: collaborators on Overleaf see it.
    expect(invokeCalls("save_annotations")).toEqual([]);
  }, 60_000);

  // Automatic syncs keep up to 30 s apart. One that ran just before the
  // Agent's write would hold the write's own sync, and the comment waiting on
  // it, past the wait: the writer's comment has that sync run now, as Sync does.
  it("has the sync owed the file run now when an automatic sync just ran", async () => {
    const { surface } = await rewriteOpenOutline(placedIfHeld, { syncedFirst: true });
    await commentOnQuote(surface);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull(), { timeout: 10_000 });
    expect(invokeCalls("overleaf_sync")).toHaveLength(2);
    expect(invokeCalls("overleaf_comment_in_document")).toHaveLength(2);
  }, 60_000);

  // The sync that would bring Overleaf's copy up to the passage fails: the
  // comment says so as soon as it does, keeping what was typed, rather than
  // waiting out the rest of the half minute to blame a sync no longer running.
  it("keeps the comment and says the file did not sync when its sync fails", async () => {
    const { upload, surface } = await rewriteOpenOutline(placedIfHeld);
    const composer = await commentOnQuote(surface);
    await within(composer).findByText("Waiting for outline.md to finish syncing with Overleaf…");

    upload.promise.catch(() => {});
    act(() => upload.reject(new Error("Overleaf could not be reached.")));
    await waitFor(() => expect(within(composer).getByRole("alert")).toHaveTextContent(
      "outline.md did not finish syncing with Overleaf, so your comment is not on it yet. Sync again, then add the comment.",
    ), { timeout: 5_000 });
    expect(within(composer).getByRole("textbox", { name: "Comment" })).toHaveValue(BODY);
    expect(within(composer).getByRole("button", { name: "Add comment" })).toBeEnabled();
    expect(invokeCalls("overleaf_comment_in_document")).toHaveLength(1);
  }, 60_000);

  it("keeps the comment and what was typed when Overleaf cannot be reached", async () => {
    const { surface } = await rewriteOpenOutline(() => {
      throw new Error("Overleaf could not be reached.");
    });
    const composer = await commentOnQuote(surface);

    await waitFor(() => expect(within(composer).getByRole("alert"))
      .toHaveTextContent("Your comment on outline.md did not reach Overleaf: Overleaf could not be reached."));
    expect(within(composer).getByRole("textbox", { name: "Comment" })).toHaveValue(BODY);
    expect(within(composer).getByRole("button", { name: "Add comment" })).toBeEnabled();
    expect(invokeCalls("save_annotations")).toEqual([]);
  }, 60_000);
});
