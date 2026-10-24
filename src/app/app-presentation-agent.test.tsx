import {
  fileNode, findFrame, openSlideWorkspaceApi, pause, postedOfType, postWindowMessage, projectSnapshot, refreshableProject, ROOT,
  synaraHook, visibleToasts,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { agentDeckPresence } from "../agent/agent-turn-activity";

const { renderApp } = appHarness({ documentCanvas });

describe("the Open Slide editor's agent entry points", () => {
  it("sends an Open Slide deck's Apply comments and Draft a deck into the Agent panel once it is ready", { timeout: 20_000 }, async () => {
    const deck = "slides/talk/index.tsx";
    renderApp({
      ...refreshableProject(projectSnapshot({ rootDocuments: [], files: [fileNode(deck)] }), "export default [];\n"),
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    // The default layout keeps the Agent as a tab behind Project.
    const agentTab = await screen.findByRole("tab", { name: "Agent" });
    expect(agentTab).toHaveAttribute("aria-selected", "false");
    await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15_000 });

    // The island's Apply button, as OpenSlideWorkspace reports it from the deck's frame.
    act(() => openSlideWorkspaceApi.onAgentRequest?.({ kind: "apply-comments", deckPath: deck }));

    await waitFor(() => expect(agentTab).toHaveAttribute("aria-selected", "true"));
    const frame = await findFrame();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    await pause(20);
    expect(postedOfType(postMessage, "lattice:composer-prompt")).toEqual([]);
    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
    await waitFor(() => expect(postedOfType(postMessage, "lattice:composer-prompt")).toEqual([{
      type: "lattice:composer-prompt", version: 1, requestId: expect.any(String), workspaceRoot: ROOT,
      text: "Apply the pending comments in slides/talk/index.tsx.", mode: "send",
    }]));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "lattice:composer-prompt" }), synaraHook.runtime.origin);

    // Without a provider the panel keeps the request, and the writer is told what to do.
    const [{ requestId }] = postedOfType<{ requestId: string }>(postMessage, "lattice:composer-prompt");
    postWindowMessage(frame.contentWindow, {
      type: "synara:composer-prompt-result", version: 1, requestId, ok: false,
      error: { code: "no-provider", message: "No provider is configured." },
    });
    await waitFor(() => expect(visibleToasts("Agent").map((entry) => entry?.title)).toEqual([
      "Choose an AI provider in the agent panel, then send the request waiting in its composer.",
    ]));

    // Draft a deck, once the frame is ready, goes straight in, is never sent, and puts the cursor there.
    act(() => openSlideWorkspaceApi.onAgentRequest?.({ kind: "draft-deck", deckPath: null }));
    await waitFor(() => expect(document.activeElement).toBe(frame));
    await waitFor(() => expect(postedOfType(postMessage, "lattice:composer-prompt").at(-1)).toMatchObject({
      text: "Create a presentation about ", mode: "draft",
    }));
  });

  it("lights only the decks the panel's turn names, from its own frame, until the turn or the frame ends", { timeout: 20_000 }, async () => {
    const deck = "slides/talk/index.tsx";
    renderApp({
      ...refreshableProject(projectSnapshot({ rootDocuments: [], files: [fileNode(deck)] }), "export default [];\n"),
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
    });
    await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15_000 });
    act(() => openSlideWorkspaceApi.onAgentRequest?.({ kind: "open", deckPath: deck }));
    const frame = await findFrame();
    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
    const report = (overrides: Record<string, unknown> = {}) => ({
      type: "synara:turn-activity", version: 1, workspaceRoot: ROOT, threadId: "thread-1", turnId: "turn-1",
      state: "running", provider: { id: "claude", label: "Claude Code" },
      tool: { title: "Write", detail: "index.tsx", paths: ["slides/launch/index.tsx"] }, ...overrides,
    });

    // Neither another project's turn nor a message from outside the panel's frame counts.
    postWindowMessage(frame.contentWindow, report({ workspaceRoot: "/tmp/other" }));
    postWindowMessage(window, report());
    postWindowMessage(frame.contentWindow, report(), "http://127.0.0.1:9");
    expect(agentDeckPresence()).toBeNull();

    postWindowMessage(frame.contentWindow, report());
    expect(agentDeckPresence()).toMatchObject({
      state: "running", provider: { label: "Claude Code" }, tool: { title: "Write", detail: "index.tsx" }, decks: ["launch"],
    });
    postWindowMessage(frame.contentWindow, report({ state: "idle", tool: undefined }));
    expect(agentDeckPresence()).toBeNull();

    // A panel that reloads mid-turn reports its turn afresh.
    postWindowMessage(frame.contentWindow, report());
    expect(agentDeckPresence()).not.toBeNull();
    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
    expect(agentDeckPresence()).toBeNull();
  });
});
