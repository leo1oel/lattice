/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original file: packages/app/src/editor/extensions/drag-handle.ts
 * Modified 2026-08-03 for Research Writer's Markdown schema and history model.
 * Licensed under GPL-3.0-or-later.
 */
import { offset } from "@floating-ui/dom";
import { Extension, type Editor } from "@tiptap/core";
import { DragHandlePlugin, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

const HANDLE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 28;
const INSERTED_BLOCK_BOTTOM_GAP = 40;
export const PRESERVE_VISUAL_VIEWPORT_META = "research-writer:preserve-visual-viewport";
export type PreserveVisualViewportMeta = {
  anchorPosition: number;
  anchorTop: number | null;
  insertedPosition: number;
};

/** Align block controls to the first line, or to an atomic divider itself. */
export function blockControlCrossAxisOffset(
  referenceHeight: number,
  lineHeight: number,
  nodeType?: string,
): number {
  if (nodeType === "thematicBreak") return (referenceHeight - HANDLE_HEIGHT) / 2;
  const firstLineHeight = Number.isFinite(lineHeight) && lineHeight > 0
    ? Math.min(referenceHeight, lineHeight)
    : Math.min(referenceHeight, BODY_LINE_HEIGHT);
  return Math.max(0, (firstLineHeight - HANDLE_HEIGHT) / 2);
}

/** Restore the clicked block, then reveal only any new content below the viewport. */
export function restoreVisualViewportWithReveal(
  viewport: HTMLElement,
  scrollTop: number,
  anchor: HTMLElement | null,
  anchorTop: number | null,
  reveal: HTMLElement | null,
): void {
  viewport.scrollTop = scrollTop;
  if (anchor?.isConnected && anchorTop != null) {
    const delta = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 0.25) viewport.scrollTop += delta;
  }
  if (!reveal?.isConnected) return;
  const overflow = reveal.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom;
  if (overflow > 0.25) viewport.scrollTop += overflow + INSERTED_BLOCK_BOTTOM_GAP;
}

function blockLabel(node: ProseMirrorNode | null): string {
  if (!node) return "Select block";
  if (node.type.name === "list") {
    const task = node.firstChild?.attrs.checked != null;
    return `Select ${task ? "task list" : node.attrs.ordered ? "numbered list" : "bullet list"}`;
  }
  if (node.type.name === "jsxComponent") {
    const name = String(node.attrs.componentName ?? "");
    if (name === "Math" || name === "DollarMath" || name === "MathFence") return "Select display equation";
    if (name === "MermaidFence") return "Select Mermaid diagram";
    return "Select component";
  }
  const labels: Record<string, string> = {
    blockquote: "quote",
    codeBlock: "code block",
    footnoteDefinition: "footnote",
    heading: "heading",
    paragraph: "paragraph",
    rawMdxFallback: "source-preserved Markdown",
    table: "table",
    thematicBreak: "divider",
  };
  return `Select ${labels[node.type.name] ?? "block"}`;
}

function createBlockControls() {
  const container = document.createElement("div");
  container.className = "visual-block-controls ok-block-controls";
  container.style.visibility = "hidden";

  const addButton = document.createElement("button");
  addButton.className = "visual-add-block-button ok-add-block-btn";
  addButton.type = "button";
  addButton.setAttribute("aria-label", "Add block below");
  addButton.innerHTML = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
  addButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const grip = document.createElement("button");
  grip.className = "visual-drag-grip ok-drag-grip";
  grip.type = "button";
  grip.setAttribute("aria-label", "Select block");
  grip.setAttribute("tabindex", "-1");
  grip.innerHTML = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>';

  container.append(addButton, grip);
  return { container, addButton, grip };
}

function topLevelBlockAt(state: EditorState, position: number): { from: number; to: number } | null {
  const safePosition = Math.max(0, Math.min(position, state.doc.content.size));
  const $position = state.doc.resolve(safePosition);
  if ($position.depth === 0) {
    const node = state.doc.nodeAt(safePosition);
    return node ? { from: safePosition, to: safePosition + node.nodeSize } : null;
  }
  return { from: $position.before(1), to: $position.after(1) };
}

