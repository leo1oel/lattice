// Page-side half of scripts/electron-regressions.mjs. The Vite dev server
// serves this module to the harness's window, which calls these exports by
// name: each one mounts a fixture or measures what the page rendered.
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { FileNode } from "../src/app-types";
import { dropDirectoryAt } from "../src/app-utils";
import { createEditorComment } from "../src/editor/comments/editor-comment-data";
import { editorCommentsExtension } from "../src/editor/comments/editor-comments";
import { fileToBase64 } from "../src/editor/insert/clipboard-image";
import { latexEditorExtensions } from "../src/editor/latex/latex-editor";
import { activateAppLocale, i18n } from "../src/i18n";
import { listenForBrowserProjectDrops } from "../src/project/browser-project-drop";
import { Navigator } from "../src/project/navigator";
import "../src/index.css";
import "../src/App.css";

type Point = { x: number; y: number };

const noop = () => {};
const resolved = async (paths: string[]) => paths;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise(requestAnimationFrame);

async function waitFor<T>(read: () => T, timeoutMs: number, intervalMs: number): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let value = read();
  while (!value && performance.now() < deadline) {
    await sleep(intervalMs);
    value = read();
  }
  return value;
}

function center(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function mountFresh() {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

// ---------------------------------------------------------------------------
// Project navigator
// ---------------------------------------------------------------------------

const moves: Array<{ paths: string[]; target: string }> = [];

const treeRoot = () => document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
const treeRow = (path: string) => treeRoot()?.querySelector<HTMLElement>(`[data-item-path="${path}"]`) ?? null;

function ProjectNavigator({ projectKey, files, activeFile }: { projectKey: string; files: FileNode[]; activeFile: string }) {
  return (
    <I18nProvider i18n={i18n}>
      <Navigator
        mode="project" projectKey={projectKey} searchOpen={false}
        onSearchOpenChange={noop} files={files}
        gitStatus={[]} activeFile={activeFile} activeAssetPath="" protectedPaths={[]}
        papers={[]} activePaper={null} onFile={noop} onAsset={noop}
        onBeginFigureDrag={noop} onBeginFileDrag={noop}
        onCreateEntry={async (path) => path} onDeleteEntries={noop}
        onRenameEntry={async (path) => path}
        onMoveEntries={async (paths, target) => {
          moves.push({ paths, target });
          return paths;
        }}
        onCopyEntries={resolved}
        onError={(error) => { throw new Error(error); }} onReveal={noop}
        onImportAssets={noop} onPasteImage={noop} assetDropTarget={null} assetImporting={false}
        onPaper={noop} onFetchFullText={noop} paperFetchStates={{}} onDeletePaper={noop}
        onEditBibEntry={noop} importInput="" setImportInput={noop} onImport={noop}
        onCancelImport={noop} importing={false}
      />
    </I18nProvider>
  );
}

/** A 260px navigator with an editor pane on top of everything to its right; resolves to chapter-one.tex's center. */
export async function mountDragFixture(locale: "en" | "zh-CN" = "en") {
  await activateAppLocale(locale);
  const host = mountFresh();
  host.innerHTML = `
    <div id="navigator-drag-fixture"></div>
    <div data-fixture-editor><div>Split editor</div><div>Drag preview must remain above this pane</div></div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    body { margin: 0; background: var(--surface-canvas); }
    #navigator-drag-fixture { position: fixed; inset: 0 auto 0 0; z-index: 1; width: 260px; background: var(--surface-panel); }
    #navigator-drag-fixture > .navigator { height: 100%; }
    [data-fixture-editor] { position: fixed; inset: 0 0 0 260px; z-index: 20; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; padding: 80px 30px; background: #d8d8da; color: #303036; font: 18px system-ui; }
    [data-fixture-editor] > div { padding: 40px; background: #fafafa; box-shadow: 0 0 0 1px #bbb; }
  `;
  document.head.append(style);
  ReactDOM.createRoot(document.querySelector("#navigator-drag-fixture")!).render(
    <ProjectNavigator projectKey="/tmp/drag-preview" activeFile="chapter-one.tex" files={[
      { name: "chapter-one.tex", path: "chapter-one.tex", kind: "tex", children: [] },
      { name: "chapter-two.tex", path: "chapter-two.tex", kind: "tex", children: [] },
      { name: "sections", path: "sections", kind: "directory", children: [] },
    ]} />,
  );
  const row = await waitFor(() => treeRow("chapter-one.tex"), 3000, 20);
  if (!row) throw new Error("Navigator row did not render");
  await sleep(1000);
  return center(row);
}

/** The navigator inside the real app-shell sidebar geometry, with enough files to scroll. */
export async function mountScrollFixture() {
  await activateAppLocale("en");
  localStorage.clear();
  const shell = mountFresh();
  shell.className = "app-shell";
  shell.style.cssText = "position:fixed;inset:0;background:var(--surface-sidebar)";
  const notes = Array.from({ length: 80 }, (_, i) => `notes-${String(i).padStart(2, "0")}.tex`);
  ReactDOM.createRoot(shell).render(
    <>
      <div className="titlebar" />
      <main className="workspace" style={{ gridTemplateColumns: "280px 1px minmax(0, 1fr)", gridTemplateAreas: '"sidebar sidebar-resizer canvas"' }}>
        <section className="shared-sidebar">
          <div className="workspace-sidebar-content" style={{ width: 280 }}>
            <div className="sidebar-mode-header">Project</div>
            <div className="sidebar-pane">
              <ProjectNavigator projectKey="/tmp/scroll-motion" activeFile="" files={[
                {
                  name: "chapters", path: "chapters", kind: "directory",
                  children: Array.from({ length: 70 }, (_, i) => ({ name: `chapter-${i}.tex`, path: `chapters/chapter-${i}.tex`, kind: "tex", children: [] })),
                },
                ...notes.map((name) => ({ name, path: name, kind: "tex", children: [] })),
              ]} />
            </div>
          </div>
        </section>
        <div className="canvas-panel" />
      </main>
    </>,
  );
  await sleep(500);
}

export const rowCenter = (path: string) => center(treeRow(path)!);
export const clickRow = (path: string) => treeRow(path)!.click();
export const recordedMoves = () => waitFor(() => (moves.length ? moves : null), 5000, 50).then(() => moves);

/** Meta-select chapter-two, then pointer-drag chapter-one from `start` to `destination` without releasing. */
export function startPointerDrag(start: Point, destination: Point) {
  treeRow("chapter-two.tex")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true }));
  treeRow("chapter-one.tex")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerId: 1, clientX: start.x, clientY: start.y }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: start.x + 8, clientY: start.y + 8 }));
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: destination.x, clientY: destination.y }));
}

