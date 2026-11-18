import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "project-2" }) }));

const { flushWindowProjectGroup, windowProjects } = await import("./window-projects");
const roots = () => windowProjects.get().map(({ root }) => root);

afterEach(async () => {
  await flushWindowProjectGroup();
  windowProjects.restore([]);
  host.invoke.mockReset();
});

describe("the projects in this window", () => {
  it("adds a project entered beside the one it replaced, and keeps each one's place", () => {
    windowProjects.enter({ root: "/a", name: "A" }, null);
    windowProjects.enter({ root: "/c", name: "C" }, { root: "/a", name: "A" });
    windowProjects.enter({ root: "/b", name: "B" }, { root: "/a", name: "A" });
    expect(roots()).toEqual(["/a", "/b", "/c"]);
    // Switching between them moves nothing; a renamed project keeps its place.
    windowProjects.enter({ root: "/a", name: "A renamed" }, { root: "/b", name: "B" });
    expect(windowProjects.get()).toEqual([
      { root: "/a", name: "A renamed" }, { root: "/b", name: "B" }, { root: "/c", name: "C" },
    ]);
  });

  it("serializes rapid updates, including a reorder with no active-tab change", async () => {
    let finish!: () => void;
    const firstSave = new Promise<void>((resolve) => { finish = resolve; });
    host.invoke.mockReturnValueOnce(firstSave).mockResolvedValue(null);
    const a = { root: "/a", name: "A" };
    const b = { root: "/b", name: "B" };
    windowProjects.enter(a, null);
    windowProjects.enter(b, a);
    windowProjects.reorder(b.root, a.root);
    await Promise.resolve();
    expect(host.invoke).toHaveBeenCalledExactlyOnceWith("save_project_tab_group", {
      group: { activeRoot: a.root, projects: [a] },
    });
    finish();
    await flushWindowProjectGroup();
    expect(host.invoke).toHaveBeenLastCalledWith("save_project_tab_group", {
      group: { activeRoot: b.root, projects: [b, a] },
    });
  });

  it("is kept for this window's page under its label, for a reload", () => {
    const listener = vi.fn();
    const stop = windowProjects.subscribe(listener);
    windowProjects.enter({ root: "/a", name: "A" }, null);
    windowProjects.remove("/a");
    windowProjects.remove("/a");
    stop();
    expect(listener).toHaveBeenCalledTimes(2);
    windowProjects.enter({ root: "/b", name: "B" }, null);
    expect(JSON.parse(sessionStorage.getItem("lattice.window-projects.v1:project-2") ?? "null")).toEqual([{ root: "/b", name: "B" }]);
  });
});