export function moveTopLevelBlock(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  sourcePosition: number,
  targetPosition: number,
  placeAfter: boolean,
): boolean {
  const source = topLevelBlockAt(state, sourcePosition);
  const target = topLevelBlockAt(state, targetPosition);
  if (!source || !target || source.from === target.from) return false;
  const insertAt = placeAfter ? target.to : target.from;
  if (insertAt >= source.from && insertAt <= source.to) return false;
  const node = state.doc.nodeAt(source.from);
  if (!node) return false;
  if (!dispatch) return true;

  const tr = state.tr.delete(source.from, source.to);
  const mappedInsertAt = tr.mapping.map(insertAt);
  tr.insert(mappedInsertAt, node);
  tr.setSelection(NodeSelection.create(tr.doc, mappedInsertAt)).scrollIntoView();
  dispatch(tr);
  return true;
}

export function addBlockBelow(editor: Editor, nodePosition: number, node: ProseMirrorNode) {
  const { state, view } = editor;
  const insertAt = nodePosition + node.nodeSize;
  if (insertAt > state.doc.content.size) return;
  const paragraph = state.schema.nodes.paragraph?.create(null, state.schema.text("/"));
  if (!paragraph) return;
  const anchorDom = view.nodeDOM(nodePosition);
  const anchorTop = anchorDom instanceof HTMLElement ? anchorDom.getBoundingClientRect().top : null;

  const tr = state.tr
    .insert(insertAt, paragraph)
    .setMeta(PRESERVE_VISUAL_VIEWPORT_META, {
      anchorPosition: nodePosition,
      anchorTop,
      insertedPosition: insertAt,
    } satisfies PreserveVisualViewportMeta);
  // The add button is attached to a visible block, so the new paragraph is
  // already at the viewport edge. Asking ProseMirror to scroll it into view
  // makes WebKit recalculate the entire editable document and can move a long
  // paper's scroll container to the top before its new block has a stable box.
  // The inserted paragraph is exactly `/`: +1 enters its text and +2 is the
  // text cursor after the slash. Use an exact text selection rather than
  // `near`, whose fallback is allowed to choose the cursor before the slash
  // when WebKit has not materialized the new block's DOM yet.
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 2));
  view.dispatch(tr);
  // ProseMirror's focus() uses focusPreventScroll and also synchronizes its DOM
  // selection. Viewport movement remains owned by the shared coordinator.
  view.focus();
}

export function currentTopLevelBlock(state: EditorState): { from: number; to: number } | null {
  if (state.selection instanceof NodeSelection) {
    return state.selection.$from.depth === 0
      ? { from: state.selection.from, to: state.selection.to }
      : null;
  }
  if (!(state.selection instanceof TextSelection)) return null;
  const { $from } = state.selection;
  if ($from.depth === 0) return null;
  const from = $from.before(1);
  const to = $from.after(1);
  if (state.selection.to > to) return null;
  return { from, to };
}

export function moveBlockUp(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean {
  const block = currentTopLevelBlock(state);
  if (!block || block.from === 0) return false;
  const $above = state.doc.resolve(block.from - 1);
  if ($above.depth === 0) return false;

  const aboveFrom = $above.before(1);
  const movingNode = state.doc.slice(block.from, block.to).content;
  const aboveNode = state.doc.slice(aboveFrom, block.from).content;
  if (!dispatch) return true;

  const tr = state.tr.replaceWith(aboveFrom, block.to, movingNode.append(aboveNode));
  if (state.selection instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, aboveFrom));
    dispatch(tr.scrollIntoView());
    return true;
  }
  const cursorOffset = state.selection.from - block.from;
  const newBlockStart = aboveFrom + 1;
  const newBlockEnd = aboveFrom + movingNode.size;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newBlockStart + cursorOffset, newBlockEnd))));
  dispatch(tr.scrollIntoView());
  return true;
}

