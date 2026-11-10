import {
  deferred, dirNode, fileNode, invokeCalls, MAIN_DOCUMENT, overleafSession, persistLayout, projectSnapshot, visualEditorOf,
  emitTauriEvent, expectInvoked,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { formatAppLogs } from "../telemetry/app-log-store";
import type { OverleafSyncResult } from "../app-types";

const { renderOverleafPaper } = appHarness({ documentCanvas });

const ROOT = "/tmp/lattice-overleaf-comments";
const OUTLINE = "cvpr/outline.md";
const DOCS = [{ id: "main", path: "main.tex" }, { id: "outline", path: OUTLINE }];

describe("Overleaf comments", () => {
  // Reported: in a live-synced project, a comment on a Markdown
  // file the Agent had just rewritten was refused with "This file is not live
  // with Overleaf right now. Reconnect before commenting." Nothing needed
  // reconnecting. An outside write hands the open file to regular sync until
  // a sync settles it (the live channel would be editing from a stale base
  // otherwise), and the comment was refused for as long as that lasted,
  // though Overleaf takes a comment on any of its documents through a
  // connection of the backend's own.
  it("posts a comment on a file the live channel let go of after an outside write", async () => {
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}",
      [OUTLINE]: "# Outline\n\nThe reader sees every token.\n",
    };
    const mtimes: Record<string, number> = { "main.tex": 1, [OUTLINE]: 1 };
    const pathOf = (args: unknown) => (args as { path: string }).path;
    const byId = Object.fromEntries(DOCS.map((doc) => [doc.id, doc.path]));
    // The sync the outside write asks for is still running when the writer comments.
    const sync = deferred<OverleafSyncResult>();
    persistLayout(ROOT, { openTabs: [OUTLINE], activeFile: OUTLINE, canvasMode: "split" });
    renderOverleafPaper({
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
        text: files[byId[(args as { docId: string }).docId]], version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
      }),
      overleaf_rt_leave_doc: null,
      overleaf_rt_update_position: null,
      overleaf_sync: () => sync.promise,
      overleaf_comment_in_document: "placed",
    }, {
      snapshot: projectSnapshot({
        root: ROOT, projectId: "overleaf-comments", name: "Native VLM", rootDocuments: MAIN_DOCUMENT,
        files: [fileNode("main.tex"), dirNode("cvpr", [fileNode(OUTLINE)])],
      }),
      syncMode: "live",
    });
    const joined = (id: string) => invokeCalls("overleaf_rt_join_doc", (args) => (args as { docId: string }).docId === id).length;
    await waitFor(() => expect(joined("outline")).toBe(1), { timeout: 15_000 });

    // The Agent rewrites the open file on disk; the next poll takes it in and
    // hands the file to regular sync.
    files[OUTLINE] = "# Outline\n\nThe reader sees every visual token.\n";
    mtimes[OUTLINE] += 1;
    await waitFor(() => expect(invokeCalls("overleaf_rt_leave_doc", (args) => (args as { docId: string }).docId === "outline"))
      .toHaveLength(1), { timeout: 6_000 });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveTextContent("every visual token"));

    const editor = visualEditorOf(surface);
    const quote = "visual token";
    act(() => {
      editor.view.focus();
      let from = 0;
      editor.state.doc.descendants((node, position) => {
        const at = node.isText ? node.text!.indexOf(quote) : -1;
        if (at >= 0) from = position + at;
      });
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + quote.length)));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Name the encoder here." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));

    const source = files[OUTLINE];
    await expectInvoked("overleaf_comment_in_document", expect.objectContaining({
      projectRoot: ROOT, docId: "outline", source, from: source.indexOf(quote), quote, content: "Name the encoder here.",
    }));
    expect(formatAppLogs()).not.toMatch(/not live with Overleaf/);
    // Not kept as a Lattice-only annotation: collaborators on Overleaf see it.
    expect(invokeCalls("save_annotations")).toEqual([]);
  }, 60_000);
});
