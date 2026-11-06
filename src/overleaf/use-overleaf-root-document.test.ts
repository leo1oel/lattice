import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { notifyInfo, notifyWarning } from "../telemetry/app-notify";
import { createOverleafConnectionStore } from "./overleaf-connection-store";
import { useOverleafRootDocument } from "./use-overleaf-root-document";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn(), notifyWarning: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(notifyInfo).mockReset();
  vi.mocked(notifyWarning).mockReset();
});

function follow(answer: () => Promise<unknown>) {
  vi.mocked(invoke).mockImplementation(answer);
  const store = createOverleafConnectionStore();
  const refreshProject = vi.fn(async () => ({}) as ProjectSnapshot);
  renderHook(() => useOverleafRootDocument(store, "/paper", refreshProject, { current: 7 }));
  const name = (rootDocument: string | null) => act(() => store.getState().showDocumentTree([], [], rootDocument));
  return { refreshProject, name };
}

it("asks the backend to follow each main document the channel names, and re-reads the project when it did", async () => {
  const { refreshProject, name } = follow(async () => ({ rootDocuments: [{ path: "main_v2.tex", isDefault: true }] }));
  expect(invoke).not.toHaveBeenCalled();

  name("main_v2.tex");
  // The path is the backend's own record of this project's connection, never the request's.
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_adopt_root_document", { projectRoot: "/paper" }));
  await waitFor(() => expect(refreshProject).toHaveBeenCalledWith({ expectedRoot: "/paper", generation: 7 }));
  expect(vi.mocked(notifyInfo).mock.calls[0]?.[1]).toMatch(/main_v2\.tex/);

  // A disconnect names none, which asks nothing.
  name(null);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("leaves the project alone when the backend kept the writer's choice, and says so when it failed", async () => {
  const kept = follow(async () => null);
  kept.name("main_v2.tex");
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(kept.refreshProject).not.toHaveBeenCalled();
  cleanup();

  const failed = follow(async () => Promise.reject(new Error("lease lost")));
  failed.name("main_v2.tex");
  await waitFor(() => expect(notifyWarning).toHaveBeenCalledWith("Overleaf", expect.stringMatching(/main_v2\.tex/), { detail: "lease lost" }));
});
