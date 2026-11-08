/**
 * A co-author typing in Overleaf, and the builds it starts here.
 *
 * Their operations arrive on the realtime channel and are written into the
 * open file one by one. Each used to ask for a build of its own, whatever the
 * Build setting said: with someone typing, Lattice compiled and reloaded the
 * PDF once per key they pressed (57 builds in 15 s on the bench). These run
 * the real channel, the real delivery into the editor and the real build
 * pipeline over a mocked backend whose writes the project watcher reports.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { createOverleafConnectionStore } from "../overleaf/overleaf-connection-store";
import { useOverleafRealtime } from "../overleaf/use-overleaf-realtime";
import type { BuildPreferences } from "../settings/app-settings";
import { applyOverleafRemoteText } from "./overleaf-remote-text";
import { useBuildPipeline } from "./use-build-pipeline";
import { WATCHED_BUILD_IDLE_MS } from "./watched-builds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const eventHandlers = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = eventHandlers.get(event) ?? new Set();
    eventHandlers.set(event, handlers);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }),
}));
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
  eventHandlers.clear();
});

const ROOT = "/project";
const DOC = "doc-main";
const PROJECT = {
  root: ROOT,
  manifest: { rootDocuments: [{ path: "main.tex", name: "main", isDefault: true }] },
  files: [],
} as unknown as ProjectSnapshot;
/** How fast the co-author types: the bench's cadence. */
const KEY_MS = 250;

function deliver(event: string, payload: unknown) {
  act(() => {
    for (const handler of eventHandlers.get(event) ?? []) handler({ payload });
  });
}

/** main.tex open and live in a project whose builds follow `autoBuildMode`; nothing typed here. */
async function renderCollaboration(autoBuildMode: BuildPreferences["autoBuildMode"]) {
  const ref = <T,>(current: T) => ({ current });
  const runBuild = ref<ReturnType<typeof useBuildPipeline>["runBuild"] | null>(null);
  const editor = {
    projectRef: ref<ProjectSnapshot | null>(PROJECT),
    projectOperationGenerationRef: ref(1),
    activeFileRef: ref("main.tex"),
    sourceRef: ref("alpha"),
    savedSourceRef: ref("alpha"),
    accept: (path: string, content: string, expect?: "clean" | { text?: string; saved?: string }) => {
      if (typeof expect !== "object" || editor.sourceRef.current !== expect.text
        || editor.savedSourceRef.current !== expect.saved || path !== editor.activeFileRef.current) return false;
      editor.sourceRef.current = editor.savedSourceRef.current = content;
      return true;
    },
    // App's Build button, which a remote edit used to press (App.tsx `compile`).
    compile: async () => { await runBuild.current?.(false, { requested: true, immediatePreview: true }); },
  };
  let builds = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case "overleaf_rt_connect": return {
        publicId: "me", docs: [{ id: DOC, path: "main.tex" }], entities: [],
        permission: "readAndWrite", trackChanges: false, userId: "me",
      };
      case "overleaf_rt_join_doc": return { text: "alpha", version: 10, comments: [], changes: [], caughtUp: [], resumed: false };
      case "write_project_file": {
        // fs_watch.rs reports the write a moment later, as a change nobody in the app saved.
        const { path } = args as { path: string };
        window.setTimeout(() => deliver("project-fs-changed", { root: ROOT, paths: [path] }), 50);
        return { written: true };
      }
      case "build_project":
        builds += 1;
        return {
          success: true, hasPdf: false, log: "", durationMs: 160, diagnostics: [], rootDocument: "main.tex",
          steps: [], pages: null, synctex: null, outputs: [],
        };
      default: return undefined;
    }
  });
  const store = createOverleafConnectionStore();
  const view = renderHook(() => {
    runBuild.current = useBuildPipeline({
      project: PROJECT, projectRef: editor.projectRef, setProject: vi.fn(),
      projectGenerationRef: editor.projectOperationGenerationRef,
      activeFileRef: editor.activeFileRef, sourceRef: editor.sourceRef, savedSourceRef: editor.savedSourceRef,
      agent: { takePendingCompiles: () => [], reportCompiles: vi.fn() },
      openDiagnosticRef: ref(async () => {}), onMissingTex: vi.fn(), autoBuildModeRef: ref(autoBuildMode),
    }).runBuild;
    return useOverleafRealtime({
      store, enabled: true, documents: true, projectRoot: ROOT, activeFile: "main.tex",
      onRemoteText: (text, context) => applyOverleafRemoteText(editor, text, context),
      onNotice: () => undefined,
    });
  });
  await waitFor(() => expect(view.result.current.liveFile).toBe(true));
  /** The co-author types `keys` one operation at a time, KEY_MS apart. */
  const coauthorTypes = async (keys: string) => {
    for (const key of keys) {
      const version = 10 + editor.sourceRef.current.length - "alpha".length;
      const before = editor.sourceRef.current;
      deliver("overleaf-realtime", {
        projectRoot: ROOT, type: "docUpdate", docId: DOC, version,
        ops: [{ p: before.length, i: key }], source: "coauthor",
      });
      await waitFor(() => expect(editor.sourceRef.current).toBe(before + key));
      await act(() => vi.advanceTimersByTimeAsync(KEY_MS));
    }
  };
  return { editor, builds: () => builds, coauthorTypes };
}

const idle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("a co-author's typing and the builds it starts", () => {
  it("builds once after a burst pauses, with automatic builds", async () => {
    const { editor, builds, coauthorTypes } = await renderCollaboration("automatic");
    await coauthorTypes(" is the first letter");
    expect(editor.sourceRef.current).toBe("alpha is the first letter");
    // Typing at KEY_MS never leaves the watcher's idle window, so nothing has built yet.
    expect(builds()).toBe(0);
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(builds()).toBe(1);
    expect(invoke).toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
  });

  it("never builds on its own with manual builds", async () => {
    const { editor, builds, coauthorTypes } = await renderCollaboration("manual");
    await coauthorTypes(" is the first letter");
    await idle(WATCHED_BUILD_IDLE_MS * 3);
    expect(editor.sourceRef.current).toBe("alpha is the first letter");
    expect(builds()).toBe(0);
  });
});
