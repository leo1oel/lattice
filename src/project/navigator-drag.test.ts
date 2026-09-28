import { afterEach, describe, expect, it } from "vitest";
import {
  dropTargetDirectory,
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

  return { addRow, pointerOver, root, surface };
}

const directoryTarget = (directoryPath: string, hoveredPath: string, flattenedSegmentPath: string | null = null) => ({
  directoryPath,
  flattenedSegmentPath,
  hoveredPath,
  kind: "directory" as const,
});
const rootTarget = (hoveredPath: string | null) => ({
  directoryPath: null,
  flattenedSegmentPath: null,
  hoveredPath,
  kind: "root" as const,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("pointerDropTarget", () => {
  type Row = Parameters<ReturnType<typeof tree>["addRow"]>[0];
  it.each<[string, Row | null, "label" | "segment" | "surface", ReturnType<typeof directoryTarget | typeof rootTarget>]>([
    ["drops into the folder under the pointer",
      { path: "sections/", type: "folder" }, "label", directoryTarget("sections/", "sections/")],
    ["drops beside a file, into the folder holding it",
      { path: "sections/intro.tex", parentPath: "sections/" }, "label", directoryTarget("sections/", "sections/intro.tex")],
    ["treats a top-level file as the project root", { path: "main.tex" }, "label", rootTarget("main.tex")],
    ["treats empty space below the rows as the project root", null, "surface", rootTarget(null)],
    // A folder chain with one child each renders as a single row
    // ("sections/method/"), and each segment of it is its own drop target.
    ["aims at the collapsed segment the pointer is actually over",
      { path: "sections/method/", type: "folder", flattenedSegments: ["sections/", "sections/method/"] }, "segment",
      directoryTarget("sections/", "sections/method/", "sections/")],
    // Only a trailing slash makes a segment a directory; the file at the end of
    // a flattened chain must fall through to the row's own rules.
    ["ignores a segment that names a file rather than a folder",
      { path: "sections/intro.tex", parentPath: "sections/", flattenedSegments: ["sections/intro.tex"] }, "segment",
      directoryTarget("sections/", "sections/intro.tex")],
  ])("%s", (_case, options, over, expected) => {
    const { addRow, pointerOver, root, surface } = tree();
    const added = options && addRow(options);
    const segment = added?.row.querySelector<HTMLElement>("[data-item-flattened-subitem]") ?? null;
    const target = { label: added?.label ?? null, segment, surface }[over];

    const location = pointerDropTarget(root, pointerOver(target));

    expect(location?.target).toEqual(expected);
    expect(location?.row).toBe(added?.row ?? null);
    expect(location?.flattenedSegment).toBe(expected.flattenedSegmentPath ? segment : null);
  });

  it("declines a pointer that never reached the tree", () => {
    const { pointerOver, root } = tree();
    const outside = document.createElement("div");
    document.body.append(outside);

    expect(pointerDropTarget(root, pointerOver(outside))).toBeNull();
  });
});

describe("normalizePointerDraggedPaths", () => {
  it.each([
    // Moving the folder moves its contents; sending the children too asks the
    // backend to move files out from under themselves.
    ["drops what a dragged folder already carries",
      ["sections/", "sections/intro.tex", "sections/parts/", "sections/parts/a.tex", "main.tex"],
      ["sections/", "main.tex"]],
    ["keeps a file whose name merely starts like a dragged folder",
      ["sections/", "sections-old.tex"], ["sections/", "sections-old.tex"]],
    ["collapses duplicates", ["main.tex", "main.tex"], ["main.tex"]],
  ])("%s", (_case, paths, expected) => {
    expect(normalizePointerDraggedPaths(paths)).toEqual(expected);
  });
});

describe("pointerDropOperations", () => {
  const intoDirectory = (directoryPath: string) => directoryTarget(directoryPath, directoryPath);
  const ontoRoot = rootTarget(null);
  const move = (from: string, to: string) => ({ from, to, type: "move" });

  it.each([
    ["moves each dragged path into the target folder", ["main.tex", "figures/"], intoDirectory("sections/"),
      [move("main.tex", "sections/"), move("figures/", "sections/")]],
    ["moves to the project root by basename", ["sections/intro.tex", "sections/parts/"], ontoRoot,
      [move("sections/intro.tex", "intro.tex"), move("sections/parts/", "parts/")]],
    ["refuses to drop a folder into itself", ["sections/"], intoDirectory("sections/"), []],
    // The move would delete the folder into a directory that is about to stop
    // existing; nothing in the UI could explain the result afterwards.
    ["refuses to drop a folder into its own descendant", ["sections/"], intoDirectory("sections/parts/"), []],
    // A partially applied multi-drag is worse than a refused one: the rest has
    // already moved by the time the impossible one is discovered.
    ["refuses the whole batch when one folder is an ancestor of the target",
      ["main.tex", "sections/"], intoDirectory("sections/parts/"), []],
    ["allows a folder onto a sibling that shares its name prefix", ["sections/"], intoDirectory("sections-old/"),
      [move("sections/", "sections-old/")]],
    ["skips a path that is already where it was dropped", ["sections/intro.tex", "main.tex"], intoDirectory("sections/"),
      [move("main.tex", "sections/")]],
    ["skips a root-level path dropped on the root", ["main.tex"], ontoRoot, []],
  ])("%s", (_case, dragged, target, expected) => {
    expect(pointerDropOperations(dragged, target)).toEqual(expected);
  });
});

describe("Pierre path shapes", () => {
  it.each([
    ["sections/parts/", "parts/"],
    ["sections/intro.tex", "intro.tex"],
    ["main.tex", "main.tex"],
  ])("keeps the trailing slash a directory basename needs: %s", (path, basename) => {
    expect(pointerDragBasename(path)).toBe(basename);
  });

  it("converts between the app's paths and Pierre's", () => {
    expect(fromPierrePath("sections/")).toBe("sections");
    expect(fromPierrePath("main.tex")).toBe("main.tex");
    expect(toPierreDirectoryPath("sections")).toBe("sections/");
    expect(toPierreDirectoryPath("sections/")).toBe("sections/");
  });

  it.each([
    [directoryTarget("sections/", "sections/"), "sections"],
    [directoryTarget("sections/method/", "sections/method/", "sections/"), "sections"],
    [rootTarget(null), ""],
  ])("resolves the directory a drop lands in: %o", (target, directory) => {
    expect(dropTargetDirectory(target)).toBe(directory);
  });
});
