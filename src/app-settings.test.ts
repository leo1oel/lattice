import { beforeEach, describe, expect, it } from "vitest";

import {
  RECENT_PROJECTS_KEY,
  TUTORIAL_SEEN_KEY,
  WORKSPACE_LAYOUT_KEY,
  forgetRecentProject,
  hasSeenTutorial,
  loadRecentProjects,
  loadWorkspaceLayout,
  markTutorialSeen,
  persistWorkspaceLayout,
  rememberRecentProject,
  type WorkspaceLayout,
} from "./app-settings";

const layout: WorkspaceLayout = {
  openTabs: ["main.tex", "sections/method.tex", "figures/model.png"],
  activeFile: "main.tex",
  activeTab: "sections/method.tex",
  secondaryFile: "sections/method.tex",
  focusedPane: "secondary",
  canvasMode: "columns",
  documentMode: "columns",
  paperView: "fulltext",
  tabRecency: ["sections/method.tex", "main.tex", "figures/model.png"],
};

describe("workspace layout persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips tab order, active tab, and split layout per project", () => {
    persistWorkspaceLayout("/papers/alpha", layout);
    expect(loadWorkspaceLayout("/papers/alpha")).toEqual(layout);
    expect(loadWorkspaceLayout("/papers/beta")).toBeNull();
  });

  it("deduplicates tabs and safely normalizes malformed fields", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({
      "/papers/alpha": {
        openTabs: ["main.tex", "main.tex", 12, ""],
        activeFile: "main.tex",
        activeTab: false,
        secondaryFile: 42,
        focusedPane: "somewhere",
        canvasMode: "impossible",
        paperView: "unknown",
        tabRecency: ["main.tex", "main.tex"],
      },
    }));

    expect(loadWorkspaceLayout("/papers/alpha")).toEqual({
      openTabs: ["main.tex"],
      activeFile: "main.tex",
      activeTab: "main.tex",
      secondaryFile: null,
      focusedPane: "primary",
      canvasMode: "split",
      documentMode: "split",
      paperView: "blog",
      tabRecency: ["main.tex"],
    });
  });

  it("migrates legacy Markdown and paper preview modes to unified preview", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({
      "/papers/markdown": { ...layout, canvasMode: "markdown-preview" },
      "/papers/imported": { ...layout, canvasMode: "paper" },
    }));

    expect(loadWorkspaceLayout("/papers/markdown")?.canvasMode).toBe("pdf");
    expect(loadWorkspaceLayout("/papers/imported")?.canvasMode).toBe("pdf");
  });

  it("treats corrupt storage as an empty workspace history", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, "not-json");
    expect(loadWorkspaceLayout("/papers/alpha")).toBeNull();
    expect(() => persistWorkspaceLayout("/papers/alpha", layout)).not.toThrow();
  });
});

describe("tutorial persistence", () => {
  beforeEach(() => localStorage.clear());

  it("remembers that the tutorial has been shown across app versions", () => {
    expect(hasSeenTutorial()).toBe(false);
    markTutorialSeen();
    expect(localStorage.getItem(TUTORIAL_SEEN_KEY)).toBe("1");
    expect(hasSeenTutorial()).toBe(true);
  });

  it("recognizes tutorial projects opened by an earlier version", () => {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify([{
      name: "Understanding Attention",
      path: "/Users/ada/Documents/Lattice Tutorials/Understanding Attention",
    }]));
    expect(hasSeenTutorial()).toBe(true);
    expect(localStorage.getItem(TUTORIAL_SEEN_KEY)).toBe("1");
  });
});

describe("recent projects across windows", () => {
  beforeEach(() => localStorage.clear());

  it("keeps what another window recorded while this one was open", () => {
    // Both windows share one localStorage. This window loaded its copy before
    // the other window opened "Notes"; writing that stale copy back is what
    // used to make Notes vanish from the list.
    rememberRecentProject({ name: "Paper", path: "/tmp/paper" });
    rememberRecentProject({ name: "Notes", path: "/tmp/notes" });

    const merged = rememberRecentProject({ name: "Paper", path: "/tmp/paper" });

    expect(merged.map((item) => item.path)).toEqual(["/tmp/paper", "/tmp/notes"]);
    expect(loadRecentProjects().map((item) => item.path)).toEqual(["/tmp/paper", "/tmp/notes"]);
  });

  it("does not resurrect a project another window is dropping", () => {
    rememberRecentProject({ name: "Paper", path: "/tmp/paper" });
    rememberRecentProject({ name: "Gone", path: "/tmp/gone" });

    const remaining = forgetRecentProject("/tmp/gone");

    expect(remaining.map((item) => item.path)).toEqual(["/tmp/paper"]);
    expect(loadRecentProjects().map((item) => item.path)).toEqual(["/tmp/paper"]);
  });

  it("caps the list so it cannot grow without bound", () => {
    for (let index = 0; index < 12; index += 1) {
      rememberRecentProject({ name: `P${index}`, path: `/tmp/p${index}` });
    }

    expect(loadRecentProjects()).toHaveLength(8);
    expect(loadRecentProjects()[0].path).toBe("/tmp/p11");
  });
});
