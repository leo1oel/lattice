import { fileNodes, refreshableProject, attentionPaper, overleafLink, overleafStatus, overleafProbe, overleafSyncResult, overleafSession, OVERLEAF_EMPTY_FEEDS, overleafCommands, projectSnapshot, MAIN_DOCUMENT, overleafPaperSnapshot, setAutoBuildMode, setInterfaceLanguage, openPaper, renderApp, renderOverleafPaper, expectNotification, expectInvoked, invokeCalls, argPath, stubScrollBox, openAgentFrame, postProjectHistory, agentCheckpoint, visibleToasts, findOverleafSyncButton, deferred, nextFrames, openTreeFile, waitForSelectedTab, editorViewAt, expectEditorText, readFiles } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatAppLogs } from "../telemetry/app-log-store";

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
    const apply = await screen.findByRole("button", { name: "Apply this update" }, { timeout: 20_000 });
    expect(syncCalls()).toHaveLength(0);
    fireEvent.click(apply);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("bibliography_audit_apply", expect.objectContaining({
      path: "references.bib", key: "doe2020", before, after,
    })));
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 6_000 });
    expect((syncCalls()[0][1] as { live: string[] }).live).not.toContain("references.bib");

    const dialog = await screen.findByRole("dialog", { name: "Resolve conflicts in references.bib" }, { timeout: 60_000 });
    expect(await within(dialog).findByRole("region", { name: "Overleaf" }, { timeout: 10_000 }))
      .toHaveTextContent("Overleaf removed this part.");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Keep this computer's version" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save resolved file" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "references.bib", content: `${after}\n`, projectRoot: snapshot.root,
    }));
    // Queued like any disk edit, so it respects the live channel's sync gap.
    await waitFor(() => expect(syncCalls()).toHaveLength(2), { timeout: 40_000 });
    expect(bib).toBe(`${after}\n`);
  }, 240_000);

  it("does not start a full sync when an opened Overleaf project is unchanged", async () => {
    let syncCount = 0;
    renderOverleafPaper({
      overleaf_link: () => overleafLink({ projectId: "ol-unchanged", lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_probe: () => overleafProbe({ remoteVersion: 42, lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_sync: () => {
        syncCount += 1;
        return overleafSyncResult();
      },
      overleaf_rt_connect: () => overleafSession({ docs: [] }),
    });
    await expectInvoked("overleaf_probe", { projectRoot: "/tmp/lattice-overleaf-paper", checkLocal: true, live: [] });
    await act(async () => { await Promise.resolve(); });
    expect(syncCount).toBe(0);
    expect(screen.queryByRole("button", { name: "Syncing with Overleaf…" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
  });

  // The fourth report of a tab coming back at the top, from an Overleaf-synced
  // project: each return to a document carried live joins it again, and
  // Overleaf's copy of it (the very text on screen) arrived with a request to
  // put the view back at the top, a frame after the tab came back in place.
  it.each(["main_v2.txt", "main_v2.tex"])("brings %s back where it was left when Overleaf's copy of it arrives", async (long) => {
    const short = long.replace("main_v2", "abstract");
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-tab-return", projectId: "tab-return", name: "Tab return", rootDocuments: MAIN_DOCUMENT,
      files: fileNodes("main.tex", short, long),
    });
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}",
      [short]: "Abstract\n\nA short summary.",
      [long]: Array.from({ length: 300 }, (_, index) => `Paragraph ${index}: sparse attention at scale, line after line.`).join("\n"),
    };
    const paths: Record<string, string> = { main: "main.tex", short, long };
    const rejoin = deferred();
    let longJoins = 0;
    renderOverleafPaper({
      read_project_file: readFiles(files),
      stat_project_file: { exists: true, mtimeMs: 1 },
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", userId: "me", docs: Object.entries(paths).map(([id, path]) => ({ id, path })),
      }),
      overleaf_rt_join_doc: async (args) => {
        const path = paths[(args as { docId: string }).docId];
        if (path === long && (longJoins += 1) === 2) await rejoin.promise;
        return { text: files[path], version: 4, comments: [], changes: [], caughtUp: [], resumed: false };
      },
      overleaf_rt_leave_doc: null,
      overleaf_rt_update_position: null,
    }, { snapshot, syncMode: "live" });
    const primaryEditor = ".source-editor[data-editor-pane='primary'] .cm-editor";
    const delivered = () => invokeCalls("write_project_file", (args) => argPath(args) === long).length;
    await openTreeFile(short);
    await openTreeFile(long);
    await waitFor(() => expect(delivered()).toBe(1), { timeout: 10_000 });

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(short.replace(".", "\\.")) }));
    await waitForSelectedTab(short);
    await expectEditorText(files[short], primaryEditor);
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(long.replace(".", "\\.")) }));
    await waitForSelectedTab(long);
    await waitFor(() => expect(longJoins).toBe(2));
    await act(() => nextFrames(3));
    // Back in its place (jsdom lays nothing out, so the place is a pretend scroll offset).
    const view = await expectEditorText(files[long], primaryEditor);
    view.scrollDOM.scrollTop = 4_800;
    fireEvent.scroll(view.scrollDOM);

    await act(async () => { rejoin.resolve(); });
    await waitFor(() => expect(delivered()).toBe(2));
    await act(() => nextFrames(3));
    expect(editorViewAt(primaryEditor)).toBe(view);
    expect(view.scrollDOM.scrollTop).toBe(4_800);
  });

  it("keeps a local Paper editable when its project is read-only on Overleaf", async () => {
    renderApp({
      ...refreshableProject(overleafPaperSnapshot()), list_papers: () => [attentionPaper({ hasBlog: false })],
      read_paper: "## Abstract\n\nPaper content.\n\n## Method\n\nEditable notes.",
      ...overleafCommands({
        overleaf_link: () => overleafLink({ projectId: "ol-read-only" }),
        overleaf_rt_connect: () => overleafSession({ permission: "readOnly" }),
        overleaf_status: () => overleafStatus({ email: "reader@example.com", name: "Reader" }),
      }),
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    await openPaper("Attention Is All You Need");
    const paperEditor = await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(paperEditor).toHaveAttribute("contenteditable", "true"));
    // Block controls follow the pointer; hovering a block offers its grip.
    fireEvent.mouseMove(paperEditor.firstElementChild!);
    expect(await screen.findByRole("button", { name: "Select block" })).toBeInTheDocument();
  });

  it("routes toolbar and status comments to one Overleaf drawer while preserving local history", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    const snapshot = projectSnapshot({
      root: "/tmp/unified-comments", projectId: "unified-comments", name: "Review paper", rootDocuments: MAIN_DOCUMENT,
    });
    const comments = [false, true].map((resolved, index) => ({
      id: `local-${index}`, path: index ? "unsynced.tex" : "main.tex", from: 0, to: 5,
      quote: "alpha", prefix: "", suffix: " beta", body: index ? "Local history" : "Local review",
      authorId: "reviewer", authorName: "Reviewer", resolved, replies: [],
      createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
    }));
    renderApp({
      ...refreshableProject(snapshot, "alpha beta"), list_editor_comments: comments, save_editor_comments: undefined,
      overleaf_link: () => overleafLink({ projectId: "remote-project", projectName: "Review paper" }),
      ...OVERLEAF_EMPTY_FEEDS,
      overleaf_threads: () => [{
        id: "remote-thread", resolved: false, resolvedBy: null, resolvedAt: null,
        messages: [{ id: "message", content: "Remote review", authorName: "Collaborator", authorEmail: "", timestamp: Date.now(), mine: false }],
      }],
      overleaf_probe: () => overleafProbe(), overleaf_status: () => overleafStatus(),
    });
    const toolbar = await screen.findByRole("button", { name: "Overleaf comments and chat · 2 waiting" });
    expect(document.querySelector('.canvas-toolbar button[aria-label="Editor comments"]')).toBeNull();
    fireEvent.click(toolbar);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    // A slow chunk shows the drawer's loading shell, which docks in the same
    // drawer and stays its minimum time over the drawer arriving under it.
    await waitFor(() => expect(document.querySelector(".tool-loading-shell")).toBeNull());
    expect(document.querySelectorAll(".overleaf-collab-drawer")).toHaveLength(1);
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Local/ }));
    expect(await screen.findByText("Local review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Include resolved" }));
    expect(screen.getByText("Local history")).toBeInTheDocument();
    expect(screen.getByText("unsynced.tex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /main.tex alpha Local review/ }));
    await waitFor(() => expect(document.querySelector(".overleaf-collab-drawer")).toBeNull());
    fireEvent.click(document.querySelector<HTMLButtonElement>(".status-comments")!);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Comments2/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("save_editor_comments", expect.anything());
    fireEvent.click(screen.getByRole("tab", { name: /^Local/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply to Reviewer"), { target: { value: "Local-only reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await expectInvoked("save_editor_comments", {
      comments: [
        expect.objectContaining({ id: "local-0", replies: [expect.objectContaining({ body: "Local-only reply" })] }),
        comments[1],
      ],
    });
    expect(invoke).not.toHaveBeenCalledWith("overleaf_reply_to_thread", expect.anything());
  });

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
    expect(await screen.findByText("No projects in this account yet. Create one on Overleaf and it will appear here"))
      .toBeInTheDocument();
  });

  it("silently retries a transient automatic Overleaf outage but reports it for manual sync", async () => {
    const transportFailure = new Error("error decoding response body");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const scheduledTimeouts = vi.spyOn(window, "setTimeout");
    let syncCount = 0;
    let failSync = true;
    let probeChanged = false;
    renderOverleafPaper({
      overleaf_sync: () => {
        syncCount += 1;
        if (failSync) throw transportFailure;
        return overleafSyncResult();
      },
      overleaf_probe: (args) => overleafProbe({
        changed: probeChanged, localChanged: Boolean((args as { checkLocal?: boolean } | undefined)?.checkLocal),
        remoteVersion: probeChanged ? 77 : 1,
      }),
    }, { syncMode: "live" });
    const gitAutoCommitted = () => vi.mocked(invoke).mock.calls.some(([command]) => command === "git_auto_commit");
    await waitFor(() => expect(syncCount).toBe(1), { timeout: 30_000 });
    await waitFor(() => expect(formatAppLogs()).toMatch(/error decoding response body/));
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    failSync = false;
    vi.setSystemTime(1_030_000);
    const poll = [...scheduledTimeouts.mock.calls].reverse().find(([, delay]) => delay === 3_000)?.[0];
    scheduledTimeouts.mockRestore();
    expect(poll).toBeTypeOf("function");
    act(() => { (poll as () => void)(); });
    await waitFor(() => expect(syncCount).toBe(2));
    expect(gitAutoCommitted()).toBe(false);
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    const syncButton = await findOverleafSyncButton();
    probeChanged = true;
    vi.setSystemTime(1_060_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(syncCount).toBe(3));
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", {
      projectRoot: "/tmp/lattice-overleaf-paper", live: [], observedRemoteVersion: 77,
      diagnosticContext: { operation_id: expect.any(String), request_id: expect.any(String) },
    });
    expect(gitAutoCommitted()).toBe(false);

    await waitFor(() => expect(syncButton).not.toBeDisabled());
    probeChanged = false;
    failSync = true;
    fireEvent.click(syncButton);

    await waitFor(() => expect(syncCount).toBe(4));
    await expectNotification(/Sync failed[\s\S]*error decoding response body/);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
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

  it.each([
    { cached: false, fallback: false }, { cached: true, fallback: false }, { cached: true, fallback: true },
  ])("opens an AlphaXiv overview and routes source links (%j)", async ({ cached, fallback }) => {
    const url = "https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning";
    const citationUrl = `${url}.pdf#page=8`;
    const paper = { arxivId: "web-0123456789abcdef", url, title: "MiMo-V2.6", hasFullText: fallback, hasBlog: cached };
    renderApp({
      ...refreshableProject(), list_papers: () => [{ ...paper }],
      fetch_web_reference: () => {
        paper.hasBlog = true;
        return { arxivId: paper.arxivId, paperPath: "", blogPath: `.research/papers/${paper.arxivId}/blog.md` };
      },
      read_paper: () => {
        if (fallback) return "# Original full text\n\nWe use a large training dataset with many tokens per sequence";
        throw new Error("Full text unavailable");
      },
      paper_pdf_preview_url: () => {
        if (fallback) throw new Error("PDF unavailable");
        return "http://127.0.0.1:3456/paper.pdf?token=test";
      },
      read_paper_blog_local: () => `# MiMo overview\n\nTraining uses 1,568 prompts. [p8](${citationUrl} "We use a large training … tokens per sequence")`,
    });
    fireEvent.click(await screen.findByRole("button", { name: /^MiMo-V2\.6/ }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const citation = await screen.findByRole("link", { name: "p8" });
    expect(citation).toHaveAttribute("href", citationUrl);
    expect(citation).toHaveAttribute("title", "We use a large training … tokens per sequence");
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeVisible();
    const blogViewport = citation.closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(blogViewport, 600, 2400);
    blogViewport.scrollTop = 735;
    fireEvent.scroll(blogViewport);
    fireEvent.click(citation);
    await expectInvoked("paper_pdf_preview_url", { url: `${url}.pdf` });
    if (fallback) {
      expect(await screen.findByRole("heading", { name: "Original full text" })).toBeVisible();
      await waitFor(() => expect(window.getSelection()?.toString()).toBe("We use a large training dataset with many tokens per sequence"));
    }
    expect(await screen.findByRole("button", { name: "Back to Blog" })).toBeVisible();
    expect(openUrl).not.toHaveBeenCalledWith(citationUrl);
    fireEvent.click(screen.getByRole("button", { name: "Back to Blog" }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const returnedViewport = screen.getByRole("link", { name: "p8" }).closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(returnedViewport, 600, 2400);
    await waitFor(() => expect(returnedViewport.scrollTop).toBe(735));
    expect(invoke).not.toHaveBeenCalledWith("fetch_paper", expect.anything());
    if (!cached) expect(invoke).toHaveBeenCalledWith("fetch_web_reference", { url });
  });
});