export function endPointerDrag(destination: Point) {
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: destination.x, clientY: destination.y }));
}

const dragPreview = () => treeRoot()?.querySelector<HTMLElement>("[data-lattice-pointer-drag-preview]") ?? null;
export const dragPreviewRemoved = () => !dragPreview();

export function measureDragPreview() {
  const preview = dragPreview();
  if (!preview) throw new Error("Pointer interaction did not create a drag preview");
  const rect = preview.getBoundingClientRect();
  return {
    open: preview.matches(":popover-open"), text: preview.textContent,
    count: preview.querySelector("[data-lattice-pointer-drag-count]")?.textContent,
    pointerEvents: getComputedStyle(preview).pointerEvents, left: rect.left, top: rect.top,
  };
}

export function hiddenFilesToggleIconVisible() {
  const icon = document.querySelector('[role="menuitemcheckbox"] svg');
  return !!icon && getComputedStyle(icon).visibility === "visible";
}

// ---------------------------------------------------------------------------
// File drops onto the navigator
// ---------------------------------------------------------------------------

let upload: { directory: string; files: Array<{ name: string; base64: string }> } | null = null;
const dropTargets: Array<string | null> = [];
let disposeBrowserDrop = noop;

/** An ordinary browser tab: no desktop bridge, so dropped files arrive as bytes. */
export async function listenForBrowserDrops() {
  if ((window as { latticeDesktop?: unknown }).latticeDesktop) throw new Error("This test must not use the desktop bridge");
  await mountDragFixture();
  disposeBrowserDrop = listenForBrowserProjectDrops(async (files, directory) => {
    upload = { directory, files: await Promise.all(files.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) }))) };
  }, (target) => dropTargets.push(target));
  return rowCenter("sections/");
}

