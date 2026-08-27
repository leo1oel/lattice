import { beforeEach, describe, expect, it } from "vitest";

import {
  APPEARANCE_KEY,
  FILE_VIEW_STATES_KEY,
  RECENT_PROJECTS_KEY,
  LOCAL_SEMANTIC_SEARCH_KEY,
  TUTORIAL_SEEN_KEY,
  WORKSPACE_LAYOUT_KEY,
  forgetRecentProject,
  hasSeenTutorial,
  loadAppearance,
  loadFileViewStates,
  loadLocalSemanticSearchEnabled,
  loadRecentProjects,
  loadWorkspaceLayout,
  markTutorialSeen,
  persistFileViewStates,
  persistLocalSemanticSearchEnabled,
  persistWorkspaceLayout,
  rememberRecentProject,
  resolveAppLocale,
  type WorkspaceLayout,
} from "./app-settings";

const layout: WorkspaceLayout = {
  openTabs: ["main.tex", "sections/method.tex", "figures/model.png"],
  activeFile: "main.tex",
  activeTab: "sections/method.tex",
  secondaryFile: "sections/method.tex",
  focusedPane: "secondary",
  canvasMode: "dual",
  documentMode: "dual",
  paperView: "fulltext",
  tabRecency: ["sections/method.tex", "main.tex", "figures/model.png"],
};

describe("interface language persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the system and restores explicit overrides", () => {
    expect(loadAppearance().interfaceLanguage).toBe("system");
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: "zh-CN" }));
    expect(loadAppearance().interfaceLanguage).toBe("zh-CN");
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: "en" }));
    expect(loadAppearance().interfaceLanguage).toBe("en");
  });

  it("follows Chinese system locales and falls back to English", () => {
    expect(resolveAppLocale("system", ["zh-CN"])).toBe("zh-CN");
    expect(resolveAppLocale("system", ["zh-Hans"])).toBe("zh-CN");
    expect(resolveAppLocale("system", ["zh-TW"])).toBe("zh-CN");
    expect(resolveAppLocale("system", ["fr-FR", "zh-HK"])).toBe("zh-CN");
    expect(resolveAppLocale("system", ["en-US"])).toBe("en");
    expect(resolveAppLocale("system", ["fr-FR"])).toBe("en");
  });

  it("keeps explicit choices when they differ from the system language", () => {
    expect(resolveAppLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveAppLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("returns to following the system for unsupported stored locales", () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: "fr" }));
    expect(loadAppearance().interfaceLanguage).toBe("system");
  });
});

describe("prose spellcheck default", () => {
  beforeEach(() => localStorage.clear());

  it("is on for fresh installs and for settings saved before the toggle existed", () => {
    expect(loadAppearance().editorSpellcheck).toBe(true);
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ editorFontSize: 16 }));
    expect(loadAppearance().editorSpellcheck).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ editorSpellcheck: false }));
    expect(loadAppearance().editorSpellcheck).toBe(false);
  });
});

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

  it("migrates the former three-column layout to two editor panes", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({
      "/papers/alpha": { ...layout, canvasMode: "columns", documentMode: "columns" },
    }));

    expect(loadWorkspaceLayout("/papers/alpha")).toEqual({
      ...layout,
      canvasMode: "dual",
      documentMode: "dual",
    });
  });

  it("treats corrupt storage as an empty workspace history", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, "not-json");
    expect(loadWorkspaceLayout("/papers/alpha")).toBeNull();
    expect(() => persistWorkspaceLayout("/papers/alpha", layout)).not.toThrow();
  });
});

