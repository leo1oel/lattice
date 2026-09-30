import { windowApi, synaraHook, mockAppCommand, fileNode, projectCommands, attentionPaper, projectSnapshot, buildResult, deferred, type Deferred, setAutoBuildMode, selectPanelTab, buildButton, waitForBuildIdle, renderApp, findFrame, postWindowMessage, expectInvoked, invokeCalls, pause, persistLayoutWithoutAgent, argPath, openAgentFrame, postProjectHistory, agentCheckpoint, postedOfType, chooseProjectMenuItem } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("Agent panel", () => {
  it("shows Synara failure states without rendering the retired Agent settings or composer", async () => {
    // Keep both lazy surfaces' cold transforms outside DOM query deadlines.
    await Promise.all([import("../trellis/trellis-agent-surface"), import("../settings/settings-dialog")]);
    synaraHook.runtime = {
      state: "stopped", origin: null, authToken: null, message: "Synara did not start.", startupMs: null, version: null, revision: null,
    };
    renderApp(projectCommands());
    await selectPanelTab("Agent");
    const agentFailure = await screen.findByRole("alert");
    expect(agentFailure).toBeVisible();
    expect(agentFailure).toHaveTextContent("Agent unavailable");
    expect(agentFailure).toHaveTextContent("Synara did not start.");
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Conversation history")).not.toBeInTheDocument();
    await chooseProjectMenuItem("Settings");
    fireEvent.click(await screen.findByRole("button", { name: "Providers" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(await within(settings).findByRole("alert")).toHaveTextContent("Agent unavailable");
    expect(within(settings).queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Subscriptions")).not.toBeInTheDocument();
  });

  it("restores the Agent's saved thread and follows only its own frame", async () => {
    // Finish cold compilation before DOM waits and unmount/remount assertions.
    await Promise.all([import("../settings/settings-dialog"), import("../canvas/document-canvas")]);
    localStorage.setItem("lattice.agent-thread.v1:/tmp/lattice-paper", "saved-thread");

    const view = renderApp(projectCommands());
    await selectPanelTab("Agent");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    const frame = await findFrame();
    expect(new URL(frame.src).pathname).toBe("/saved-thread");
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frame.closest(".synara-frame-shell")).not.toHaveAttribute("data-ready");

    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });

    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    expect(postMessage).toHaveBeenCalledWith({ type: "lattice:request-agent-permission-mode" }, synaraHook.runtime.origin);

    postProjectHistory(frame, "wrong-thread", [], "https://untrusted.example");
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("saved-thread");
    postProjectHistory(frame, "selected-thread", []);
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("selected-thread");
    // Recording navigation must not reload the live iframe or interrupt a turn.
    expect(new URL(frame.src).pathname).toBe("/saved-thread");

    const openSettings = { type: "synara:open-settings", section: "providers" };
    postWindowMessage(frame.contentWindow, openSettings, "https://untrusted.example");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    postWindowMessage(frame.contentWindow, openSettings);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");
    view.unmount();
    renderApp();
    await waitFor(() => {
      const restored = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(restored).not.toBeNull();
      expect(new URL(restored!.src).pathname).toBe("/selected-thread");
    });
  });

  it("starts Synara when source control is requested", async () => {
    persistLayoutWithoutAgent();
    renderApp({ ...projectCommands(), git_status: () => ({
      available: true, repository: true, branch: "main", remote: "origin", remoteUrl: "git@github.com:leo1oel/lattice.git", files: [],
    }) });
    await screen.findByRole("button", { name: "Switch project" });
    expect(synaraHook.enabledCalls).not.toContain(true);
    fireEvent.click(screen.getByRole("button", { name: "Git status and commit" }));
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open this repository on GitHub" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice");
  });

  it("routes agent paper, file, link, and review requests to their native surfaces", async () => {
    const sections = fileNode("sections", "folder", { children: [fileNode("sections/intro.tex")] });
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), sections] });
    renderApp({
      ...projectCommands(snapshot),
      read_project_file: (args) => {
        if (!argPath(args)?.endsWith(".png")) return "\\documentclass{article}";
        throw new Error("This is a binary or unsupported file and cannot be opened in the source editor.");
      },
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/png", base64: "iVBORw0KGgo=" }),
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: false })],
      read_paper: "---\ntitle: Attention Is All You Need\n---\n\n## Abstract\n\nPaper content.", read_paper_blog_local: null,
      build_project: buildResult({ durationMs: 5, rootDocument: "/private/outside/main.tex" }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    await screen.findByTitle("Attention Is All You Need");
    const { frame } = await openAgentFrame();

    const agent = (data: object) => postWindowMessage(frame.contentWindow, data);
    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/notes/detailed%20distillation.md" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "notes/detailed distillation.md" }));

    agent({ type: "synara:open-external", url: "https://example.com/paper" });
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/paper"));

    agent({ type: "synara:open-external", url: "javascript:alert(1)" });
    expect(openUrl).toHaveBeenCalledTimes(1);

    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/.research/papers/1706.03762/paper.md" });
    expect(await screen.findByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });

    agent({ type: "synara:open-review", filePath: "sections/intro.tex" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "sections/intro.tex" }));
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();

    const figure = "figures/mmvp_prefix_suffix_retained_pair_accuracy_plotly.png";
    agent({ type: "synara:open-review", filePath: figure });
    expect(await screen.findByAltText(`Preview of ${figure}`)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: figure });

    agent({ type: "synara:open-review", threadId: "thread-1", turnId: "turn-9" });
    expect(await screen.findByRole("tab", { name: "Agent turn" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Git workspace" })).toHaveClass("drawer-view-tabs");
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveClass("drawer-view-tab");
    expect(screen.getByRole("tab", { name: "Changes" })).not.toHaveClass("ui-compact-selectable");
    const reviewFrame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent turn review"]');
    expect(reviewFrame).not.toBeNull();
    expect(reviewFrame!.src).toContain("threadId=thread-1");
    expect(reviewFrame!.src).toContain("turnId=turn-9");

    // Tabbing back to the working tree drops the pinned turn.
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Agent turn" })).not.toBeInTheDocument());
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
  });

  it("keeps the Agent panel at least as wide as its composer reports it needs", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame();
    const minimumWidth = () => (windowApi.setMinSize.mock.calls.at(-1)?.[0] as { width: number } | undefined)?.width ?? 0;
    await waitFor(() => expect(minimumWidth()).toBeGreaterThan(0));
    const before = minimumWidth();
    // Synara measures its composer (controls side by side, send button inside
    // the box) and reports the frame width that needs; the layout, and so the
    // window, may not go narrower.
    postWindowMessage(frame.contentWindow, { type: "synara:layout-metrics", minimumSidebarWidth: 560 });
    await waitFor(() => expect(minimumWidth()).toBeGreaterThanOrEqual(before + 200));
    // A narrower report (a shorter model label) gives the room back.
    postWindowMessage(frame.contentWindow, { type: "synara:layout-metrics", minimumSidebarWidth: 120 });
    await waitFor(() => expect(minimumWidth()).toBe(before));
    // Only the agent's own frame may report.
    postWindowMessage(window, { type: "synara:layout-metrics", minimumSidebarWidth: 560 });
    await pause(50);
    expect(minimumWidth()).toBe(before);
  });

  it.each(["undo", "undo in manual mode", "same-count edit"])("rebuilds after an Agent %s", async (change) => {
    if (change === "undo in manual mode") setAutoBuildMode("manual");
    renderApp({
      ...projectCommands(), stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      build_project: buildResult({ durationMs: 5, rootDocument: "main.tex" }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame } = await openAgentFrame();
    const entry = agentCheckpoint("undo", { additions: 2, deletions: 2 });
    postProjectHistory(frame, entry.threadId, [entry]);
    const builds = () => invokeCalls("build_project").length;
    const baseline = builds();
    postProjectHistory(frame, entry.threadId, change.startsWith("undo") ? [] : [{ ...entry, timestamp: "2026-08-07T10:01:00.000Z" }]);
    await waitFor(() => expect(builds()).toBe(baseline + 1), { timeout: 4_000 });
  });

  it("rebuilds after fresh agent checkpoints but not for replayed history", async () => {
    const tutorialSnapshot = projectSnapshot({ root: "/tmp/tutorial-paper", projectId: "tutorial-id", name: "Tutorial paper" });
    const built = buildResult({ durationMs: 5, rootDocument: "/private/outside/main.tex" })();
    let nextBuildHasPdf = false;
    // Held operations wait on their deferred until the test settles it.
    let heldBuild: Deferred | undefined;
    let heldPdfRead: Deferred | undefined;
    const holdNextBuild = () => (heldBuild = deferred());
    const buildCalls = () => invokeCalls("build_project").length;
    const tutorialBuilds = () => invokeCalls(
      "build_project", (args) => (args as { projectRoot?: string } | undefined)?.projectRoot === tutorialSnapshot.root,
    );
    // One checkpoint whose intro.tex work grows by `additions` lines.
    const postCheckpoint = (frame: HTMLIFrameElement, additions: number, deletions = 2) => {
      postProjectHistory(frame, "thread-1", [agentCheckpoint("1", { additions, deletions })]);
    };

    const view = renderApp({
      ...projectCommands(), open_tutorial_project: tutorialSnapshot,
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      build_project: async () => {
        const result = nextBuildHasPdf ? { ...built, hasPdf: true } : built;
        nextBuildHasPdf = false;
        const hold = heldBuild;
        heldBuild = undefined;
        if (hold) await hold.promise;
        return result;
      },
      read_compiled_pdf: async () => {
        const hold = heldPdfRead;
        heldPdfRead = undefined;
        if (!hold) return mockAppCommand("read_compiled_pdf");
        await hold.promise;
        return new ArrayBuffer(8);
      },
    });
    await screen.findByRole("button", { name: "Switch project" });
    const { frame, postMessage } = await openAgentFrame();

    // The first snapshot for a thread replays its existing history; it must
    // prime the fingerprints without scheduling a rebuild.
    postCheckpoint(frame, 1, 0);
    const baseline = buildCalls();
    await pause(2_200);
    expect(buildCalls()).toBe(baseline);

    // The same checkpoint growing new file work is fresh agent editing.
    postCheckpoint(frame, 5);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 1), { timeout: 4_000 });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "lattice:agent-compile-result", version: 1, threadId: "thread-1", turnId: "turn-1", checkpointRef: "ref-1",
      success: true, durationMs: 5, rootDocument: null, diagnostics: { errors: 0, warnings: 0 },
    }), synaraHook.runtime.origin));
    const agentCompileRelays = () => postedOfType(postMessage, "lattice:agent-compile-result").length;
    const relaysAfterFirstCheckpoint = agentCompileRelays();
    const clickBuild = () => fireEvent.click(buildButton());
    // Starts a manual build that stays in flight until the returned hold is settled, waits until `started`, then
    // lets fresh checkpoint work (`additions` lines) arrive in `checkpointFrame` behind it.
    const checkpointBehindHeldBuild = async (started: () => void, checkpointFrame: HTMLIFrameElement, additions: number) => {
      const held = holdNextBuild();
      clickBuild();
      await waitFor(started);
      postCheckpoint(checkpointFrame, additions);
      await pause(1_800);
      return held;
    };

    // A manual build during the checkpoint debounce must not consume its
    // association. The dedicated automatic pass still runs and owns the relay.
    postCheckpoint(frame, 9);
    clickBuild();
    await waitFor(() => expect(buildCalls()).toBe(baseline + 2));
    await waitForBuildIdle();
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint);
    await waitFor(() => expect(buildCalls()).toBe(baseline + 3), { timeout: 4_000 });
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1));

    // A checkpoint that arrives during an in-flight manual build queues its
    // own pass; it must not be credited to the older output.
    let held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 4), frame, 13);
    expect(buildCalls()).toBe(baseline + 4);
    expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 1);
    held.resolve();
    await waitFor(() => expect(buildCalls()).toBe(baseline + 5));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 2));

    // A rejected backend build used to skip the loop condition and strand the
    // checkpoint pass forever. The queued owner must still run and relay.
    held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 6), frame, 15);
    held.reject(new Error("build rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 7));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 3));

    // Reading a newly compiled PDF can reject independently of compilation.
    // That failure must not prevent a checkpoint queued during the read.
    nextBuildHasPdf = true;
    const pdfRead = heldPdfRead = deferred();
    clickBuild();
    // The read has started once it takes the hold.
    await waitFor(() => expect(heldPdfRead).toBeUndefined());
    postCheckpoint(frame, 16);
    await pause(1_800);
    pdfRead.reject(new Error("PDF read rejected"));
    await waitFor(() => expect(buildCalls()).toBe(baseline + 9));
    await waitFor(() => expect(agentCompileRelays()).toBe(relaysAfterFirstCheckpoint + 4));

    // Queued work and its associations belong to an immutable project scope. Switching while the old manual build
    // is in flight must cancel the queued checkpoint instead of compiling the incoming project under the old turn.
    held = await checkpointBehindHeldBuild(() => expect(buildCalls()).toBe(baseline + 10), frame, 17);
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    held.resolve();
    await waitFor(() => expect(tutorialBuilds()).toHaveLength(1));
    await pause(2_000);
    expect(tutorialBuilds()).toHaveLength(1);

    const tutorialFrame = await findFrame();
    postCheckpoint(tutorialFrame, 10);
    await pause(2_000);
    expect(tutorialBuilds()).toHaveLength(1);

    // Unmount is another ownership boundary: resolving an old build afterward
    // must not launch its queued checkpoint pass against a dead window.
    held = await checkpointBehindHeldBuild(() => expect(tutorialBuilds()).toHaveLength(2), tutorialFrame, 14);
    view.unmount();
    held.resolve();
    await pause(100);
    expect(tutorialBuilds()).toHaveLength(2);
  }, 90_000);
});
