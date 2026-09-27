import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absoluteProjectPath,
  applyProjectPathChanges,
  classifyExternalProjectDrop,
  dropAgentPanelAt,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  deckIdFromOpenSlidePath,
  isHarperProseFilePath,
  isOpenSlideDeckPath,
  isProjectSourceFilePath,
  isWholeFileEditorPath,
  isWindowDragExcluded,
  markdownFrontmatterEnd,
  overleafHostsMatch,
  overleafLinkMatchesSession,
  remapProjectPath,
  resolveKnownWholeFileProjectPath,
  stripFrontmatter,
} from "./app-utils";
import type { FileNode, ProjectSnapshot } from "./app-types";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.replaceChildren();
});

/** jsdom has no layout, so hit testing answers whatever `hit` returns. */
function stubHit(root: Document | ShadowRoot, hit: () => Element) {
  Object.defineProperty(root, "elementFromPoint", { configurable: true, value: vi.fn(hit) });
}

function expectEach<T>(check: (input: T) => unknown, cases: ReadonlyArray<readonly [T, unknown]>) {
  for (const [input, expected] of cases) expect(check(input), String(input)).toEqual(expected);
}

describe("absoluteProjectPath", () => {
  // Joins with the root's own platform separator, never doubling a trailing one.
  it.each([
    ["/Users/example/paper", "figures/result.png", "/Users/example/paper/figures/result.png"],
    ["C:\\Users\\example\\paper", "figures/result.png", "C:\\Users\\example\\paper\\figures\\result.png"],
    ["/Users/example/paper/", "main.tex", "/Users/example/paper/main.tex"],
  ])("joins %s and %s", (root, path, expected) => {
    expect(absoluteProjectPath(root, path)).toBe(expected);
  });
});

it("recognizes native spreadsheets as importable project sources", () => {
  expectEach(isProjectSourceFilePath, [
    ["tables/results.lattice-sheet", true],
    ["tables/results.LATTICE-SHEET", true],
  ]);
});

describe("Overleaf host matching", () => {
  // Harmless spelling differences match; scheme, host, and port stay distinct.
  it.each([
    ["HTTPS://OVERLEAF.EXAMPLE/", "https://overleaf.example", true],
    ["overleaf.example", "https://overleaf.example/", true],
    ["https://overleaf-a.example", "https://overleaf-b.example", false],
    ["https://overleaf.example", "http://overleaf.example", false],
    ["https://overleaf.example:8443", "https://overleaf.example", false],
    ["https://overleaf.example", "", false],
  ])("compares %s with %s by origin", (left, right, expected) => {
    expect(overleafHostsMatch(left, right)).toBe(expected);
  });

  it("treats a legacy link without a stored host as belonging to the session", () => {
    expect(overleafLinkMatchesSession("https://overleaf.example", "")).toBe(true);
  });
});