describe("local file view state persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips each file's local view without mixing projects", () => {
    persistFileViewStates("/papers/alpha", {
      "main.tex": { text: { cursor: 42, scrollTop: 320 } },
      "data.lattice-sheet": {
        spreadsheet: {
          activeSheetId: "sheet-2",
          activeRange: "B4:D8",
          activeCell: "B4",
          sheets: {
            "sheet-1": { zoomRatio: 1, scrollTop: 0, scrollLeft: 0 },
            "sheet-2": { zoomRatio: 1.4, scrollTop: 240, scrollLeft: 80 },
          },
        },
      },
      "figures/model.png": {
        image: { scale: 1.6, scrollTop: 120, scrollLeft: 45 },
      },
      "paper.pdf": {
        pdf: { page: 7, scale: 1.25, fitMode: "width", scrollTop: 720, scrollLeft: 12 },
      },
      "sketch.tldr": {
        board: { pageId: "page:ideas", camera: { x: -120, y: 64, z: 1.8 } },
      },
      "report.html": {
        html: { scale: 1.25, scrollTop: 840, scrollRange: 3200 },
      },
      "notes.md": {
        visualMarkdown: { scrollTop: 460, scrollRange: 1800 },
      },
    });

    expect(loadFileViewStates("/papers/alpha")).toEqual({
      "main.tex": { text: { cursor: 42, scrollTop: 320 } },
      "data.lattice-sheet": {
        spreadsheet: {
          activeSheetId: "sheet-2",
          activeRange: "B4:D8",
          activeCell: "B4",
          sheets: {
            "sheet-1": { zoomRatio: 1, scrollTop: 0, scrollLeft: 0 },
            "sheet-2": { zoomRatio: 1.4, scrollTop: 240, scrollLeft: 80 },
          },
        },
      },
      "figures/model.png": {
        image: { scale: 1.6, scrollTop: 120, scrollLeft: 45 },
      },
      "paper.pdf": {
        pdf: { page: 7, scale: 1.25, fitMode: "width", scrollTop: 720, scrollLeft: 12 },
      },
      "sketch.tldr": {
        board: { pageId: "page:ideas", camera: { x: -120, y: 64, z: 1.8 } },
      },
      "report.html": {
        html: { scale: 1.25, scrollTop: 840, scrollRange: 3200 },
      },
      "notes.md": {
        visualMarkdown: { scrollTop: 460, scrollRange: 1800 },
      },
    });
    expect(loadFileViewStates("/papers/beta")).toEqual({});
  });

  it("drops corrupt entries while retaining valid sibling state", () => {
    localStorage.setItem(FILE_VIEW_STATES_KEY, JSON.stringify({
      "/papers/alpha": {
        "main.tex": {
          text: { cursor: 12, scrollTop: 50 },
          pdf: { page: "two", scale: 1, fitMode: "width", scrollTop: 0, scrollLeft: 0 },
        },
        "legacy.html": { html: { scrollTop: 300, scrollRange: 900 } },
        "broken.tex": { text: { cursor: -1, scrollTop: "top" } },
      },
    }));

    expect(loadFileViewStates("/papers/alpha")).toEqual({
      "main.tex": { text: { cursor: 12, scrollTop: 50 } },
      "legacy.html": { html: { scale: 1, scrollTop: 300, scrollRange: 900 } },
    });
  });

  it("bounds local view history by recent files and projects", () => {
    persistFileViewStates("/papers/large", Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        `file-${index}.tex`,
        { text: { cursor: index, scrollTop: index } },
      ]),
    ));
    const files = loadFileViewStates("/papers/large");
    expect(Object.keys(files)).toHaveLength(200);
    expect(files["file-4.tex"]).toBeUndefined();
    expect(files["file-5.tex"]).toBeDefined();

    for (let index = 0; index < 60; index += 1) {
      persistFileViewStates(`/papers/project-${index}`, {
        "main.tex": { text: { cursor: index, scrollTop: 0 } },
      });
    }
    const projects = JSON.parse(
      localStorage.getItem(FILE_VIEW_STATES_KEY) ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.keys(projects)).toHaveLength(60);
    expect(projects["/papers/large"]).toBeUndefined();
    expect(projects["/papers/project-59"]).toBeDefined();
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

describe("local semantic search opt-in", () => {
  beforeEach(() => localStorage.clear());

  it("is disabled until the user explicitly enables it", () => {
    expect(loadLocalSemanticSearchEnabled()).toBe(false);
    expect(localStorage.getItem(LOCAL_SEMANTIC_SEARCH_KEY)).toBeNull();

    persistLocalSemanticSearchEnabled(true);
    expect(loadLocalSemanticSearchEnabled()).toBe(true);

    persistLocalSemanticSearchEnabled(false);
    expect(loadLocalSemanticSearchEnabled()).toBe(false);
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
