/**
 * The open documents of one project over an in-memory disk, for the tests of
 * useOpenDocuments and the hooks it composes. Import it before anything that
 * imports `@tauri-apps/api/core`, so its `vi.mock` is registered first.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode, PaperSummary, ProjectSnapshot } from "../app-types";
import { paperTabKey } from "../app-utils";
import { persistWorkspaceLayout, type WorkspaceLayout } from "../settings/app-settings";
import { useCanvasRequests } from "./use-canvas-requests";
import { paperDocumentPath, useOpenDocuments, type OpenDocumentsDeps } from "./use-open-documents";
import { useProjectState } from "./use-project-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.useRealTimers();
  localStorage.clear();
});

export const ROOT = "/project";
const file = (path: string, kind = path.endsWith(".png") || path.endsWith(".pdf") ? "figure" : "tex"): FileNode => ({
  name: path.split("/").at(-1) ?? path, path, kind, children: [],
});
export const PAPER: PaperSummary = { arxivId: "1706.03762", title: "Attention", authors: "Vaswani", hasFullText: true, hasBlog: true };
export const PAPER_TAB = paperTabKey(PAPER.arxivId);

export function snapshotOf(paths: string[], root = ROOT): ProjectSnapshot {
  return {
    root,
    manifest: {
      schemaVersion: 1, projectId: "paper", name: "Paper", trusted: false, primaryBibliography: "references.bib",
      rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
    },
    files: paths.map((path) => file(path)),
  } as ProjectSnapshot;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * Each line from whichever side changed it, and a line both sides changed
 * differently behind conflict markers, as the backend's merge writes them.
 * Line counts stay equal in these tests.
 */
function mergeLines(base: string, ours: string, theirs: string) {
  const [baseLines, ourLines, theirLines] = [base, ours, theirs].map((text) => text.split("\n"));
  let hadConflicts = false;
  const content = theirLines.map((line, index) => {
    const [mine, original] = [ourLines[index], baseLines[index]];
    if (mine === original || mine === line) return line;
    if (line === original) return mine;
    hadConflicts = true;
    return `<<<<<<< ours\n${mine}\n||||||| original\n${original}\n=======\n${line}\n>>>>>>> theirs`;
  }).join("\n");
  return { content, hadConflicts };
}

/**
 * The open documents of one project over an in-memory disk. `hold(command, path)` parks the next such call
 * until the test settles the returned deferred; everything else answers at once. With `"answer"`, the call
 * does its work at once and only its answer is parked, as when a write reaches disk before the app hears so.
 */
export function renderDocuments(disk: Record<string, string>, {
  paths = Object.keys(disk), papers = [] as PaperSummary[], layout = null as WorkspaceLayout | null,
  autoBuild = false,
} = {}) {
  const files = new Map(Object.entries(disk));
  const mtimes = new Map<string, number>();
  const held = new Map<string, { parked: ReturnType<typeof deferred<unknown>>; stage: "call" | "answer" }>();
  let snapshot = snapshotOf(paths);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { path } = (args ?? {}) as { path?: string };
    const hold = held.get(`${command}:${path ?? ""}`);
    if (!hold) return answer(command, args);
    held.delete(`${command}:${path ?? ""}`);
    if (hold.stage === "answer") {
      const result = await answer(command, args);
      await hold.parked.promise;
      return result;
    }
    const value = await hold.parked.promise;
    return value !== undefined ? value : answer(command, args);
  });
  const answer = async (command: string, args: unknown) => {
    const { path, content, baseContent } = (args ?? {}) as { path?: string; content?: string; baseContent?: string };
    switch (command) {
      case "read_project_file":
        if (!files.has(path!)) throw new Error(`No such file: ${path}`);
        return files.get(path!);
      case "write_project_file": {
        // Like the backend, merge with a disk that moved on since `baseContent`
        // (line by line here; see `mergeLines`).
        const disk = files.get(path!);
        const written = baseContent === undefined || disk === undefined || disk === baseContent
          ? { content: content!, hadConflicts: false }
          : mergeLines(baseContent, content!, disk);
        files.set(path!, written.content);
        mtimes.set(path!, (mtimes.get(path!) ?? 1) + 1);
        return written;
      }
      case "stat_project_file":
        return { exists: files.has(path!), mtimeMs: mtimes.get(path!) ?? 1 };
      case "read_project_asset":
        return { path, mimeType: "image/png", base64: "AA==" };
      case "read_paper":
        return files.get(paperDocumentPath((args as { arxivId: string }).arxivId, "fulltext")) ?? "Full text";
      case "read_paper_blog_local":
        return files.get(paperDocumentPath((args as { arxivId: string }).arxivId, "blog")) ?? "Overview";
      case "refresh_project":
        return snapshot;
      default:
        throw new Error(`unexpected ${command}`);
    }
  };
  if (layout) persistWorkspaceLayout(ROOT, layout);
  const deps = {
    onSaved: vi.fn(), onDiskEdit: vi.fn(),
    autoBuild: { enabled: autoBuild, afterSave: vi.fn(), afterDiskEdit: vi.fn() },
  };
  const view = renderHook(() => {
    const projectState = useProjectState();
    const canvas = useCanvasRequests();
    const documents = useOpenDocuments({
      projectState, papers, updateCanvasRequest: canvas.update, cancelPrewarm: () => {},
      refreshProject: async () => snapshot, ...deps,
    } satisfies OpenDocumentsDeps);
    return { projectState, canvas, documents };
  });
  const current = () => view.result.current.documents;
  /** Enter the project the way App does: restore its layout, run the (here instant) scans, finish. */
  const enter = async ({ beforeFinish, restorePapers = papers }: {
    beforeFinish?: () => Promise<void>; restorePapers?: PaperSummary[];
  } = {}) => {
    const { projectState, documents } = view.result.current;
    let restored = false;
    await act(async () => {
      projectState.beginTransition();
      documents.claim();
      const entry = documents.enter(snapshot);
      projectState.projectRef.current = snapshot;
      projectState.setProject(snapshot);
      restored = await entry.restore(restorePapers);
      if (!restored) return;
      await beforeFinish?.();
      entry.finish();
    });
    return restored;
  };
  /** Type into the document in front, as the canvas does. */
  const type = (text: string) => act(() => { current().canvas.setText(text); });
  return {
    view, deps, current, enter, type, files,
    hold: (command: string, path: string, stage: "call" | "answer" = "call") => {
      const parked = deferred<unknown>();
      held.set(`${command}:${path}`, { parked, stage });
      return parked;
    },
    setSnapshot: (paths: string[]) => { snapshot = snapshotOf(paths); },
    touch: (path: string, content: string) => {
      files.set(path, content);
      mtimes.set(path, (mtimes.get(path) ?? 1) + 10);
    },
  };
}

