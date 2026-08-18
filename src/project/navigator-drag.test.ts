import { afterEach, describe, expect, it } from "vitest";
import {
  fromPierrePath,
  normalizePointerDraggedPaths,
  pointerDragBasename,
  pointerDropOperations,
  pointerDropTarget,
  toPierreDirectoryPath,
} from "./navigator-drag";

/**
 * Pierre addresses directories with a trailing slash and files without, and
 * every rule below turns on that one character — so the fixtures spell it out
 * rather than deriving it.
 */
function tree() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  // Pierre's own scroll container. Empty space in the tree is still an element
  // inside the shadow root, which is what separates it from a pointer that
  // left the tree entirely.
  const surface = document.createElement("div");
  root.append(surface);

  const addRow = (options: {
    path: string;
    type?: "folder" | "file";
    parentPath?: string;
    /** Pierre collapses a chain of single-child folders into one row. */
    flattenedSegments?: string[];
  }) => {
    const row = document.createElement("button");
    row.dataset.type = "item";
    row.dataset.itemPath = options.path;
    if (options.type) row.dataset.itemType = options.type;
    if (options.parentPath) row.dataset.itemParentPath = options.parentPath;
    for (const segment of options.flattenedSegments ?? []) {
      const span = document.createElement("span");
      span.dataset.itemFlattenedSubitem = segment;
      row.append(span);
    }
    const label = document.createElement("span");
    row.append(label);
    surface.append(row);
    return { row, label };
  };

  /** What the engine sees: the composed path of a pointer event over `target`. */
  const pointerOver = (target: Element | null) => ({
    composedPath: () => {
      const path: EventTarget[] = [];
      for (let node = target; node; node = node.parentElement) path.push(node);
      path.push(root, host, document.body, document, window);
      return path;
    },
  }) as unknown as PointerEvent;

  return { addRow, host, pointerOver, root, surface };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("pointerDropTarget", () => {
  it("drops into the folder under the pointer", () => {
    const { addRow, pointerOver, root } = tree();
    const folder = addRow({ path: "sections/", type: "folder" });

    const location = pointerDropTarget(root, pointerOver(folder.label));

    expect(location?.target).toEqual({
      directoryPath: "sections/",
      flattenedSegmentPath: null,
      hoveredPath: "sections/",
      kind: "directory",
    });
    expect(location?.row).toBe(folder.row);
  });

  it("drops beside a file, into the folder holding it", () => {
    const { addRow, pointerOver, root } = tree();
    const file = addRow({ path: "sections/intro.tex", parentPath: "sections/" });

    expect(pointerDropTarget(root, pointerOver(file.label))?.target).toEqual({
      directoryPath: "sections/",
      flattenedSegmentPath: null,
      hoveredPath: "sections/intro.tex",
      kind: "directory",
    });
  });

  it("treats a top-level file as the project root", () => {
    const { addRow, pointerOver, root } = tree();
    const file = addRow({ path: "main.tex" });

    expect(pointerDropTarget(root, pointerOver(file.label))?.target).toMatchObject({
      directoryPath: null,
      kind: "root",
    });
  });

  it("treats empty space below the rows as the project root", () => {
    const { pointerOver, root, surface } = tree();

    expect(pointerDropTarget(root, pointerOver(surface))?.target).toEqual({
      directoryPath: null,
      flattenedSegmentPath: null,
      hoveredPath: null,
      kind: "root",
    });
  });

  it("aims at the collapsed segment the pointer is actually over", () => {
    // A folder chain with one child each renders as a single row
    // ("sections/method/"), and each segment of it is its own drop target.
    const { addRow, pointerOver, root } = tree();
    const folder = addRow({
      path: "sections/method/",
      type: "folder",
      flattenedSegments: ["sections/", "sections/method/"],
    });
    const [firstSegment] = Array.from(folder.row.querySelectorAll<HTMLElement>("[data-item-flattened-subitem]"));

    const location = pointerDropTarget(root, pointerOver(firstSegment));

    expect(location?.target).toEqual({
      directoryPath: "sections/",
      flattenedSegmentPath: "sections/",
      hoveredPath: "sections/method/",
      kind: "directory",
    });
    expect(location?.flattenedSegment).toBe(firstSegment);
  });

  it("ignores a segment that names a file rather than a folder", () => {
    // Only a trailing slash makes a segment a directory; the file at the end of
    // a flattened chain must fall through to the row's own rules.
    const { addRow, pointerOver, root } = tree();
    const row = addRow({
      path: "sections/intro.tex",
      parentPath: "sections/",
      flattenedSegments: ["sections/intro.tex"],
    });
    const [segment] = Array.from(row.row.querySelectorAll<HTMLElement>("[data-item-flattened-subitem]"));

    expect(pointerDropTarget(root, pointerOver(segment))?.target).toMatchObject({
      directoryPath: "sections/",
      flattenedSegmentPath: null,
      kind: "directory",
    });
  });

  it("declines a pointer that never reached the tree", () => {
    const { pointerOver, root } = tree();
    const outside = document.createElement("div");
    document.body.append(outside);

    expect(pointerDropTarget(root, pointerOver(outside))).toBeNull();
  });
});

