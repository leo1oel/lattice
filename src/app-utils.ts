/**
 * Small stateless helpers shared across the app: project path classification,
 * paper tab keys, window dragging, drop-target hit testing, project tree path
 * changes, and the confirmation prompts.
 */
import { msg } from "@lingui/core/macro";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type {
  PaperSummary,
  FileNode,
  ProjectSnapshot,
  EditorPaneId,
} from "./app-types";
import { i18n } from "./i18n";

/** What the second line of a paper row says: where it came from, and its state. */
export function paperSubtitle(paper: PaperSummary, snippet?: string): string {
  if (snippet) return snippet;
  // Just the key: the \cite{} wrapper is noise in a list that is entirely
  // citations, and it crowds out the arXiv id in a narrow panel.
  return [paper.citationKey, paper.arxivId && `arXiv ${paper.arxivId}`].filter(Boolean).join(" · ");
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

function fileExtension(path: string): string {
  const name = path.split(/[/\\]/).at(-1) ?? "";
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLocaleLowerCase() : "";
}

/** A path predicate matching any of `extensions`, case-insensitively. */
function hasExtension(...extensions: string[]): (path: string) => boolean {
  const known = new Set(extensions);
  return (path) => known.has(fileExtension(path));
}

export const isProjectSourceFilePath = hasExtension(
  "tex", "bib", "md", "txt", "html", "sty", "cls", "bst", "tldr", "lattice-sheet",
  "tsx", "ts", "jsx", "js",
);
export const isProjectAssetFilePath = hasExtension("png", "jpg", "jpeg", "pdf", "svg", "eps", "webp");
export const isHtmlFilePath = hasExtension("html");
export const isPreviewableSourceFilePath = hasExtension("tex", "md", "html");
export const isHarperProseFilePath = hasExtension("tex", "md", "txt");

export function deckIdFromOpenSlidePath(path: string): string | null {
  const match = /^slides\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.tsx$/i.exec(
    path.replace(/\\/g, "/"),
  );
  return match?.[1] ?? null;
}

export function isOpenSlideDeckPath(path: string): boolean {
  return deckIdFromOpenSlidePath(path) !== null;
}

export function isWholeFileEditorPath(path: string): boolean {
  const extension = fileExtension(path);
  return isOpenSlideDeckPath(path) || extension === "tldr" || extension === "lattice-sheet";
}

/**
 * Markdown resolves an unprefixed link relative to its own folder. If that
 * relative path does not exist, recover a whole-file document whose known
 * project-root path is the exact suffix (for example a root-level Sheet linked
 * from `notes/`). Exact project paths always win, so ordinary relative links
 * keep their normal meaning.
 */
export function resolveKnownWholeFileProjectPath(
  path: string,
  projectPaths: readonly string[],
): string {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const target = normalize(path);
  const exact = projectPaths.find((candidate) => normalize(candidate) === target);
  if (exact) return exact;
  const [longest] = projectPaths
    .filter((candidate) => isWholeFileEditorPath(candidate) && target.endsWith(`/${normalize(candidate)}`))
    .sort((left, right) => right.length - left.length);
  return longest ?? path;
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
// eslint-disable-next-line lingui/no-unlocalized-strings -- project-relative path prefix
const PAPER_TAB_PREFIX = ".research/papers/";
// eslint-disable-next-line lingui/no-unlocalized-strings -- path suffix
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

/** Controls that keep their own clicks rather than dragging or zooming the window. */
const windowControlSelector = "button, input, select, textarea, a";
let windowDragTimer: ReturnType<typeof setTimeout> | undefined;

export function isWindowDragExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(`[data-window-drag-exclude], ${windowControlSelector}`)) return true;
  const overflowRegion = target.closest("[data-window-drag-exclude-on-overflow]");
  if (!overflowRegion) return false;
  const viewport = overflowRegion.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
  return viewport?.dataset.hasHorizontalOverflow === "true";
}

export function beginWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.buttons !== 1 || event.detail > 1 || isWindowDragExcluded(event.target)) return;
  event.preventDefault();
  clearTimeout(windowDragTimer);
  // Delay drag so a second click can still register as double-click → fullscreen.
  windowDragTimer = setTimeout(() => {
    windowDragTimer = undefined;
    void getCurrentWindow().startDragging();
  }, 180);
}

export function toggleWindowFullscreen(event: React.MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest(windowControlSelector)) return;
  event.preventDefault();
  clearTimeout(windowDragTimer);
  windowDragTimer = undefined;
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
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return i18n._(msg`just now`);
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return i18n._(msg`${minutes}m ago`);
  }
  if (elapsed < 86_400_000) {
    const hours = Math.floor(elapsed / 3_600_000);
    return i18n._(msg`${hours}h ago`);
  }
  return new Date(timestamp).toLocaleDateString();
}

