import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ProjectSnapshot } from "../app-types";
import { useSynaraHost } from "../app/use-synara-host";
import { registerAgentCanvasAdapter } from "./agent-canvas-tools";
import { registerAgentSpreadsheetDocumentResolver } from "./agent-spreadsheet-tools";
import { seedSpreadsheetDoc } from "../editor/spreadsheet/spreadsheet-yjs";
import { readSpreadsheet } from "../editor/spreadsheet/spreadsheet-operations";

vi.mock("./use-synara-runtime", () => ({ useSynaraRuntime: () => ({ runtime: {
  state: "ready", origin: "https://agent.example", authToken: null, message: null,
  startupMs: null, version: null, revision: null, workspaceMode: "staged-explicit-writeback",
}, retry: vi.fn() }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => { cleanup(); while (cleanups.length) cleanups.pop()?.(); });

it("refuses real host editing consumers reached through a correctly scoped iframe message", async () => {
  const creator = vi.fn(async () => "new.tldr");
  const canvas = { execute: vi.fn(() => ({ deleted: true })) };
  cleanups.push(registerAgentCanvasAdapter("board.tldr", canvas));
  const doc = new Y.Doc(); seedSpreadsheetDoc(doc);
  const commit = vi.fn(async () => undefined);
  cleanups.push(() => doc.destroy());
  cleanups.push(registerAgentSpreadsheetDocumentResolver(async (path) => ({ doc, path, canWrite: true, commit, dispose: () => undefined })));
  const project = { root: "/projects/paper", files: [], manifest: { schemaVersion: 1, projectId: "test", name: "Test", rootDocuments: [], primaryBibliography: "refs.bib", trusted: false } } satisfies ProjectSnapshot;
  const bridge = {
    openProviderSettings: vi.fn(), openProjectPath: vi.fn(), openReview: vi.fn(), clearSelection: vi.fn(),
    flushVisualMarkdown: vi.fn(), agentCommentsOptions: () => null, annotationTools: () => null,
    projectDocumentCreator: () => creator, onHistorySnapshot: vi.fn(), onMinimumWidth: vi.fn(),
  };
  const { result } = renderHook(() => useSynaraHost({ project, projectRef: { current: project }, agentVisible: false, bridge,
    appearance: { theme: "light", tint: "paper", accent: "blue", translucency: "off", translucent: false },
  }));
  const frame = document.createElement("iframe"); document.body.append(frame);
  cleanups.push(() => frame.remove());
  act(() => { result.current.frameRef.current = frame; });
  const posted = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined);
  const send = (data: object) => act(() => window.dispatchEvent(new MessageEvent("message", {
    data, source: frame.contentWindow, origin: "https://agent.example",
  })));
  const envelope = { version: 1, expiresAt: Date.now() + 10_000 };
  send({ ...envelope, type: "synara:project-document-tool-request", id: "create", args: { path: "new.tldr", documentType: "board" } });
  send({ ...envelope, type: "synara:canvas-tool-request", id: "canvas", action: "delete", args: { ids: ["shape:1"] } });
  send({ ...envelope, type: "synara:spreadsheet-tool-request", id: "sheet", action: "batch_update", args: {
    path: "data.lattice-sheet", operations: [{ type: "set_values", range: "A1", values: [["host bypass"]] }],
  } });
  for (const id of ["create", "canvas", "sheet"]) await waitFor(() => expect(posted).toHaveBeenCalledWith(expect.objectContaining({
    id, ok: false, error: expect.objectContaining({ code: "headless_staged_tool_unsupported" }),
  }), "https://agent.example"));
  expect(creator).not.toHaveBeenCalled(); expect(canvas.execute).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  expect(readSpreadsheet(doc, { range: "A1", include: ["values"] }).values).not.toEqual([["host bypass"]]);
  send({ type: "lattice:request-host-theme" });
  await waitFor(() => expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: "lattice:host-theme" }), "https://agent.example"));
  expect(bridge.flushVisualMarkdown).not.toHaveBeenCalled();
});