export async function browserDropResult() {
  await waitFor(() => upload, 5000, 20);
  disposeBrowserDrop();
  return { upload, targets: dropTargets };
}

const desktopEvents: Array<Record<string, unknown>> = [];
let domDrops = 0;

/** The bundled-Chromium path: OS file paths reach Tauri-style drag subscribers. */
export async function listenForDesktopDrops() {
  await mountDragFixture();
  // Imported here, not above: loading it starts the loopback browser runtime.
  const { BrowserEventRegistry } = await import("../src/platform/browser-runtime");
  const registry = new BrowserEventRegistry((subscriber, received) => {
    const { event, payload } = received as { event: string; payload: { position: Point } };
    desktopEvents.push({ subscriber, event, ...payload, directory: dropDirectoryAt(payload.position) });
  });
  // Match the paper-lookup listener and the later project-file importer.
  for (const subscriber of [11, 22]) {
    for (const kind of ["enter", "over", "drop", "leave"]) registry.listen(`tauri://drag-${kind}`, subscriber);
  }
  treeRow("sections/")!.addEventListener("drop", () => domDrops++);
  return rowCenter("sections/");
}

export const desktopDropResult = () => ({ received: desktopEvents, domDrops });

// ---------------------------------------------------------------------------
// Editor popovers
// ---------------------------------------------------------------------------

let commentView: EditorView | undefined;

/** A commented sentence at `top`; resolves to a point over the comment. */
export function mountComment(top: number, long: boolean) {
  commentView?.destroy();
  const host = mountFresh();
  host.className = "source-editor";
  host.style.cssText = `position:absolute;left:40px;top:${top}px;width:700px;height:80px`;
  const source = "A commented sentence in the document.";
  const comment = createEditorComment({
    path: "main.tex", source, from: 0, to: source.length,
    authorId: "reviewer", authorName: "Reviewer",
    body: long
      ? Array.from({ length: 35 }, (_, index) => `${index + 1}. Please clarify how this result follows from the assumptions.`).join("\n")
      : "Please clarify this result.",
  })!;
  commentView = new EditorView({ parent: host, state: EditorState.create({
    doc: source,
    extensions: [editorCommentsExtension("main.tex", {
      getComments: () => [comment],
      onResolve: () => { host.dataset.resolved = "true"; },
      onReply: () => { host.dataset.replied = "true"; },
    })],
  }) });
  const point = commentView.coordsAtPos(8)!;
  return { x: Math.round(point.left), y: Math.round((point.top + point.bottom) / 2) };
}

/** Scroll the open comment card to its end and measure it against the window. */
export function measureCommentTooltip() {
  const card = document.querySelector(".cm-editor-comment-tooltip");
  if (!card) throw new Error("Comment tooltip did not open");
  const outer = card.closest(".cm-tooltip-hover")!;
  const scroll = [outer, card].find((element) => /auto|scroll/.test(getComputedStyle(element).overflowY)) ?? outer;
  scroll.scrollTop = scroll.scrollHeight;
  const rect = outer.getBoundingClientRect();
  const button = card.querySelector("button:last-child")!.getBoundingClientRect();
  return {
    top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
    viewportHeight: innerHeight, viewportWidth: innerWidth,
    scrollable: scroll.scrollTop > 1,
    buttonTop: button.top, buttonBottom: button.bottom,
    buttonX: Math.round((button.left + button.right) / 2),
    buttonY: Math.round((button.top + button.bottom) / 2),
  };
}

export const commentReplied = () =>
  waitFor(() => document.querySelector<HTMLElement>(".source-editor")!.dataset.replied === "true", 2000, 20);

/**
 * Open the citation menu at every combination of editor height and cursor line,
 * scroll it to the end, and measure it. The last (constrained, upward-opening)
 * case stays mounted for the screenshot.
 */