describe("normalizePointerDraggedPaths", () => {
  it("drops what a dragged folder already carries", () => {
    // Moving the folder moves its contents; sending the children too asks the
    // backend to move files out from under themselves.
    expect(normalizePointerDraggedPaths([
      "sections/",
      "sections/intro.tex",
      "sections/parts/",
      "sections/parts/a.tex",
      "main.tex",
    ])).toEqual(["sections/", "main.tex"]);
  });

  it("keeps a file whose name merely starts like a dragged folder", () => {
    expect(normalizePointerDraggedPaths(["sections/", "sections-old.tex"]))
      .toEqual(["sections/", "sections-old.tex"]);
  });

  it("collapses duplicates", () => {
    expect(normalizePointerDraggedPaths(["main.tex", "main.tex"])).toEqual(["main.tex"]);
  });
});

describe("pointerDropOperations", () => {
  const intoDirectory = (directoryPath: string) => ({
    directoryPath,
    flattenedSegmentPath: null,
    hoveredPath: directoryPath,
    kind: "directory" as const,
  });
  const ontoRoot = {
    directoryPath: null,
    flattenedSegmentPath: null,
    hoveredPath: null,
    kind: "root" as const,
  };

  it("moves each dragged path into the target folder", () => {
    expect(pointerDropOperations(["main.tex", "figures/"], intoDirectory("sections/"))).toEqual([
      { from: "main.tex", to: "sections/", type: "move" },
      { from: "figures/", to: "sections/", type: "move" },
    ]);
  });

  it("moves to the project root by basename", () => {
    expect(pointerDropOperations(["sections/intro.tex", "sections/parts/"], ontoRoot)).toEqual([
      { from: "sections/intro.tex", to: "intro.tex", type: "move" },
      { from: "sections/parts/", to: "parts/", type: "move" },
    ]);
  });

  it("refuses to drop a folder into itself", () => {
    expect(pointerDropOperations(["sections/"], intoDirectory("sections/"))).toEqual([]);
  });

  it("refuses to drop a folder into its own descendant", () => {
    // The move would delete the folder into a directory that is about to stop
    // existing; nothing in the UI could explain the result afterwards.
    expect(pointerDropOperations(["sections/"], intoDirectory("sections/parts/"))).toEqual([]);
  });

  it("refuses the whole batch when one folder is an ancestor of the target", () => {
    // A partially applied multi-drag is worse than a refused one: the rest has
    // already moved by the time the impossible one is discovered.
    expect(pointerDropOperations(["main.tex", "sections/"], intoDirectory("sections/parts/"))).toEqual([]);
  });

  it("allows a folder onto a sibling that shares its name prefix", () => {
    expect(pointerDropOperations(["sections/"], intoDirectory("sections-old/"))).toEqual([
      { from: "sections/", to: "sections-old/", type: "move" },
    ]);
  });

  it("skips a path that is already where it was dropped", () => {
    expect(pointerDropOperations(["sections/intro.tex", "main.tex"], intoDirectory("sections/"))).toEqual([
      { from: "main.tex", to: "sections/", type: "move" },
    ]);
  });

  it("skips a root-level path dropped on the root", () => {
    expect(pointerDropOperations(["main.tex"], ontoRoot)).toEqual([]);
  });
});

describe("Pierre path shapes", () => {
  it("keeps the trailing slash a directory basename needs", () => {
    expect(pointerDragBasename("sections/parts/")).toBe("parts/");
    expect(pointerDragBasename("sections/intro.tex")).toBe("intro.tex");
    expect(pointerDragBasename("main.tex")).toBe("main.tex");
  });

  it("converts between the app's paths and Pierre's", () => {
    expect(fromPierrePath("sections/")).toBe("sections");
    expect(fromPierrePath("main.tex")).toBe("main.tex");
    expect(toPierreDirectoryPath("sections")).toBe("sections/");
    expect(toPierreDirectoryPath("sections/")).toBe("sections/");
  });
});
