import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { persistLivePreviewEnabled } from "../settings/app-settings";
import { useLivePreview, type LivePreviewInstall } from "./use-live-preview";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const started = vi.hoisted(() => [] as string[]);
vi.mock("./live-preview-chunk", () => ({
  LivePreviewSession: class {
    constructor(root: string, main: string) { started.push(main === "main.tex" ? root : `${root}:${main}`); }
    start = vi.fn(async () => {});
    dispose = vi.fn();
    noteText = vi.fn();
    noteFilesChanged = vi.fn();
  },
}));

const READY: LivePreviewInstall = { supported: true, lualatex: true, installed: false, version: "0.0.5-cd.1" };
let install: LivePreviewInstall;
let download: () => Promise<unknown>;

function project(root: string, engine = "lualatex", main = "main.tex") {
  return {
    root,
    files: [],
    manifest: { engine, rootDocuments: [{ path: main, name: "Main paper", isDefault: true }] },
  } as unknown as ProjectSnapshot;
}

function open(root: string, engine?: string, main?: string) {
  return renderHook(
    ({ snapshot }) => useLivePreview({ project: snapshot, activeFile: main ?? "main.tex", source: "", savedSource: "" }),
    { initialProps: { snapshot: project(root, engine, main) } },
  );
}

const commands = () => vi.mocked(invoke).mock.calls.map(([command]) => command);

beforeEach(() => {
  localStorage.clear();
  started.length = 0;
  install = { ...READY };
  download = async () => ({ ...install, installed: true });
  // jsdom has no idle callbacks; run the deferred download on the next task.
  Object.assign(window, { requestIdleCallback: (run: () => void) => setTimeout(run, 0), cancelIdleCallback: clearTimeout });
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string) => {
    if (command === "live_preview_status") return install;
    if (command === "live_preview_install") return download();
    if (command === "live_preview_remove") return { ...install, installed: false };
    return null;
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(window, "cancelIdleCallback");
});

it("is on by default in a LuaLaTeX project: downloads rtex in the background and starts it", async () => {
  const { result } = open("/papers/lua");
  expect(result.current.enabled).toBe(true);
  await waitFor(() => expect(result.current.state.kind).toBe("running"));
  expect(commands()).toEqual(["live_preview_status", "live_preview_install"]);
  expect(started).toEqual(["/papers/lua"]);
});

it("is not offered to pdfLaTeX projects and asks the host nothing", async () => {
  const { result } = open("/papers/pdf", "pdf");
  expect(result.current.available).toBe(false);
  await act(async () => {});
  expect(result.current.state.kind).toBe("off");
  expect(commands()).toEqual([]);
});

it.each([
  ["an Intel Mac", { supported: false, lualatex: false }],
  ["a Mac without a working LuaLaTeX", { supported: true, lualatex: false }],
])("downloads nothing on %s and keeps the PDF panel quiet", async (_host, host) => {
  install = { ...READY, ...host };
  const { result } = open("/papers/lua");
  await waitFor(() => expect(result.current.state.kind).toBe("unavailable"));
  expect(commands()).toEqual(["live_preview_status"]);
  expect(started).toEqual([]);
});

it("starts on a main document in a subfolder: rtex typesets it from its own folder, as the build does", async () => {
  // A LuaLaTeX statement in cv/sop with \bibliography{../../references}.
  install = { ...READY, installed: true };
  const { result } = open("/papers/personal", "lualatex", "cv/sop/sop.tex");
  await waitFor(() => expect(result.current.state.kind).toBe("running"));
  expect(started).toEqual(["/papers/personal:cv/sop/sop.tex"]);
});

it("falls back quietly when the download fails, and retries on request", async () => {
  download = async () => { throw new Error("Could not download the rtex live preview engine: offline"); };
  const { result } = open("/papers/lua");
  await waitFor(() => expect(result.current.state).toEqual({
    kind: "download-failed",
    message: "Could not download the rtex live preview engine: offline",
  }));
  expect(started).toEqual([]);
  download = async () => ({ ...install, installed: true });
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.state.kind).toBe("running"));
  expect(commands().filter((command) => command === "live_preview_install")).toHaveLength(2);
});

it("keeps a project the writer turned off off, without asking the host", async () => {
  persistLivePreviewEnabled("/papers/lua", false);
  const { result } = open("/papers/lua");
  await act(async () => {});
  expect(result.current.enabled).toBe(false);
  expect(result.current.state.kind).toBe("off");
  expect(commands()).toEqual([]);
});

it("turning it off sticks across reopening, and removing rtex turns the default off", async () => {
  install = { ...READY, installed: true };
  const first = open("/papers/a");
  await waitFor(() => expect(first.result.current.state.kind).toBe("running"));
  act(() => first.result.current.setEnabled(false));
  expect(first.result.current.state.kind).toBe("off");
  first.unmount();
  expect(open("/papers/a").result.current.enabled).toBe(false);

  const second = open("/papers/b");
  expect(second.result.current.enabled).toBe(true);
  await act(async () => { await second.result.current.remove(); });
  expect(second.result.current.enabled).toBe(false);
  second.unmount();
  // Not on by default anywhere once rtex is removed, until chosen again.
  expect(open("/papers/c").result.current.enabled).toBe(false);
  const chosen = open("/papers/b");
  act(() => chosen.result.current.setEnabled(true));
  expect(chosen.result.current.enabled).toBe(true);
});