export async function measureCitationMenus() {
  const pause = () => sleep(150);
  const host = mountFresh();
  host.className = "source-editor";
  host.style.cssText = "width:700px;margin:40px;height:240px;";
  const citations = Array.from({ length: 20 }, (_, i) => ({
    key: "paper" + String(i).padStart(2, "0"),
    title: "Research on collaborative writing — " + (i + 1),
    authors: "Alice Lee and Bo Zhang", year: "2026", venue: "CHI",
  }));
  const results = [];
  for (const height of [500, 240]) {
    for (const lines of [0, 7]) {
      host.style.height = height + "px";
      const doc = "\n".repeat(lines) + "\\cite{}";
      const view = new EditorView({ parent: host, state: EditorState.create({
        doc, selection: { anchor: doc.length - 1 },
        extensions: [
          latexEditorExtensions({ live: { current: {
            citationKeys: [], citations, references: [], unusedLabels: [], unusedCitations: [],
            localMacros: [], graphicsRoots: [], projectPaths: [], spellingWords: [],
          } } }),
          autocompletion({ closeOnBlur: false }),
          EditorView.theme({ "&": { height: "100%" } }),
        ],
      }) });
      view.focus();
      startCompletion(view);
      let menu: Element | null = null;
      for (let i = 0; i < 40 && !menu; i++) {
        await pause();
        menu = host.querySelector(".cm-citation-menu");
      }
      if (!menu) throw new Error("Citation menu did not open");
      await pause();
      const list = menu.querySelector("ul")!;
      list.scrollTop = list.scrollHeight;
      await pause();
      const outer = menu.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      const detail = list.lastElementChild!.querySelector(".cm-completionDetail")!.getBoundingClientRect();
      results.push({ height, lines, outerBottom: outer.bottom, listBottom: viewport.bottom,
        outerRight: outer.right, listRight: viewport.right, detailBottom: detail.bottom,
        scrollable: list.scrollHeight > list.clientHeight });
      if (height === 240 && lines === 7) break;
      view.destroy();
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Navigator collapse motion and external scrollbar
// ---------------------------------------------------------------------------

const scrollViewport = () => treeRoot()!.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]')!;
const scrollbar = () => document.querySelector<HTMLElement>(".external-scrollbar")!;

export function scrollGeometry() {
  return {
    viewport: scrollViewport().getBoundingClientRect().toJSON(),
    track: scrollbar().getBoundingClientRect().toJSON(),
    surface: scrollbar().parentElement!.getBoundingClientRect().toJSON(),
  };
}

/** Collapse chapters/ and sample the exit picture against the next row at paused animation times. */
export async function collapseMotion() {
  const tree = treeRoot()!;
  const folder = treeRow("chapters/")!;
  folder.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  folder.click();
  await nextFrame();
  const animations = tree.getAnimations();
  const picture = tree.querySelector("[data-tree-exit]");
  const sibling = treeRow("notes-00.tex")!;
  if (!picture) throw new Error("Collapse did not create an exit picture");
  return [20, 120, 60].map((time) => {
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = time;
    }
    const rect = picture.getBoundingClientRect();
    const percent = Number(getComputedStyle(picture).clipPath.match(/([\d.]+)%/)![1]);
    return { time, visibleBottom: rect.bottom - rect.height * percent / 100, siblingTop: sibling.getBoundingClientRect().top };
  });
}

export const finishAnimations = () => treeRoot()!.getAnimations().forEach((animation) => animation.finish());

export function scrollTrack() {
  const r = scrollbar().getBoundingClientRect();
  const v = scrollViewport().getBoundingClientRect();
  return { x: Math.round(r.right - 6), y: Math.round(r.top + 12), bottom: Math.round(r.bottom - 4), viewportBottom: v.bottom, top: r.top, viewportTop: v.top };
}

export const scrollbarOpacity = () => getComputedStyle(scrollbar()).opacity;

export function scrollEnd() {
  const viewport = scrollViewport();
  return { scrollTop: viewport.scrollTop, max: viewport.scrollHeight - viewport.clientHeight, last: treeRow("notes-79.tex")?.getBoundingClientRect().toJSON() };
}

export async function thumbAtBottom() {
  const thumb = document.querySelector('.external-scrollbar [data-slot="scroll-area-thumb"]')!;
  const deadline = performance.now() + 5000;
  while (Math.abs(thumb.getBoundingClientRect().bottom - (innerHeight - 4)) > 1 && performance.now() < deadline) {
    await nextFrame();
  }
  // Scroll geometry updates in rAF. Wait for the resulting React commit
  // and paint before capturing, rather than photographing the old thumb.
  await nextFrame();
  await nextFrame();
  return { window: innerHeight, track: scrollbar().getBoundingClientRect().bottom, thumb: thumb.getBoundingClientRect().bottom };
}
