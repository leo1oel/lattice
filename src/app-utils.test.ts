import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProjectPathChanges,
  canvasContentAt,
  classifyExternalProjectDrop,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  isWindowDragExcluded,
  remapProjectPath,
} from "./app-utils";
import type { ProjectSnapshot } from "./app-types";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.replaceChildren();
});

describe("dropDirectoryAt", () => {
  it("finds Pierre directory rows inside the file tree shadow root", () => {
    const navigator = document.createElement("aside");
    navigator.className = "navigator";
    const host = document.createElement("file-tree-container");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const row = document.createElement("button");
    row.dataset.itemType = "folder";
    row.dataset.itemPath = "figures/results/";
    shadowRoot.append(row);
    navigator.append(host);
    document.body.append(navigator);

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => host),
    });
    Object.defineProperty(shadowRoot, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });

    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe("figures/results");
  });
});

describe("window dragging", () => {
  it("excludes interactive controls and marked tab-strip descendants", () => {
    const tabStrip = document.createElement("div");
    tabStrip.dataset.windowDragExclude = "";
    const scrollbarThumb = document.createElement("div");
    tabStrip.append(scrollbarThumb);
    const button = document.createElement("button");
    const emptyChrome = document.createElement("div");

    expect(isWindowDragExcluded(scrollbarThumb)).toBe(true);
    expect(isWindowDragExcluded(button)).toBe(true);
    expect(isWindowDragExcluded(emptyChrome)).toBe(false);
  });
});

describe("editor file drops", () => {
  it("classifies source files separately from figures and rejects mixed drops", () => {
    expect(classifyExternalProjectDrop(["/tmp/main.tex", "C:\\paper\\references.bib"]))
      .toBe("source");
    expect(classifyExternalProjectDrop(["/tmp/result.svg", "/tmp/plot.pdf"]))
      .toBe("asset");
    expect(classifyExternalProjectDrop(["/tmp/main.tex", "/tmp/result.png"]))
      .toBe("mixed");
    expect(classifyExternalProjectDrop(["/tmp/archive.zip"]))
      .toBe("unsupported");
  });

  it("identifies the editor pane under a native drop position", () => {
    const editor = document.createElement("div");
    editor.className = "source-editor";
    editor.dataset.editorPane = "secondary";
    document.body.append(editor);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => editor),
    });

    expect(dropEditorAt({ x: 24, y: 40 })).toEqual({
      x: 24,
      y: 40,
      pane: "secondary",
    });
  });

  it("identifies the document canvas for pointer and native drop coordinates", () => {
    const canvas = document.createElement("div");
    canvas.className = "canvas-body";
    const preview = document.createElement("div");
    preview.className = "asset-preview";
    canvas.append(preview);
    document.body.append(canvas);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => preview),
    });

    expect(canvasContentAt({ x: 24, y: 40 })).toBe(true);
    expect(dropCanvasAt({ x: 24, y: 40 })).toBe(true);
  });
});

const projectSnapshot: ProjectSnapshot = {
  root: "/tmp/lattice-paper",
  manifest: {
    schemaVersion: 1,
    projectId: "paper-id",
    name: "Lattice paper",
    rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }],
    primaryBibliography: "references.bib",
    trusted: false,
  },
  files: [
    { name: "figures", path: "figures", kind: "directory", children: [] },
    {
      name: "sections",
      path: "sections",
      kind: "directory",
      children: [
        { name: "intro.tex", path: "sections/intro.tex", kind: "tex", children: [] },
      ],
    },
    { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
    { name: "references.bib", path: "references.bib", kind: "bib", children: [] },
  ],
};

describe("project path changes", () => {
  it("moves a file into a directory without rescanning the project", () => {
    const next = applyProjectPathChanges(projectSnapshot, [{
      previousPath: "main.tex",
      nextPath: "sections/main.tex",
    }]);

    expect(next.files.map((node) => node.path)).toEqual(["figures", "sections", "references.bib"]);
    expect(next.files[1].children.map((node) => node.path)).toEqual([
      "sections/intro.tex",
      "sections/main.tex",
    ]);
    expect(next.manifest.rootDocuments[0].path).toBe("sections/main.tex");
  });

  it("moves a directory and remaps every descendant path", () => {
    const next = applyProjectPathChanges(projectSnapshot, [{
      previousPath: "sections",
      nextPath: "figures/sections",
    }]);
    const figures = next.files.find((node) => node.path === "figures");
    const moved = figures?.children.find((node) => node.path === "figures/sections");

    expect(moved?.children[0]).toMatchObject({
      name: "intro.tex",
      path: "figures/sections/intro.tex",
    });
  });

  it("applies a multi-file drop as one consistent project update", () => {
    const next = applyProjectPathChanges(projectSnapshot, [
      { previousPath: "main.tex", nextPath: "sections/main.tex" },
      { previousPath: "references.bib", nextPath: "sections/references.bib" },
    ]);
    const sections = next.files.find((node) => node.path === "sections");

    expect(sections?.children.map((node) => node.path)).toEqual([
      "sections/intro.tex",
      "sections/main.tex",
      "sections/references.bib",
    ]);
    expect(next.manifest.rootDocuments[0].path).toBe("sections/main.tex");
    expect(next.manifest.primaryBibliography).toBe("sections/references.bib");
  });

  it("remaps open paths inside a moved folder", () => {
    expect(remapProjectPath("sections/intro.tex", [{
      previousPath: "sections",
      nextPath: "drafts/sections",
    }])).toBe("drafts/sections/intro.tex");
    expect(remapProjectPath("main.tex", [{
      previousPath: "sections",
      nextPath: "drafts/sections",
    }])).toBe("main.tex");
  });
});