describe("stripFrontmatter", () => {
  it.each([
    ["removes separator blank lines without changing indented Markdown", "---\ntitle: Paper\n---\n\n    indented code\n", "    indented code\n"],
    ["returns an empty body for frontmatter-only papers", "---\ntitle: Empty\n---", ""],
  ])("%s", (_name, markdown, expected) => {
    expect(stripFrontmatter(markdown)).toBe(expected);
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
  function treeRow(type: "folder" | "file", path: string, parentPath?: string) {
    const row = document.createElement("button");
    row.dataset.itemType = type;
    row.dataset.itemPath = path;
    if (parentPath) row.dataset.itemParentPath = parentPath;
    return row;
  }

  /** A navigator whose Pierre file tree renders `rows` inside its shadow root. */
  function mountTree(rows: Element[], options: { projectSection?: boolean; treeClass?: string } = {}) {
    const navigator = document.createElement("aside");
    navigator.className = "navigator";
    const host = document.createElement("file-tree-container");
    if (options.treeClass) host.className = options.treeClass;
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.append(...rows);
    if (options.projectSection) {
      const section = document.createElement("div");
      section.className = "navigator-section project-section";
      section.append(host);
      navigator.append(section);
    } else {
      navigator.append(host);
    }
    document.body.append(navigator);
    stubHit(document, () => host);
    return shadowRoot;
  }

  it("finds Pierre directory rows inside the file tree shadow root", () => {
    const row = treeRow("folder", "figures/results/");
    stubHit(mountTree([row]), () => row);

    expect(dropDirectoryAt({ x: 24, y: 40 })).toBe("figures/results");
  });

  it("falls back to row geometry when native dragging hides the shadow hit target", () => {
    const row = treeRow("folder", "figures/");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 40, 200, 32));
    const background = document.createElement("div");
    stubHit(mountTree([row, background], { projectSection: true, treeClass: "lattice-file-tree" }), () => background);

    expect(dropDirectoryAt({ x: 50, y: 60 })).toBe("figures");
  });

  it("targets a file row's parent folder and falls back to the project root", () => {
    const nestedFile = treeRow("file", "sections/intro.tex", "sections/");
    const rootFile = treeRow("file", "main.tex");
    const background = document.createElement("div");
    let hit: Element = nestedFile;
    stubHit(mountTree([nestedFile, rootFile, background], { projectSection: true }), () => hit);

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
    stubHit(document, () => hit);

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

    expectEach(isWindowDragExcluded, [
      [scrollbarThumb, true],
      [document.createElement("button"), true],
      [document.createElement("div"), false],
    ]);
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
    expectEach(isOpenSlideDeckPath, [
      ["slides/research-update/index.tsx", true],
      ["slides\\research-update\\index.tsx", true],
      ["slides/research_update/index.tsx", false],
      ["slides/research-update/notes.tsx", false],
    ]);
    expect(deckIdFromOpenSlidePath("slides/research-update/index.tsx")).toBe("research-update");
  });

  it("recognizes editors whose documents synchronize as whole files", () => {
    expectEach(isWholeFileEditorPath, [
      ["slides/research-update/index.tsx", true],
      ["figures/model.tldr", true],
      ["results.LATTICE-SHEET", true],
      ["main.tex", false],
      ["slides/research-update/theme.tsx", false],
    ]);
  });

  it("recovers project-root whole-file links from a Markdown folder, keeping exact and missing paths", () => {
    const paths = ["notes/local.tldr", "slides/research-update/index.tsx", "results.lattice-sheet", "sketch.tldr", "notes/other.md"];

    expectEach((path: string) => resolveKnownWholeFileProjectPath(path, paths), [
      ["notes/slides/research-update/index.tsx", "slides/research-update/index.tsx"],
      ["notes/results.lattice-sheet", "results.lattice-sheet"],
      ["notes/sketch.tldr", "sketch.tldr"],
      ["notes/local.tldr", "notes/local.tldr"],
      ["notes/other.md", "notes/other.md"],
      ["notes/missing.tldr", "notes/missing.tldr"],
    ]);
  });

  it("runs Harper only for prose source files", () => {
    expectEach(isHarperProseFilePath, [
      ["main.tex", true],
      ["notes.md", true],
      ["notes.txt", true],
      ["references.bib", false],
      ["conference.sty", false],
      ["article.cls", false],
      ["supplement.html", false],
    ]);
  });

  it("classifies source files separately from figures and rejects mixed drops", () => {
    expectEach(classifyExternalProjectDrop, [
      [["/tmp/main.tex", "C:\\paper\\references.bib", "/tmp/supplement.html"], "source"],
      [["/tmp/result.svg", "/tmp/plot.pdf"], "asset"],
      [["/tmp/main.tex", "/tmp/result.png"], "mixed"],
      [["/tmp/archive.zip"], "unsupported"],
    ]);
  });

  // An empty secondary editor is a file drop target too.
  it.each(["source-editor", "dual-empty"])("identifies the editor pane under a native drop position (%s)", (className) => {
    const editor = document.createElement("div");
    editor.className = className;
    editor.dataset.editorPane = "secondary";
    document.body.append(editor);
    stubHit(document, () => editor);

    expect(dropEditorAt({ x: 24, y: 40 })).toEqual({ x: 24, y: 40, pane: "secondary" });
  });

  it("identifies the document canvas under a native drop position", () => {
    const canvas = document.createElement("div");
    canvas.className = "canvas-body";
    const preview = document.createElement("div");
    preview.className = "asset-preview";
    canvas.append(preview);
    document.body.append(canvas);
    stubHit(document, () => preview);

    expect(dropCanvasAt({ x: 24, y: 40 })).toBe(true);
  });

  it("identifies the agent panel under a native drop position once its frame is ready", () => {
    const shell = document.createElement("div");
    shell.className = "synara-frame-shell";
    const frame = document.createElement("div");
    frame.className = "synara-poc-frame";
    shell.append(frame);
    document.body.append(shell);
    let hit: Element = frame;
    stubHit(document, () => hit);

    expect(dropAgentPanelAt({ x: 24, y: 40 })).toBe(false);
    shell.dataset.ready = "true";
    expect(dropAgentPanelAt({ x: 24, y: 40 })).toBe(true);
    hit = document.body;
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
    fileNode("figures", "directory"),
    fileNode("sections", "directory", [fileNode("sections/intro.tex", "tex")]),
    fileNode("main.tex", "tex"),
    fileNode("references.bib", "bib"),
  ],
};

function fileNode(path: string, kind: string, children: FileNode[] = []): FileNode {
  return { name: path.split("/").at(-1) ?? path, path, kind, children };
}

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
    const moveSections = [{ previousPath: "sections", nextPath: "drafts/sections" }];
    expect(remapProjectPath("sections/intro.tex", moveSections)).toBe("drafts/sections/intro.tex");
    expect(remapProjectPath("main.tex", moveSections)).toBe("main.tex");
  });
});