/** Like absoluteProjectPath, except the empty path names the project root itself. */
export function projectItemPath(root: string, relativePath: string): string {
  return relativePath ? absoluteProjectPath(root, relativePath) : root;
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

function closestAcrossShadow(element: Element | null, selector: string): HTMLElement | null {
  let current = element;
  while (current) {
    const match = current.closest<HTMLElement>(selector);
    if (match) return match;
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function trimDirectoryPath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Native drop positions arrive in device pixels; hit testing wants CSS pixels. */
function toCssPoint(position: { x: number; y: number }): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return { x: position.x / scale, y: position.y / scale };
}

/**
 * The directory a file-tree hit means: a flattened "a/b/c" row keeps each
 * directory segment addressable, a folder row is that folder, and a file row
 * is the file's parent. Undefined when neither names a row.
 */
function treeHitDirectory(segment?: HTMLElement | null, row?: HTMLElement | null): string | undefined {
  const segmentPath = segment?.dataset.itemFlattenedSubitem;
  if (segmentPath?.endsWith("/")) return trimDirectoryPath(segmentPath);
  if (!row?.dataset.itemPath) return undefined;
  return trimDirectoryPath(row.dataset.itemType === "folder" ? row.dataset.itemPath : row.dataset.itemParentPath ?? "");
}

/**
 * Resolve a native OS drop to the project directory it lands on, mirroring the
 * tree's own row-drag semantics: a folder row is that folder, a file row is
 * the file's parent, and the rest of the Project pane is the project root
 * (""). Null means the drop was not over the Project pane at all.
 */
export function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const point = toCssPoint(position);
  const element = deepestElementFromPoint(point.x, point.y);
  const explicitPath = closestAcrossShadow(element, "[data-drop-directory]")?.dataset.dropDirectory;
  if (explicitPath) return trimDirectoryPath(explicitPath);
  const hit = treeHitDirectory(
    closestAcrossShadow(element, "[data-item-flattened-subitem]"),
    closestAcrossShadow(element, "[data-item-path]"),
  );
  if (hit !== undefined) return hit;
  // During a native Finder drag, WKWebView can report the tree host or its
  // scroll background even though the pointer is visibly over a row. Recover
  // the virtualized row from its rendered bounds before treating the drop as
  // a project-root drop.
  const projectSection = closestAcrossShadow(element, ".project-section");
  const treeHost = closestAcrossShadow(element, "file-tree-container.lattice-file-tree")
    ?? projectSection?.querySelector<HTMLElement>("file-tree-container.lattice-file-tree");
  const containsPoint = (candidate: Element) => {
    const { width, height, left, right, top, bottom } = candidate.getBoundingClientRect();
    return width > 0 && height > 0 && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  };
  const rowAtPoint = (selector: string) => Array.from(
    treeHost?.shadowRoot?.querySelectorAll<HTMLElement>(selector) ?? [],
  ).find(containsPoint);
  const bounded = treeHitDirectory(rowAtPoint("[data-item-flattened-subitem]"), rowAtPoint("[data-item-path]"));
  if (bounded !== undefined) return bounded;
  // Scoped to the file-tree section: the sidebar also hosts the Papers list,
  // where a stray drop should not silently import into the project root.
  return projectSection ? "" : null;
}

/** The nearest `selector` ancestor of whatever sits at a CSS-pixel point. */
function closestAt(point: { x: number; y: number }, selector: string): HTMLElement | null {
  if (typeof document.elementFromPoint !== "function") return null;
  return document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(selector) ?? null;
}

export function editorPaneAt(position: { x: number; y: number }): EditorPaneId | null {
  const editor = closestAt(position, ".source-editor[data-editor-pane], .dual-empty[data-editor-pane]");
  if (!editor) return null;
  return editor.dataset.editorPane === "secondary" ? "secondary" : "primary";
}

export function dropEditorAt(
  position: { x: number; y: number },
): { x: number; y: number; pane: EditorPaneId } | null {
  const point = toCssPoint(position);
  const pane = editorPaneAt(point);
  return pane ? { ...point, pane } : null;
}

export function dropCanvasAt(position: { x: number; y: number }): boolean {
  return closestAt(toCssPoint(position), ".canvas-body") !== null;
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
  return closestAt(toCssPoint(position), ".synara-frame-shell")?.dataset.ready === "true";
}

export type ProjectPathChange = { previousPath: string; nextPath: string };

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
  const directoryRank = (node: FileNode) => Number(node.kind === "directory");
  return [...nodes].sort((left, right) => directoryRank(right) - directoryRank(left)
    || left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase()));
}