export function moveBlockDown(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
): boolean {
  const block = currentTopLevelBlock(state);
  if (!block || block.to >= state.doc.content.size) return false;
  const $below = state.doc.resolve(block.to + 1);
  if ($below.depth === 0) return false;

  const belowTo = $below.after(1);
  const movingNode = state.doc.slice(block.from, block.to).content;
  const belowNode = state.doc.slice(block.to, belowTo).content;
  if (!dispatch) return true;

  const tr = state.tr.replaceWith(block.from, belowTo, belowNode.append(movingNode));
  if (state.selection instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, block.from + belowNode.size));
    dispatch(tr.scrollIntoView());
    return true;
  }
  const cursorOffset = state.selection.from - block.from;
  const newBlockStart = block.from + belowNode.size + 1;
  const newBlockEnd = block.from + belowNode.size + movingNode.size;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newBlockStart + cursorOffset, newBlockEnd))));
  dispatch(tr.scrollIntoView());
  return true;
}

export const VisualBlockMover = Extension.create({
  name: "visualBlockMover",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": ({ editor }) => moveBlockUp(editor.state, editor.view.dispatch),
      "Mod-Shift-ArrowDown": ({ editor }) => moveBlockDown(editor.state, editor.view.dispatch),
    };
  },
});

export const VisualBlockControls = Extension.create({
  name: "visualBlockControls",
  addProseMirrorPlugins() {
    const editor = this.editor;
    let currentNode: ProseMirrorNode | null = null;
    let currentNodePosition = -1;
    let didPointerDrag = false;
    let suppressNextClick = false;
    let previousDraggable: string | null = null;
    let pointerStart: {
      id: number;
      x: number;
      y: number;
      sourcePosition: number;
      ghostOffsetX: number;
      ghostOffsetY: number;
    } | null = null;
    let pointerTarget: { position: number; placeAfter: boolean } | null = null;
    let dragGhost: HTMLElement | null = null;
    const { container, addButton, grip } = createBlockControls();

    const dropLine = document.createElement("div");
    dropLine.className = "visual-block-drop-line";
    dropLine.hidden = true;
    const ensureDropLineMounted = () => {
      if (!dropLine.isConnected) document.body.appendChild(dropLine);
    };
    // Fixed overlays must live at the viewport root. The editor itself sits
    // inside an overflow-clipped ScrollArea, which can completely hide a line
    // placed just outside a target block even though its fixed coordinates are
    // correct. The drag ghost already uses this same body-level plane.
    ensureDropLineMounted();

    const resetPointerDrag = () => {
      if (pointerStart && grip.hasPointerCapture(pointerStart.id)) {
        grip.releasePointerCapture(pointerStart.id);
      }
      pointerStart = null;
      pointerTarget = null;
      didPointerDrag = false;
      dropLine.hidden = true;
      dragGhost?.remove();
      dragGhost = null;
      container.dataset.dragging = "false";
      if (previousDraggable === null) container.removeAttribute("draggable");
      else container.setAttribute("draggable", previousDraggable);
      previousDraggable = null;
    };

    grip.addEventListener("pointerdown", (event) => {
      // TipTap may rebuild plugin views during the React editor mount. A stale
      // view's destroy hook removes its overlay, while the drag-handle element
      // itself is retained; remount the line at the start of every gesture so
      // the live interaction cannot inherit that detached overlay.
      ensureDropLineMounted();
      if (event.button !== 0 || currentNodePosition < 0) return;
      event.preventDefault();
      event.stopPropagation();
      didPointerDrag = false;
      suppressNextClick = false;
      pointerTarget = null;
      previousDraggable = container.getAttribute("draggable");
      container.setAttribute("draggable", "false");
      const sourceDom = editor.view.nodeDOM(currentNodePosition);
      const sourceRect = sourceDom instanceof HTMLElement ? sourceDom.getBoundingClientRect() : null;
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        sourcePosition: currentNodePosition,
        ghostOffsetX: sourceRect ? event.clientX - sourceRect.left : 0,
        ghostOffsetY: sourceRect ? event.clientY - sourceRect.top : 0,
      };
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener("pointermove", (event) => {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      if (!didPointerDrag && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5) return;
      didPointerDrag = true;
      event.preventDefault();
      container.dataset.dragging = "true";

      if (!dragGhost) {
        const sourceDom = editor.view.nodeDOM(pointerStart.sourcePosition);
        if (sourceDom instanceof HTMLElement) {
          const rect = sourceDom.getBoundingClientRect();
          dragGhost = sourceDom.cloneNode(true) as HTMLElement;
          dragGhost.className = "visual-block-drag-ghost";
          dragGhost.setAttribute("aria-hidden", "true");
          dragGhost.removeAttribute("contenteditable");
          dragGhost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
          dragGhost.querySelectorAll("[contenteditable]").forEach((element) => element.removeAttribute("contenteditable"));
          dragGhost.style.width = `${rect.width}px`;
          document.body.appendChild(dragGhost);
        }
      }
      if (dragGhost) {
        dragGhost.style.left = `${event.clientX - pointerStart.ghostOffsetX}px`;
        dragGhost.style.top = `${event.clientY - pointerStart.ghostOffsetY}px`;
      }

      const coordinates = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!coordinates) {
        pointerTarget = null;
        dropLine.hidden = true;
        return;
      }
      const target = topLevelBlockAt(editor.state, coordinates.pos);
      if (!target || target.from === pointerStart.sourcePosition) {
        pointerTarget = null;
        dropLine.hidden = true;
        return;
      }
      const targetDom = editor.view.nodeDOM(target.from);
      if (!(targetDom instanceof HTMLElement)) return;
      const rect = targetDom.getBoundingClientRect();
      const placeAfter = event.clientY >= rect.top + rect.height / 2;
      pointerTarget = { position: target.from, placeAfter };
      Object.assign(dropLine.style, {
        left: `${rect.left}px`,
        top: `${placeAfter ? rect.bottom : rect.top}px`,
        width: `${rect.width}px`,
      });
      dropLine.hidden = false;
    });
    const finishPointerDrag = (event: PointerEvent) => {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      const start = pointerStart;
      const target = pointerTarget;
      if (didPointerDrag && target) {
        event.preventDefault();
        moveTopLevelBlock(
          editor.state,
          editor.view.dispatch,
          start.sourcePosition,
          target.position,
          target.placeAfter,
        );
      }
      suppressNextClick = didPointerDrag;
      resetPointerDrag();
    };
    container.addEventListener("dragstart", (event) => {
      if (pointerStart) event.preventDefault();
    });
    grip.addEventListener("pointerup", finishPointerDrag);
    grip.addEventListener("pointercancel", () => {
      suppressNextClick = didPointerDrag;
      resetPointerDrag();
    });

    addButton.addEventListener("click", () => {
      if (currentNode && currentNodePosition >= 0) {
        addBlockBelow(editor, currentNodePosition, currentNode);
      }
    });
    grip.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (currentNodePosition < 0) return;
      const node = editor.state.doc.nodeAt(currentNodePosition);
      if (!node) return;
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, currentNodePosition)),
      );
      editor.view.focus();
    });

    return [
      new Plugin({
        view: () => ({
          destroy: () => {
            resetPointerDrag();
            dropLine.remove();
          },
        }),
      }),
      DragHandlePlugin({
        editor,
        element: container,
        nestedOptions: normalizeNestedOptions(false),
        onNodeChange({ node, pos }: { node: ProseMirrorNode | null; pos: number }) {
          currentNode = node;
          currentNodePosition = pos ?? -1;
          grip.setAttribute("aria-label", blockLabel(node));
        },
        computePositionConfig: {
          placement: getComputedStyle(editor.view.dom).direction === "rtl" ? "right-start" : "left-start",
          strategy: "absolute",
          middleware: [
            offset(({ elements, rects }) => {
              const lineHeight = elements.reference instanceof Element
                ? Number.parseFloat(getComputedStyle(elements.reference).lineHeight)
                : Number.NaN;
              return {
                mainAxis: 10,
                crossAxis: blockControlCrossAxisOffset(
                  rects.reference.height,
                  lineHeight,
                  currentNode?.type.name,
                ),
              };
            }),
          ],
        },
      }).plugin,
    ];
  },
});
