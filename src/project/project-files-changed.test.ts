import { afterEach, expect, it, vi } from "vitest";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { changesReach, onProjectFilesChanged } from "./project-files-changed";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => vi.mocked(listen).mockReset());

type Payload = { root: string; paths?: string[] | null };

/** Subscribe, and hand back the watcher's side: emit an event, and the listener's unlisten mock. */
async function subscribe(root: string, onChange: (paths: readonly string[] | null) => void) {
  let handler: EventCallback<Payload> = () => undefined;
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    handler = callback as EventCallback<Payload>;
    return unlisten;
  });
  const stop = onProjectFilesChanged(root, onChange);
  await Promise.resolve();
  const emit = (payload: Payload) => handler({ event: "project-fs-changed", id: 1, payload });
  return { stop, emit, unlisten };
}

it("reports changes under its own project only, with the exact paths when the watcher knows them", async () => {
  const onChange = vi.fn();
  const { emit } = await subscribe("/project", onChange);
  expect(listen).toHaveBeenCalledWith("project-fs-changed", expect.any(Function));
  emit({ root: "/elsewhere", paths: ["main.tex"] });
  emit({ root: "/project", paths: ["main.tex", "figures/a.png"] });
  emit({ root: "/project", paths: null });
  emit({ root: "/project", paths: [] });
  expect(onChange.mock.calls).toEqual([[["main.tex", "figures/a.png"]], [null], [null]]);
});

it("stops reporting once disposed, even when the subscription arrives after that", async () => {
  const onChange = vi.fn();
  let resolveListen: (unlisten: () => void) => void = () => undefined;
  let handler: EventCallback<Payload> = () => undefined;
  vi.mocked(listen).mockImplementation((_event, callback) => {
    handler = callback as EventCallback<Payload>;
    return new Promise((resolve) => { resolveListen = resolve; });
  });
  const stop = onProjectFilesChanged("/project", onChange);
  stop();
  const unlisten = vi.fn();
  resolveListen(unlisten);
  await Promise.resolve();
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledTimes(1);
  handler({ event: "project-fs-changed", id: 1, payload: { root: "/project" } });
  expect(onChange).not.toHaveBeenCalled();
});

it("does nothing where there is no native event bridge to listen on", async () => {
  vi.mocked(listen).mockRejectedValue(new Error("no bridge"));
  const stop = onProjectFilesChanged("/project", vi.fn());
  await Promise.resolve();
  expect(() => stop()).not.toThrow();
});

it("reaches a file through its own path, a folder holding it, or an unknown set", () => {
  expect(changesReach(null, "figures/plot.pdf")).toBe(true);
  expect(changesReach(["./figures/plot.pdf"], "figures/plot.pdf")).toBe(true);
  expect(changesReach(["figures"], "figures/plot.pdf")).toBe(true);
  // A path that cannot be placed in the project may be anything.
  expect(changesReach(["../elsewhere"], "figures/plot.pdf")).toBe(true);
  expect(changesReach(["figures/plot.pdf.tmp", "figures-old", "notes.md"], "figures/plot.pdf")).toBe(false);
});
