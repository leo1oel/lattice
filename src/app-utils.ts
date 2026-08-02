/**
 * Pure, module-level utility helpers extracted from `App.tsx`.
 *
 * These are the small, stateless functions and shared constants the app leans
 * on for formatting, paper tab keys, window drag handling, and drop-target hit
 * testing. They carry no React state
 * and depend only on shared types plus the Tauri window API, so they can be
 * imported anywhere without pulling in the whole component.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type { AutoBuildMode } from "./app-settings";
import type {
  PaperSummary,
  CiteCommand,
  FileNode,
  ProjectSnapshot,
  EditorPaneId,
} from "./app-types";

/** What the second line of a paper row says: where it came from, and its state. */
export function paperSubtitle(paper: PaperSummary, snippet?: string): string {
  if (snippet) return snippet;
  const parts: string[] = [];
  // Just the key: the \cite{} wrapper is noise in a list that is entirely
  // citations, and it crowds out the arXiv id in a narrow panel.
  if (paper.citationKey) parts.push(paper.citationKey);
  if (paper.arxivId) parts.push(`arXiv ${paper.arxivId}`);
  return parts.join(" · ");
}

/** A cited-only work may have no arXiv id, so identity falls back to its key. */
export function paperKey(paper: PaperSummary): string {
  return paper.arxivId || `cite:${paper.citationKey ?? paper.title}`;
}

export const CITE_COMMANDS: CiteCommand[] = ["cite", "citep", "citet"];

export const PROJECT_FIGURE_DRAG_TYPE = "application/x-lattice-project-figure";

const PROJECT_SOURCE_EXTENSIONS = new Set(["tex", "bib", "md", "txt", "sty", "cls", "bst"]);
const PROJECT_ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"]);

function fileExtension(path: string): string {
  const name = path.split(/[/\\]/).at(-1) ?? "";
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLocaleLowerCase() : "";
}

export function isProjectSourceFilePath(path: string): boolean {
  return PROJECT_SOURCE_EXTENSIONS.has(fileExtension(path));
}

export function isProjectAssetFilePath(path: string): boolean {
  return PROJECT_ASSET_EXTENSIONS.has(fileExtension(path));
}

export function classifyExternalProjectDrop(
  paths: string[],
): "source" | "asset" | "mixed" | "unsupported" {
  if (!paths.length) return "unsupported";
  const sourceCount = paths.filter(isProjectSourceFilePath).length;
  const assetCount = paths.filter(isProjectAssetFilePath).length;
  if (sourceCount === paths.length) return "source";
  if (assetCount === paths.length) return "asset";
  if (sourceCount + assetCount === paths.length) return "mixed";
  return "unsupported";
}

// Papers ride in the same `openTabs` string[] as files. A paper's tab key is
// its full-text path — unambiguous, since only papers live under this prefix.
export const PAPER_TAB_PREFIX = ".research/papers/";
export const PAPER_TAB_SUFFIX = "/paper.md";
export function isPaperTabKey(key: string): boolean {
  return key.startsWith(PAPER_TAB_PREFIX) && key.endsWith(PAPER_TAB_SUFFIX);
}
export function paperTabKey(arxivId: string): string {
  return `${PAPER_TAB_PREFIX}${arxivId}${PAPER_TAB_SUFFIX}`;
}
export function arxivIdFromTabKey(key: string): string {
  return key.slice(PAPER_TAB_PREFIX.length, key.length - PAPER_TAB_SUFFIX.length);
}

