import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absoluteProjectPath,
  applyProjectPathChanges,
  canvasContentAt,
  classifyExternalProjectDrop,
  dropAgentPanelAt,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  deckIdFromOpenSlidePath,
  isHarperProseFilePath,
  isOpenSlideDeckPath,
  isProjectSourceFilePath,
  isWindowDragExcluded,
  markdownFrontmatterEnd,
  overleafHostsMatch,
  overleafLinkMatchesSession,
  remapProjectPath,
  stripFrontmatter,
} from "./app-utils";
import type { ProjectSnapshot } from "./app-types";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.replaceChildren();
});

describe("absoluteProjectPath", () => {
  it("joins project-relative paths using the root's platform separator", () => {
    expect(absoluteProjectPath("/Users/example/paper", "figures/result.png"))
      .toBe("/Users/example/paper/figures/result.png");
    expect(absoluteProjectPath("C:\\Users\\example\\paper", "figures/result.png"))
      .toBe("C:\\Users\\example\\paper\\figures\\result.png");
  });

  it("does not duplicate a trailing root separator", () => {
    expect(absoluteProjectPath("/Users/example/paper/", "main.tex"))
      .toBe("/Users/example/paper/main.tex");
  });
});

describe("isProjectSourceFilePath", () => {
  it("recognizes native spreadsheets as importable project sources", () => {
    expect(isProjectSourceFilePath("tables/results.lattice-sheet")).toBe(true);
    expect(isProjectSourceFilePath("tables/results.LATTICE-SHEET")).toBe(true);
  });
});

describe("overleafHostsMatch", () => {
  it("matches harmless spelling differences on the same origin", () => {
    expect(overleafHostsMatch("HTTPS://OVERLEAF.EXAMPLE/", "https://overleaf.example"))
      .toBe(true);
    expect(overleafHostsMatch("overleaf.example", "https://overleaf.example/"))
      .toBe(true);
  });

  it("keeps scheme, host, and port boundaries distinct", () => {
    expect(overleafHostsMatch("https://overleaf-a.example", "https://overleaf-b.example"))
      .toBe(false);
    expect(overleafHostsMatch("https://overleaf.example", "http://overleaf.example"))
      .toBe(false);
    expect(overleafHostsMatch("https://overleaf.example:8443", "https://overleaf.example"))
      .toBe(false);
  });
});

describe("overleafLinkMatchesSession", () => {
  it("treats a legacy link without a stored host as belonging to the session", () => {
    expect(overleafLinkMatchesSession("https://overleaf.example", "")).toBe(true);
    expect(overleafHostsMatch("https://overleaf.example", "")).toBe(false);
  });
});

describe("stripFrontmatter", () => {
  it("removes separator blank lines without changing indented Markdown", () => {
    expect(stripFrontmatter("---\ntitle: Paper\n---\n\n    indented code\n"))
      .toBe("    indented code\n");
  });

  it("returns an empty body for frontmatter-only papers", () => {
    expect(stripFrontmatter("---\ntitle: Empty\n---")).toBe("");
  });

  it.each([
    "---\r\ntitle: Draft\r\n---\r\nBody",
    "\uFEFF---\ntitle: Draft\n...\nBody",
    "+++\ntitle = \"Draft\"\n+++\nBody",
  ])("finds the exact end of frontmatter without changing its bytes", (markdown) => {
    const end = markdownFrontmatterEnd(markdown);
    expect(end).toBeGreaterThan(0);
    expect(markdown.slice(end)).toBe("Body");
  });

  it("does not treat an unclosed delimiter as frontmatter", () => {
    expect(markdownFrontmatterEnd("---\nA paragraph")).toBe(0);
  });
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

  it("falls back to row geometry when native dragging hides the shadow hit target", () => {
    const navigator = document.createElement("aside");
    navigator.className = "navigator";
    const section = document.createElement("div");
    section.className = "navigator-section project-section";
    const host = document.createElement("file-tree-container");
    host.className = "lattice-file-tree";
    const shadowRoot = host.attachShadow({ mode: "open" });
    const row = document.createElement("button");
    row.dataset.itemType = "folder";
    row.dataset.itemPath = "figures/";
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      bottom: 72,
      height: 32,
      left: 10,
      right: 210,
      top: 40,
      width: 200,
      x: 10,
      y: 40,
      toJSON: () => ({}),
    });
    const background = document.createElement("div");
    shadowRoot.append(row, background);
    section.append(host);
    navigator.append(section);
    document.body.append(navigator);

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => host),
    });
    Object.defineProperty(shadowRoot, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => background),
    });

    expect(dropDirectoryAt({ x: 50, y: 60 })).toBe("figures");
  });

  it("targets a file row's parent folder and falls back to the project root", () => {
    const navigator = document.createElement("aside");
    navigator.className = "navigator";
    const section = document.createElement("div");
    section.className = "navigator-section project-section";
    const host = document.createElement("file-tree-container");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const nestedFile = document.createElement("button");
    nestedFile.dataset.itemType = "file";
    nestedFile.dataset.itemPath = "sections/intro.tex";
    nestedFile.dataset.itemParentPath = "sections/";
    const rootFile = document.createElement("button");
    rootFile.dataset.itemType = "file";
    rootFile.dataset.itemPath = "main.tex";
    const background = document.createElement("div");
    shadowRoot.append(nestedFile, rootFile, background);
    section.append(host);
    navigator.append(section);
    document.body.append(navigator);

    let hit: Element = nestedFile;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => host),
    });
    Object.defineProperty(shadowRoot, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hit),
    });

    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe("sections");
    hit = rootFile;
    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe("");
    hit = background;
    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe("");
  });

  it("returns null outside the project file tree", () => {
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    // The sidebar's Papers list is not an import target either.
    const navigator = document.createElement("aside");
    navigator.className = "navigator";
    const papers = document.createElement("div");
    papers.className = "navigator-section papers-section";
    navigator.append(papers);
    document.body.append(navigator);

    let hit: Element = elsewhere;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hit),
    });

    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe(null);
    hit = papers;
    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe(null);
  });
});

