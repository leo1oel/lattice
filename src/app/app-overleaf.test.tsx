import { fileNodes, overleafLink, overleafStatus, overleafProbe, overleafSyncResult, overleafSession, projectSnapshot, MAIN_DOCUMENT, setInterfaceLanguage, expectNotification, expectInvoked, invokeCalls, argPath, openAgentFrame, postProjectHistory, agentCheckpoint, findOverleafSyncButton } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { renderOverleafPaper } = appHarness();

describe("Overleaf sync", () => {
  it("syncs an agent's unopened chapter without requiring an automatic build or remote change", async () => {
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-agent-sync", projectId: "agent-sync", name: "Agent sync", rootDocuments: MAIN_DOCUMENT,
    });
    renderOverleafPaper({
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      overleaf_link: () => overleafLink({ projectId: "ol-agent-sync", projectName: "Agent sync", lastSync: undefined }),
      overleaf_status: () => overleafStatus({ email: undefined, name: undefined }),
      overleaf_probe: () => overleafProbe({ lastSync: undefined }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", rootFolderId: undefined, docs: [{ id: "main", path: "main.tex" }], userId: "me",
      }),
      overleaf_rt_join_doc: () => ({
        text: "\\documentclass{article}", version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
      }),
      overleaf_sync: () => overleafSyncResult({ pushed: ["sections/results.tex"] }),
    }, { snapshot, syncMode: "live" });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame();
    postProjectHistory(frame, "agent-sync", []);
    const syncCalls = () => invokeCalls("overleaf_sync");
    expect(syncCalls()).toHaveLength(0);
    postProjectHistory(frame, "agent-sync", [agentCheckpoint("sync", { path: "sections/results.tex", additions: 3, deletions: 1 }, {
      label: "Edited chapter", timestamp: "2026-09-24T01:00:00.000Z", threadId: "agent-sync", threadTitle: "Edit",
      checkpointRef: "refs/lattice/checkpoints/test",
    })]);
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 6_000 });
    expect(syncCalls()[0][1]).toMatchObject({ projectRoot: snapshot.root });
    expect((syncCalls()[0][1] as { live: string[] }).live).not.toContain("sections/results.tex");
  });

  it("uploads a reference-check update right away and a resolved bibliography conflict after saving", async () => {
    // The Papers path behind the reported conflict: an update written straight
    // to references.bib used to wait, unsynced, for some later save. Here the
    // first sync it schedules meets an Overleaf edit, and the resolver's choice
    // must be what lands on disk and what the following sync uploads.
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-bib-sync", projectId: "bib-sync", name: "Bib sync", rootDocuments: MAIN_DOCUMENT,
      files: fileNodes("main.tex", "references.bib"),
    });
    const source = "\\documentclass{article}";
    const before = "@misc{doe2020,\n  title = {A Study},\n  year = {2020},\n}";
    const after = "@article{doe2020,\n  title = {A Study},\n  journal = {Journal},\n  year = {2020},\n}";
    let bib = `${before}\n`;
    const conflicted = `<<<<<<< ours\n${after}\n||||||| original\n${before}\n=======\n>>>>>>> theirs\n`;
    let syncs = 0;
    renderOverleafPaper({
      read_project_file: (args) => (argPath(args) === "references.bib" ? bib : source),
      stat_project_file: { exists: true, mtimeMs: 1 },
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        if (path === "references.bib") bib = content;
        return { content, hadConflicts: false };
      },
      overleaf_link: () => overleafLink({ projectId: "ol-bib-sync", projectName: "Bib sync" }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", userId: "me", docs: [{ id: "main", path: "main.tex" }, { id: "bib", path: "references.bib" }],
      }),
      overleaf_rt_join_doc: { text: source, version: 4, comments: [], changes: [], caughtUp: [], resumed: false },
      bibliography_audit_scan: () => ({
        entries: [{ path: "references.bib", key: "doe2020", title: "A Study", bibtex: bib.trim(), issues: [] }], issues: [],
      }),
      bibliography_audit_report_load: [["references.bib\0doe2020", {
        snapshot: before, applied: false,
        result: {
          status: "update", message: "A published version is available.", before, after,
          checkedAt: "2026-09-26T10:07:00.000Z", changes: [{ field: "journal", before: "", after: "Journal" }],
        },
      }]],
      bibliography_audit_report_save: null,
      bibliography_audit_apply: () => {
        bib = `${after}\n`;
        return null;
      },
      overleaf_sync: () => {
        syncs += 1;
        if (syncs > 1) return overleafSyncResult({ pushed: ["references.bib"] });
        // Overleaf changed the same entry in the meantime.
        bib = conflicted;
        return overleafSyncResult({
          conflicts: [{ path: "references.bib", localCopy: "references (local conflict 20260926-1808).bib", markers: true }],
        });
      },
      list_todos: () => [],
    }, { snapshot, syncMode: "live" });
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.click(await screen.findByRole("button", { name: "Check references" }));
    const syncCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_sync");
    // The drawer is a lazy chunk; a cold, busy test runner can take a while.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_scan", { projectRoot: snapshot.root }), { timeout: 60_000 });
    const apply = await screen.findByRole("button", { name: "Apply" }, { timeout: 20_000 });
    expect(syncCalls()).toHaveLength(0);
    fireEvent.click(apply);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_apply", expect.objectContaining({
      path: "references.bib", key: "doe2020", before, after,
    })));
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 6_000 });
    expect((syncCalls()[0][1] as { live: string[] }).live).not.toContain("references.bib");

    const dialog = await screen.findByRole("dialog", { name: "Resolve conflicts in references.bib" }, { timeout: 60_000 });
    expect(await within(dialog).findByRole("radio", { name: "Keep Overleaf's version" }, { timeout: 10_000 }))
      .toHaveTextContent("Overleaf removed this part.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Keep this computer's version" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and upload" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "references.bib", content: `${after}\n`, projectRoot: snapshot.root,
    }));
    // Queued like any disk edit, so it respects the live channel's sync gap.
    await waitFor(() => expect(syncCalls()).toHaveLength(2), { timeout: 40_000 });
    expect(bib).toBe(`${after}\n`);
  }, 240_000);

  it("opens the linked project on its Overleaf host and keeps the project picker available", async () => {
    renderOverleafPaper({
      // Legacy links did not persist the host, so the active account is the
      // source of truth for where their web project lives.
      overleaf_link: () => overleafLink({ projectId: "ol/project id", host: "" }),
      overleaf_status: () => overleafStatus({ host: "https://overleaf.example.edu/" }),
      overleaf_list_projects: () => [],
    }, { syncMode: "manual" });
    const actions = await screen.findByRole("button", { name: "Overleaf project actions" });
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Overleaf" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://overleaf.example.edu/project/ol%2Fproject%20id"));
    fireEvent.pointerDown(actions, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open another Overleaf project" }));
    expect(await screen.findByLabelText("Open from Overleaf")).toBeInTheDocument();
    expect(screen.queryByText("Upload this project to Overleaf")).not.toBeInTheDocument();
    expect(await screen.findByText("No projects in this account yet"))
      .toBeInTheDocument();
  });

  it("localizes confirmation and completion when removing a locally deleted Overleaf file", async () => {
    await setInterfaceLanguage("zh-CN");
    renderOverleafPaper({
      overleaf_sync: () => overleafSyncResult({ skippedRemoteDeletes: ["results.lattice-sheet.bak"] }),
      overleaf_rt_connect: () => overleafSession({ entities: [{ id: "backup-file", path: "results.lattice-sheet.bak", kind: "file" }] }),
      overleaf_delete_entity: undefined,
    }, { syncMode: "live", confirmations: true });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    fireEvent.click(await findOverleafSyncButton());
    const dialog = await screen.findByRole("dialog", { name: "从 Overleaf 删除 1 个文件？" }, { timeout: 15_000 });
    expect(dialog).toHaveAccessibleDescription(
      "results.lattice-sheet.bak 本地已删，Overleaf 上还在。现在删除，它的历史里也会留着",
    );
    fireEvent.click(screen.getByRole("button", { name: "Overleaf 上也删" }));
    await expectInvoked("overleaf_delete_entity", { projectRoot: "/tmp/lattice-overleaf-paper", kind: "file", entityId: "backup-file" });
    await expectNotification(/已从 Overleaf 删除 1 个文件/);
  });

  it("says which files a sync kept because Overleaf's download would have emptied them", async () => {
    renderOverleafPaper({
      overleaf_sync: () => overleafSyncResult({ refusedIncoming: ["notes.md", "figures/fig.png"] }),
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    fireEvent.click(await findOverleafSyncButton());
    await expectNotification(/Kept your copy of notes\.md, figures\/fig\.png\. Overleaf sent these files empty/);
  });

  it("silently removes legacy app-owned intermediates from Overleaf", async () => {
    let syncCount = 0;
    renderOverleafPaper({
      overleaf_sync: () => {
        syncCount += 1;
        return overleafSyncResult({ automaticRemoteDeletes: syncCount > 1 ? ["lambda_gpu_proposal.bbl-SAVE-ERROR", "tmp/pdfs"] : [] });
      },
      overleaf_probe: (args) => overleafProbe({ localChanged: Boolean((args as { checkLocal?: boolean } | undefined)?.checkLocal) }),
      overleaf_rt_connect: () => overleafSession({ entities: [
        { id: "tmp-folder", path: "tmp", kind: "folder" }, { id: "pdfs-folder", path: "tmp/pdfs", kind: "folder" },
        { id: "save-error-file", path: "lambda_gpu_proposal.bbl-SAVE-ERROR", kind: "file" },
      ] }),
      overleaf_delete_entity: undefined,
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    await waitFor(() => expect(syncCount).toBe(1));
    fireEvent.click(await findOverleafSyncButton());
    const deleted = (kind: string, entityId: string) => ({ projectRoot: "/tmp/lattice-overleaf-paper", kind, entityId });
    await expectInvoked("overleaf_delete_entity", deleted("folder", "pdfs-folder"));
    expect(invoke).toHaveBeenCalledWith("overleaf_delete_entity", deleted("file", "save-error-file"));
    expect(confirm).not.toHaveBeenCalled();
  });
});