/**
 * Full text imported with `arxiv2md --frontmatter` leads with a YAML block; the
 * reader shows the title from metadata, so drop the raw YAML rather than render
 * it as a stray `<hr>` + text. A no-op for older papers without frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after === -1 ? "" : markdown.slice(after + 1).replace(/^\s+/, "");
}

let windowDragTimer: ReturnType<typeof setTimeout> | null = null;

export function isWindowDragExcluded(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "[data-window-drag-exclude], button, input, select, textarea, a",
  ));
}

export function beginWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (
    event.buttons !== 1
    || event.detail > 1
    || isWindowDragExcluded(event.target)
  ) return;
  event.preventDefault();
  if (windowDragTimer) clearTimeout(windowDragTimer);
  // Delay drag so a second click can still register as double-click → fullscreen.
  windowDragTimer = setTimeout(() => {
    windowDragTimer = null;
    void getCurrentWindow().startDragging();
  }, 180);
}

export function toggleWindowFullscreen(event: React.MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  if (windowDragTimer) {
    clearTimeout(windowDragTimer);
    windowDragTimer = null;
  }
  const appWindow = getCurrentWindow();
  if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.setFullscreen !== "function") return;
  void appWindow.isFullscreen()
    .then((value) => appWindow.setFullscreen(!value))
    .catch(() => undefined);
}

export function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function autoBuildTitle(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Build automatically";
  return "Build only when requested";
}

export function autoBuildDetail(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Lattice saves and builds when you leave the editor or after 1.2 seconds without typing.";
  return "Use the Build button or Command-S. Source changes are still saved automatically.";
}

export function autoBuildDescription(mode: AutoBuildMode): string {
  return `${autoBuildTitle(mode)} · Command-S builds now`;
}

export function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function projectItemPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function deepestElementFromPoint(x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const nested = element.shadowRoot.elementFromPoint(x, y);
    if (!nested || nested === element) break;
    element = nested;
  }
  return element;
}

function closestAcrossShadow(element: Element | null, selector: string): Element | null {
  let current = element;
  while (current) {
    const match = current.closest(selector);
    if (match) return match;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = deepestElementFromPoint(position.x / scale, position.y / scale);
  const directory = closestAcrossShadow(
    element,
    "[data-drop-directory], [data-item-type='folder'][data-item-path]",
  ) as HTMLElement | null;
  const path = directory?.dataset.dropDirectory ?? directory?.dataset.itemPath;
  if (path) return path.endsWith("/") ? path.slice(0, -1) : path;
  return closestAcrossShadow(element, ".navigator") ? "figures" : null;
}

export function editorPaneAt(
  position: { x: number; y: number },
): EditorPaneId | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const editor = document.elementFromPoint(position.x, position.y)?.closest<HTMLElement>(".source-editor");
  if (!editor) return null;
  return editor.dataset.editorPane === "secondary" ? "secondary" : "primary";
}

export function dropEditorAt(
  position: { x: number; y: number },
): { x: number; y: number; pane: EditorPaneId } | null {
  const scale = window.devicePixelRatio || 1;
  const point = { x: position.x / scale, y: position.y / scale };
  const pane = editorPaneAt(point);
  return pane ? { ...point, pane } : null;
}

export function canvasContentAt(position: { x: number; y: number }): boolean {
  if (typeof document.elementFromPoint !== "function") return false;
  return Boolean(document.elementFromPoint(position.x, position.y)?.closest(".canvas-body"));
}

export function dropCanvasAt(position: { x: number; y: number }): boolean {
  const scale = window.devicePixelRatio || 1;
  return canvasContentAt({
    x: position.x / scale,
    y: position.y / scale,
  });
}

export type ProjectPathChange = {
  previousPath: string;
  nextPath: string;
};

export type ConfirmActionOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmActionHandler = (options: ConfirmActionOptions) => Promise<boolean>;

let confirmActionHandler: ConfirmActionHandler | null = null;

export function registerConfirmActionHandler(handler: ConfirmActionHandler): () => void {
  confirmActionHandler = handler;
  return () => {
    if (confirmActionHandler === handler) confirmActionHandler = null;
  };
}

export function remapProjectPath(path: string, changes: readonly ProjectPathChange[]): string {
  for (const change of changes) {
    if (path === change.previousPath) return change.nextPath;
    if (path.startsWith(`${change.previousPath}/`)) {
      return `${change.nextPath}${path.slice(change.previousPath.length)}`;
    }
  }
  return path;
}

function sortProjectFiles(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((left, right) => {
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";
    return Number(rightDirectory) - Number(leftDirectory)
      || left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase());
  });
}

function removeProjectFile(
  nodes: readonly FileNode[],
  path: string,
): { nodes: FileNode[]; removed: FileNode | null } {
  let removed: FileNode | null = null;
  const next = nodes.flatMap((node): FileNode[] => {
    if (node.path === path) {
      removed = node;
      return [];
    }
    if (removed || node.children.length === 0) return [node];
    const childResult = removeProjectFile(node.children, path);
    if (!childResult.removed) return [node];
    removed = childResult.removed;
    return [{ ...node, children: childResult.nodes }];
  });
  return { nodes: next, removed };
}

function remapProjectFileNode(node: FileNode, change: ProjectPathChange): FileNode {
  const path = node.path === change.previousPath
    ? change.nextPath
    : `${change.nextPath}${node.path.slice(change.previousPath.length)}`;
  return {
    ...node,
    name: path.split("/").at(-1) ?? node.name,
    path,
    children: node.children.map((child) => remapProjectFileNode(child, change)),
  };
}

function insertProjectFile(
  nodes: readonly FileNode[],
  parentPath: string,
  entry: FileNode,
): { nodes: FileNode[]; inserted: boolean } {
  if (!parentPath) {
    return { nodes: sortProjectFiles([...nodes, entry]), inserted: true };
  }
  let inserted = false;
  const next = nodes.map((node) => {
    if (node.path === parentPath && node.kind === "directory") {
      inserted = true;
      return { ...node, children: sortProjectFiles([...node.children, entry]) };
    }
    if (inserted || node.children.length === 0) return node;
    const childResult = insertProjectFile(node.children, parentPath, entry);
    if (!childResult.inserted) return node;
    inserted = true;
    return { ...node, children: childResult.nodes };
  });
  return { nodes: next, inserted };
}

function applyProjectFilePathChange(
  nodes: readonly FileNode[],
  change: ProjectPathChange,
): FileNode[] {
  if (change.previousPath === change.nextPath) return [...nodes];
  const removal = removeProjectFile(nodes, change.previousPath);
  if (!removal.removed) return [...nodes];
  const entry = remapProjectFileNode(removal.removed, change);
  const separator = change.nextPath.lastIndexOf("/");
  const parentPath = separator < 0 ? "" : change.nextPath.slice(0, separator);
  const insertion = insertProjectFile(removal.nodes, parentPath, entry);
  return insertion.inserted ? insertion.nodes : [...nodes];
}

export function applyProjectPathChanges(
  snapshot: ProjectSnapshot,
  changes: readonly ProjectPathChange[],
): ProjectSnapshot {
  const files = changes.reduce<FileNode[]>(
    (current, change) => applyProjectFilePathChange(current, change),
    snapshot.files,
  );
  return {
    ...snapshot,
    manifest: {
      ...snapshot.manifest,
      rootDocuments: snapshot.manifest.rootDocuments.map((document) => ({
        ...document,
        path: remapProjectPath(document.path, changes),
      })),
      primaryBibliography: remapProjectPath(snapshot.manifest.primaryBibliography, changes),
    },
    files,
  };
}

/**
 * Ask before doing something that cannot be taken back, and wait for the answer.
 *
 * Not `window.confirm`. Tauri's dialog plugin replaces that global with an
 * async function that invokes `plugin:dialog|confirm` — a command the plugin
 * stopped registering, and which no permission grants, so in the app the call
 * was rejected by the ACL and no dialog ever appeared. Written as
 * `if (!window.confirm(…)) return;` that failed silently in the worst
 * direction: a rejected Promise is still truthy, so deletes and restores went
 * ahead with nothing asked. The plugin's own `confirm` goes through
 * `plugin:dialog|message`, which is registered and is covered by
 * `dialog:default`.
 */
export async function confirmAction(
  request: string | ConfirmActionOptions,
): Promise<boolean> {
  const options = typeof request === "string" ? { message: request } : request;
  if (confirmActionHandler) return confirmActionHandler(options);
  return confirmDialog(options.message, {
    title: options.title ?? "Lattice",
    kind: "warning",
  });
}
