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
import type {
  PaperSummary,
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

export const PROJECT_FIGURE_DRAG_TYPE = "application/x-lattice-project-figure";

export function absoluteProjectPath(projectRoot: string, relativePath: string): string {
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const root = projectRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/**
 * Compare the exact Overleaf origin a session belongs to with the origin a
 * linked project recorded. A cookie from one self-hosted Overleaf instance
 * must never be sent to another one.
 */
export function overleafHostsMatch(left: string, right: string): boolean {
  const canonical = (value: string) => {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      return `${url.protocol.toLocaleLowerCase()}//${url.host.toLocaleLowerCase()}`;
    } catch {
      return withScheme.toLocaleLowerCase();
    }
  };
  return canonical(left) === canonical(right);
}

/** Legacy links written before host persistence belong to the active session. */
export function overleafLinkMatchesSession(sessionHost: string, linkHost: string): boolean {
  return !linkHost.trim() || overleafHostsMatch(sessionHost, linkHost);
}

const PROJECT_SOURCE_EXTENSIONS = new Set([
  "tex", "bib", "md", "txt", "html", "sty", "cls", "bst", "tldr", "lattice-sheet",
]);
const PROJECT_ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"]);

function fileExtension(path: string): string {
  const name = path.split(/[/\\]/).at(-1) ?? "";
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLocaleLowerCase() : "";
}

export function isProjectSourceFilePath(path: string): boolean {
  return PROJECT_SOURCE_EXTENSIONS.has(fileExtension(path));
}

export function isHtmlFilePath(path: string): boolean {
  return fileExtension(path) === "html";
}

export function isPreviewableSourceFilePath(path: string): boolean {
  return ["tex", "md", "html"].includes(fileExtension(path));
}

export function isProjectAssetFilePath(path: string): boolean {
  return PROJECT_ASSET_EXTENSIONS.has(fileExtension(path));
}

export function isHarperProseFilePath(path: string): boolean {
  return ["tex", "md", "txt"].includes(fileExtension(path));
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
const PAPER_TAB_PREFIX = ".research/papers/";
const PAPER_TAB_SUFFIX = "/paper.md";
export function isPaperTabKey(key: string): boolean {
  return key.startsWith(PAPER_TAB_PREFIX) && key.endsWith(PAPER_TAB_SUFFIX);
}
export function paperTabKey(arxivId: string): string {
  return `${PAPER_TAB_PREFIX}${arxivId}${PAPER_TAB_SUFFIX}`;
}
export function arxivIdFromTabKey(key: string): string {
  return key.slice(PAPER_TAB_PREFIX.length, key.length - PAPER_TAB_SUFFIX.length);
}

/** Returns the byte offset after leading YAML/TOML frontmatter, or zero. */
export function markdownFrontmatterEnd(markdown: string): number {
  const start = markdown.startsWith("\uFEFF") ? 1 : 0;
  const firstBreak = markdown.indexOf("\n", start);
  if (firstBreak < 0) return 0;
  const delimiter = markdown.slice(start, firstBreak).replace(/\r$/, "").trim();
  if (delimiter !== "---" && delimiter !== "+++") return 0;

  let lineStart = firstBreak + 1;
  while (lineStart <= markdown.length) {
    const lineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = lineBreak < 0 ? markdown.length : lineBreak;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "").trim();
    if (line === delimiter || (delimiter === "---" && line === "...")) {
      return lineBreak < 0 ? lineEnd : lineBreak + 1;
    }
    if (lineBreak < 0) break;
    lineStart = lineBreak + 1;
  }
  return 0;
}

/**
 * Full text imported with `arxiv2md --frontmatter` leads with a YAML block; the
 * reader shows the title from metadata, so drop the raw YAML rather than render
 * it as a stray `<hr>` + text. A no-op for older papers without frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  const end = markdownFrontmatterEnd(markdown);
  return end === 0 ? markdown : markdown.slice(end).replace(/^(?:\r?\n)+/, "");
}

let windowDragTimer: ReturnType<typeof setTimeout> | null = null;

export function isWindowDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-window-drag-exclude], button, input, select, textarea, a")) {
    return true;
  }
  const overflowRegion = target.closest("[data-window-drag-exclude-on-overflow]");
  if (!overflowRegion) return false;
  const viewport = overflowRegion.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
  return viewport?.dataset.hasHorizontalOverflow === "true";
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

function trimDirectoryPath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Resolve a native OS drop to the project directory it lands on, mirroring the
 * tree's own row-drag semantics: a folder row is that folder, a file row is
 * the file's parent, and the rest of the Project pane is the project root
 * (""). Null means the drop was not over the Project pane at all.
 */
export function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = deepestElementFromPoint(position.x / scale, position.y / scale);
  const explicit = closestAcrossShadow(element, "[data-drop-directory]") as HTMLElement | null;
  const explicitPath = explicit?.dataset.dropDirectory;
  if (explicitPath) return trimDirectoryPath(explicitPath);
  // Flattened "a/b/c" rows keep each segment addressable; honor the one hit.
  const segment = closestAcrossShadow(element, "[data-item-flattened-subitem]") as HTMLElement | null;
  const segmentPath = segment?.dataset.itemFlattenedSubitem;
  if (segmentPath?.endsWith("/")) return trimDirectoryPath(segmentPath);
  const row = closestAcrossShadow(element, "[data-item-path]") as HTMLElement | null;
  if (row?.dataset.itemPath) {
    return row.dataset.itemType === "folder"
      ? trimDirectoryPath(row.dataset.itemPath)
      : trimDirectoryPath(row.dataset.itemParentPath ?? "");
  }
  // Scoped to the file-tree section: the sidebar also hosts the Papers list,
  // where a stray drop should not silently import into the project root.
  return closestAcrossShadow(element, ".project-section") ? "" : null;
}

