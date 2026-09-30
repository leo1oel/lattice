import { beforeEach, describe, expect, it } from "vitest";

import {
  APPEARANCE_KEY,
  FILE_VIEW_STATES_KEY,
  TUTORIAL_SEEN_KEY,
  WORKSPACE_LAYOUT_KEY,
  forgetRecentProject,
  hasSeenTutorial,
  loadAppearance,
  loadFileViewStates,
  loadRecentProjects,
  loadWorkspaceLayout,
  markTutorialSeen,
  persistFileViewStates,
  persistWorkspaceLayout,
  rememberRecentProject,
  resolveAppLocale,
  type WorkspaceLayout,
} from "./app-settings";
import type { FileViewState } from "../app-types";

beforeEach(() => localStorage.clear());

const layout: WorkspaceLayout = {
  openTabs: ["main.tex", "sections/method.tex", "figures/model.png"],
  pinnedTabs: ["main.tex"],
  activeFile: "main.tex",
  activeTab: "sections/method.tex",
  secondaryFile: "sections/method.tex",
  focusedPane: "secondary",
  canvasMode: "source",
  documentMode: "source",
  paperView: "fulltext",
  tabRecency: ["sections/method.tex", "main.tex", "figures/model.png"],
};

describe("interface language persistence", () => {
  // An unsupported stored locale returns to following the system.
  it.each([[undefined, "system"], ["zh-CN", "zh-CN"], ["en", "en"], ["fr", "system"]])("loads a stored language of %s as %s", (stored, language) => {
    if (stored) localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ interfaceLanguage: stored }));
    expect(loadAppearance().interfaceLanguage).toBe(language);
  });

  it.each([
    ["system", ["zh-CN"], "zh-CN"], ["system", ["zh-Hans"], "zh-CN"], ["system", ["zh-TW"], "zh-CN"],
    // Only the system's first preference chooses; everything else is English.
    ["system", ["en-US", "zh-CN"], "en"], ["system", ["fr-FR", "zh-HK"], "en"],
    ["system", ["en-US"], "en"], ["system", ["fr-FR"], "en"],
    // Explicit choices hold even when they differ from the system language.
    ["en", ["zh-CN"], "en"], ["zh-CN", ["en-US"], "zh-CN"],
  ] as const)("resolves %s with system languages %j to %s", (preference, languages, locale) => {
    expect(resolveAppLocale(preference, languages)).toBe(locale);
  });
});

describe("fixed application fonts", () => {
  it.each([APPEARANCE_KEY, "lattice.appearance.v4", "lattice.appearance.v3"])(
    "normalizes old font choices from %s without losing other preferences",
    (key) => {
      const defaults = loadAppearance();
      expect(defaults.uiFont).toBe('"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif');
      expect(defaults.editorFont).toBe('"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace');
      for (const editorFont of ['"MonoLisa", Menlo, monospace', defaults.editorFont, null]) {
        localStorage.setItem(key, JSON.stringify({ uiFont: "-apple-system", editorFont, editorFontSize: 18, editorKeymap: "vim" }));
        expect(loadAppearance()).toEqual({ ...defaults, editorFontSize: 18, editorKeymap: "vim" });
      }
    },
  );
});

describe("prose spellcheck default", () => {
  // On for fresh installs and for settings saved before the toggle existed;
  // only an explicit opt-out turns it off.
  it.each([[null, true], [{ editorFontSize: 16 }, true], [{ editorSpellcheck: false }, false]])(
    "loads %j as %s",
    (stored, enabled) => {
      if (stored) localStorage.setItem(APPEARANCE_KEY, JSON.stringify(stored));
      expect(loadAppearance().editorSpellcheck).toBe(enabled);
    },
  );
});

