import { beforeEach, describe, expect, it } from "vitest";

import {
  RECENT_PROJECTS_KEY,
  TUTORIAL_SEEN_KEY,
  WORKSPACE_LAYOUT_KEY,
  hasSeenTutorial,
  loadWorkspaceLayout,
  markTutorialSeen,
  persistWorkspaceLayout,
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