export function editorPaneAt(
  position: { x: number; y: number },
): EditorPaneId | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const editor = document.elementFromPoint(position.x, position.y)?.closest<HTMLElement>(
    ".source-editor[data-editor-pane], .dual-empty[data-editor-pane]",
  );
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

/**
 * The agent panel is a cross-origin iframe, so it can never receive native
 * file drops itself; the host hit-tests its shell and relays the files over
 * the embed bridge. The inactive pane is `visibility: hidden`, which
 * elementFromPoint skips, so a hit implies the panel is actually showing.
 * `data-ready` mirrors the embed handshake; before it completes the bridge
 * would drop the message on the floor, so treat the panel as absent then.
 */
export function dropAgentPanelAt(position: { x: number; y: number }): boolean {
  if (typeof document.elementFromPoint !== "function") return false;
  const scale = window.devicePixelRatio || 1;
  const shell = document
    .elementFromPoint(position.x / scale, position.y / scale)
    ?.closest<HTMLElement>(".synara-frame-shell");
  return shell?.dataset.ready === "true";
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
  alternativeLabel?: string;
  alternativeDestructive?: boolean;
};

export type ConfirmActionChoice = "confirm" | "alternative" | "cancel";

type ConfirmActionHandler = (
  options: ConfirmActionOptions,
) => Promise<ConfirmActionChoice | boolean>;

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
  if (confirmActionHandler) {
    const answer = await confirmActionHandler(options);
    return answer === true || answer === "confirm";
  }
  return confirmDialog(options.message, {
    title: options.title ?? "Lattice",
    kind: "warning",
  });
}

/**
 * Ask a consequential question with two explicit actions plus Cancel.
 *
 * The native fallback can only represent confirm/cancel. The mounted app
 * always installs ConfirmActionProvider, which exposes the alternative; the
 * fallback keeps scripts and isolated component tests safely cancellable.
 */
export async function chooseAction(
  options: ConfirmActionOptions & { alternativeLabel: string },
): Promise<ConfirmActionChoice> {
  if (confirmActionHandler) {
    const answer = await confirmActionHandler(options);
    if (answer === true) return "confirm";
    if (answer === false) return "cancel";
    return answer;
  }
  return await confirmDialog(options.message, {
    title: options.title ?? "Lattice",
    kind: "warning",
  }) ? "confirm" : "cancel";
}
