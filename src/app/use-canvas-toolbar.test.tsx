import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasToolbar } from "./use-canvas-toolbar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

/** Project A is in review mode; every other project is not. */
function reviewModeIn(root: string) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "review_mode_load") return (args as { projectRoot: string }).projectRoot === root ? { startedAt: "2026-11-08T00:00:00Z", bases: {}, excluded: [] } : null;
    return null;
  });
}

function toolbarFor(projectRoot: string | null) {
  const overleaf = {
    overleafLink: null, overleafSyncMode: "live", overleafSyncing: false, overleafRemoteChanges: false,
    overleafRealtime: { status: "off", detail: null, liveFile: false, changes: [] },
    overleafPresence: { peers: [], reconnecting: false }, overleafChat: { unread: 0, refresh: vi.fn() },
    overleafComments: { threads: [] }, overleafDocPaths: new Map(),
  };
  return renderHook((root: string | null) => useCanvasToolbar({
    // A figure in front: no source editor, so no review bar, is mounted.
    documents: { paper: null, asset: null, activeTab: "figure.png", dirty: false, file: "", bufferText: () => null, projectRoot: root },
    tools: { open: vi.fn() }, commentCount: 0, comments: { comments: [] }, inBrowserTab: false,
    onMoveWorkspace: vi.fn(), hiddenTools: [], overleaf: overleaf as never, onOverleafSync: vi.fn(),
  }), { initialProps: projectRoot });
}

describe("the toolbar's Track changes", () => {
  it("follows the project in front, with no source editor open", async () => {
    reviewModeIn("/a");
    const hook = toolbarFor("/a");
    const shown = render(hook.result.current);
    await waitFor(() => {
      shown.rerender(hook.result.current);
      expect(screen.getByRole("button", { name: "Stop tracking changes" })).toBeInTheDocument();
    });

    hook.rerender("/b");
    await waitFor(() => {
      shown.rerender(hook.result.current);
      expect(screen.getByRole("button", { name: "Track changes" })).toBeInTheDocument();
    });
    expect(invoke).toHaveBeenCalledWith("review_mode_load", { projectRoot: "/b" });
  });
});
