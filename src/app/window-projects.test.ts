import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "project-2" }) }));

const { windowProjects } = await import("./window-projects");
const roots = () => windowProjects.get().map(({ root }) => root);

afterEach(() => {
  for (const root of roots()) windowProjects.remove(root);
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