describe("window dragging", () => {
  it("excludes interactive controls and explicitly marked descendants", () => {
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

  it("excludes tab-strip whitespace only while the strip overflows", () => {
    const tabStrip = document.createElement("div");
    tabStrip.dataset.windowDragExcludeOnOverflow = "";
    const viewport = document.createElement("div");
    viewport.dataset.slot = "scroll-area-viewport";
    const whitespace = document.createElement("div");
    tabStrip.append(viewport, whitespace);

    viewport.dataset.hasHorizontalOverflow = "false";
    expect(isWindowDragExcluded(whitespace)).toBe(false);

    viewport.dataset.hasHorizontalOverflow = "true";
    expect(isWindowDragExcluded(whitespace)).toBe(true);
  });
});

describe("editor file drops", () => {
  it("recognizes only native Open Slide deck entry paths", () => {
    expect(isOpenSlideDeckPath("slides/research-update/index.tsx")).toBe(true);
    expect(isOpenSlideDeckPath("slides\\research-update\\index.tsx")).toBe(true);
    expect(deckIdFromOpenSlidePath("slides/research-update/index.tsx")).toBe("research-update");
    expect(isOpenSlideDeckPath("slides/research_update/index.tsx")).toBe(false);
    expect(isOpenSlideDeckPath("slides/research-update/notes.tsx")).toBe(false);
  });

  it("runs Harper only for prose source files", () => {
    expect(isHarperProseFilePath("main.tex")).toBe(true);
    expect(isHarperProseFilePath("notes.md")).toBe(true);
    expect(isHarperProseFilePath("notes.txt")).toBe(true);
    expect(isHarperProseFilePath("references.bib")).toBe(false);
    expect(isHarperProseFilePath("conference.sty")).toBe(false);
    expect(isHarperProseFilePath("article.cls")).toBe(false);
    expect(isHarperProseFilePath("supplement.html")).toBe(false);
  });

  it("classifies source files separately from figures and rejects mixed drops", () => {
    expect(classifyExternalProjectDrop([
      "/tmp/main.tex",
      "C:\\paper\\references.bib",
      "/tmp/supplement.html",
    ]))
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

  it("treats an empty secondary editor as a file drop target", () => {
    const editor = document.createElement("div");
    editor.className = "dual-empty";
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

  it("identifies the agent panel under a native drop position once its frame is ready", () => {
    const shell = document.createElement("div");
    shell.className = "synara-frame-shell";
    const frame = document.createElement("div");
    frame.className = "synara-poc-frame";
    shell.append(frame);
    document.body.append(shell);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => frame),
    });

    expect(dropAgentPanelAt({ x: 24, y: 40 })).toBe(false);
    shell.dataset.ready = "true";
    expect(dropAgentPanelAt({ x: 24, y: 40 })).toBe(true);

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body),
    });
    expect(dropAgentPanelAt({ x: 24, y: 40 })).toBe(false);
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
