import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompileDiagnostic } from "./compile-diagnostics";
import { useTexlabDiagnostics } from "./use-texlab-diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Update = { requestId: string; diagnostics: CompileDiagnostic[] };
const handlers: EventCallback<Update>[] = [];
const disposers: ReturnType<typeof vi.fn>[] = [];
const warning: CompileDiagnostic = { file: "main.tex", line: 3, level: "warning", message: "Undefined reference `fixed'." };
const initial = { root: "/paper", path: "main.tex", text: "original", build: { success: true } };

function Surface({ root, path, text, build }: typeof initial) {
  const diagnostics = useTexlabDiagnostics(root, path, text, build);
  return <ul aria-label="Diagnostics">{diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul>;
}

function requestId() {
  return (vi.mocked(invoke).mock.calls.at(-1)![1] as { requestId: string }).requestId;
}

function publish(id: string, diagnostics: CompileDiagnostic[]) {
  act(() => {
    // Include disposed handlers deliberately: late deliveries must be harmless.
    for (const handler of handlers) handler({ event: "texlab-diagnostics", id: 1, payload: { requestId: id, diagnostics } });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  handlers.length = 0;
  disposers.length = 0;
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    handlers.push(handler as EventCallback<Update>);
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("renders later publications and clears warnings while idle, without another sync", async () => {
  vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
    const { requestId: id } = args as { requestId: string };
    for (const handler of handlers) {
      handler({ event: "texlab-diagnostics", id: 1, payload: { requestId: id, diagnostics: [warning] } });
    }
  });
  render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(699));
  expect(invoke).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  const id = requestId();
  expect(listen).toHaveBeenCalledWith("texlab-diagnostics", expect.any(Function));
  expect(screen.getByText(warning.message)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  publish(id, []);
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects obsolete updates across edits, files, projects and non-TeX views", async () => {
  const view = render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  let oldId = requestId();
  publish(oldId, [warning]);
  for (const props of [
    { ...initial, text: "corrected" },
    { ...initial, path: "chapter.tex" },
    { ...initial, root: "/other-paper" },
  ]) {
    view.rerender(<Surface {...props} />);
    publish(oldId, [warning]);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(700));
    const id = requestId();
    expect(id).not.toBe(oldId);
    publish(oldId, [warning]);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    publish(id, [{ ...warning, message: "Current warning" }]);
    expect(screen.getByText("Current warning")).toBeInTheDocument();
    oldId = id;
  }
  view.rerender(<Surface {...initial} path="notes.md" />);
  publish(oldId, [warning]);
  await act(() => vi.advanceTimersByTimeAsync(700));
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
});

it("does not revive cached warnings when returning to a previous file", async () => {
  const view = render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  const id = requestId();
  publish(id, [warning]);
  view.rerender(<Surface {...initial} path="other.tex" />);
  view.rerender(<Surface {...initial} />);
  publish(id, [warning]);
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("resyncs after each build even with unchanged source and success", async () => {
  const view = render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  const id = requestId();
  publish(id, [warning]);
  view.rerender(<Surface {...initial} build={{ success: true }} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(requestId()).not.toBe(id);
  expect(invoke).toHaveBeenLastCalledWith("texlab_diagnostics", {
    projectRoot: "/paper", path: "main.tex", text: "original", requestId: expect.any(String),
  });
  publish(id, [warning]);
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("disposes a late listener without syncing an abandoned document", async () => {
  let resolve!: (dispose: UnlistenFn) => void;
  vi.mocked(listen).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  view.unmount();
  const dispose = vi.fn();
  await act(async () => { resolve(dispose); });
  expect(dispose).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});

it("serializes slow syncs and skips superseded edits even after a failure", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const view = render(<Surface {...initial} />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  const oldId = requestId();
  view.rerender(<Surface {...initial} text="intermediate" />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  view.rerender(<Surface {...initial} text="latest" />);
  await act(() => vi.advanceTimersByTimeAsync(700));
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error("TexLab exited")); });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("texlab_diagnostics", expect.objectContaining({ text: "latest" }));
  publish(requestId(), [{ ...warning, message: "Latest diagnostic" }]);
  publish(oldId, [warning]);
  expect(screen.getByText("Latest diagnostic")).toBeInTheDocument();
  expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
});
