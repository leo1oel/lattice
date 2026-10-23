import {
  fileNode, findFrame, openSlideWorkspaceApi, pause, postedOfType, postWindowMessage, projectSnapshot, refreshableProject, ROOT,
  synaraHook, visibleToasts,
} from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
      "Choose an AI provider in the agent panel, then try again.",
    ]));

    // Draft a deck, once the frame is ready, goes straight in and is never sent.
    act(() => openSlideWorkspaceApi.onAgentRequest?.({ kind: "draft-deck", deckPath: null }));
    await waitFor(() => expect(postedOfType(postMessage, "lattice:composer-prompt").at(-1)).toMatchObject({
      text: "Create a presentation about ", mode: "draft",
    }));
  });
});