describe("workspace layout persistence", () => {
  it("round-trips tab order, active tab, and split layout per project", () => {
    persistWorkspaceLayout("/papers/alpha", layout);
    expect(loadWorkspaceLayout("/papers/alpha")).toEqual(layout);
    expect(loadWorkspaceLayout("/papers/beta")).toBeNull();
  });

  it("keeps only unique open pinned paths from malformed saved data", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({
      "/papers/alpha": { ...layout, pinnedTabs: ["main.tex", "main.tex", "gone.tex", 42, null, ""] },
    }));
    expect(loadWorkspaceLayout("/papers/alpha")?.pinnedTabs).toEqual(["main.tex"]);
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
      pinnedTabs: [],
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

  // The Markdown and paper previews merged into the unified preview, and the
  // two-editor view and the three-column layout became the plain editor.
  it.each([
    [{ canvasMode: "markdown-preview" }, { canvasMode: "pdf" }],
    [{ canvasMode: "paper" }, { canvasMode: "pdf" }],
    [{ canvasMode: "columns", documentMode: "columns" }, { canvasMode: "source", documentMode: "source" }],
    [{ canvasMode: "dual", documentMode: "dual" }, { canvasMode: "source", documentMode: "source" }],
    [{ canvasMode: "split", documentMode: "dual" }, { canvasMode: "split", documentMode: "source" }],
  ])("migrates the retired layout %j", (retired, migrated) => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify({ "/papers/alpha": { ...layout, ...retired } }));
    expect(loadWorkspaceLayout("/papers/alpha")).toEqual({ ...layout, ...migrated });
  });

  it("treats corrupt storage as an empty workspace history", () => {
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, "not-json");
    expect(loadWorkspaceLayout("/papers/alpha")).toBeNull();
    expect(() => persistWorkspaceLayout("/papers/alpha", layout)).not.toThrow();
  });
});

describe("local file view state persistence", () => {
  it("round-trips each file's local view without mixing projects", () => {
    const views = {
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
      "figures/model.png": { image: { scale: 1.6, scrollTop: 120, scrollLeft: 45 } },
      "paper.pdf": { pdf: { page: 7, scale: 1.25, fitMode: "width", scrollTop: 720, scrollLeft: 12 } },
      "sketch.tldr": { board: { pageId: "page:ideas", camera: { x: -120, y: 64, z: 1.8 } } },
      "slides/talk/index.tsx": { openSlide: { page: 3 } },
      "report.html": { html: { scale: 1.25, scrollTop: 840, scrollRange: 3200 } },
      "notes.md": { visualMarkdown: { scrollTop: 460, scrollRange: 1800 } },
    } satisfies Record<string, FileViewState>;
    persistFileViewStates("/papers/alpha", views);

    expect(loadFileViewStates("/papers/alpha")).toEqual(views);
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
      Array.from({ length: 205 }, (_, index) => [`file-${index}.tex`, { text: { cursor: index, scrollTop: index } }]),
    ));
    const files = loadFileViewStates("/papers/large");
    expect(Object.keys(files)).toHaveLength(200);
    expect(files["file-4.tex"]).toBeUndefined();
    expect(files["file-5.tex"]).toBeDefined();

    for (let index = 0; index < 60; index += 1) {
      persistFileViewStates(`/papers/project-${index}`, { "main.tex": { text: { cursor: index, scrollTop: 0 } } });
    }
    const projects = JSON.parse(localStorage.getItem(FILE_VIEW_STATES_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(projects)).toHaveLength(60);
    expect(projects["/papers/large"]).toBeUndefined();
    expect(projects["/papers/project-59"]).toBeDefined();
  });
});

describe("tutorial persistence", () => {
  it("remembers that the tutorial has been shown across app versions", () => {
    expect(hasSeenTutorial()).toBe(false);
    markTutorialSeen();
    expect(localStorage.getItem(TUTORIAL_SEEN_KEY)).toBe("1");
    expect(hasSeenTutorial()).toBe(true);
  });
});

describe("recent projects across windows", () => {
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