function findProjectFile(nodes: readonly FileNode[], path: string): FileNode | undefined {
  for (const node of nodes) {
    const found = node.path === path ? node : findProjectFile(node.children, path);
    if (found) return found;
  }
}

/**
 * Replace the first node (depth-first) that `edit` answers for with the nodes
 * it returns, or null when it answers for none.
 */
function editProjectTree(
  nodes: readonly FileNode[],
  edit: (node: FileNode) => FileNode[] | undefined,
): FileNode[] | null {
  for (const [index, node] of nodes.entries()) {
    let replacement = edit(node);
    if (!replacement) {
      const children = editProjectTree(node.children, edit);
      if (children) replacement = [{ ...node, children }];
    }
    if (replacement) return [...nodes.slice(0, index), ...replacement, ...nodes.slice(index + 1)];
  }
  return null;
}

function remapProjectFileNode(node: FileNode, change: ProjectPathChange): FileNode {
  const path = remapProjectPath(node.path, [change]);
  return {
    ...node,
    name: path.split("/").at(-1) ?? node.name,
    path,
    children: node.children.map((child) => remapProjectFileNode(child, change)),
  };
}

/** Move one tree entry to its new parent without rescanning the project. */
function applyProjectFilePathChange(nodes: readonly FileNode[], change: ProjectPathChange): FileNode[] {
  if (change.previousPath === change.nextPath) return [...nodes];
  const moved = findProjectFile(nodes, change.previousPath);
  const remaining = moved && editProjectTree(nodes, (node) => (node === moved ? [] : undefined));
  if (!moved || !remaining) return [...nodes];
  const entry = remapProjectFileNode(moved, change);
  const separator = change.nextPath.lastIndexOf("/");
  const parentPath = separator < 0 ? "" : change.nextPath.slice(0, separator);
  const inserted = parentPath
    ? editProjectTree(remaining, (node) => (node.path === parentPath && node.kind === "directory"
      ? [{ ...node, children: sortProjectFiles([...node.children, entry]) }]
      : undefined))
    : sortProjectFiles([...remaining, entry]);
  return inserted ?? [...nodes];
}

export function applyProjectPathChanges(
  snapshot: ProjectSnapshot,
  changes: readonly ProjectPathChange[],
): ProjectSnapshot {
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
    files: changes.reduce<FileNode[]>(applyProjectFilePathChange, snapshot.files),
  };
}

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

type ConfirmActionHandler = (options: ConfirmActionOptions) => Promise<ConfirmActionChoice | boolean>;

let confirmActionHandler: ConfirmActionHandler | null = null;

export function registerConfirmActionHandler(handler: ConfirmActionHandler): () => void {
  confirmActionHandler = handler;
  return () => {
    if (confirmActionHandler === handler) confirmActionHandler = null;
  };
}

/**
 * Ask through the mounted ConfirmActionProvider, or the dialog plugin without one.
 *
 * Not `window.confirm`: Tauri's dialog plugin replaces that global with a call
 * to `plugin:dialog|confirm`, a command it no longer registers and no
 * permission grants, so the ACL rejected it and no dialog appeared — and since
 * a rejected Promise is truthy, `if (!window.confirm(…)) return;` let deletes
 * and restores go ahead unasked. The plugin's own `confirm` uses the registered
 * `plugin:dialog|message`, covered by `dialog:default`.
 */
function askConfirmation(options: ConfirmActionOptions): Promise<ConfirmActionChoice | boolean> {
  return confirmActionHandler
    ? confirmActionHandler(options)
    : confirmDialog(options.message, { title: options.title ?? "Lattice", kind: "warning" });
}

/** Ask before doing something that cannot be taken back, and wait for the answer. */
export async function confirmAction(request: string | ConfirmActionOptions): Promise<boolean> {
  const answer = await askConfirmation(typeof request === "string" ? { message: request } : request);
  return answer === true || answer === "confirm";
}

/**
 * Ask a consequential question with two explicit actions plus Cancel. The
 * native fallback can only confirm or cancel; the mounted app always installs
 * ConfirmActionProvider, and the fallback keeps scripts and isolated component
 * tests safely cancellable.
 */
export async function chooseAction(
  options: ConfirmActionOptions & { alternativeLabel: string },
): Promise<ConfirmActionChoice> {
  const answer = await askConfirmation(options);
  if (answer === true) return "confirm";
  if (answer === false) return "cancel";
  return answer;
}
