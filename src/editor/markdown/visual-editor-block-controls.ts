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
import { element } from "../dom-utils";

type Dispatch = ((transaction: Transaction) => void) | undefined;

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
export function blockControlCrossAxisOffset(referenceHeight: number, lineHeight: number, nodeType?: string, visualTopOffset?: number): number {
  if (visualTopOffset != null && Number.isFinite(visualTopOffset)) return Math.max(0, visualTopOffset);
  if (nodeType === "thematicBreak") return (referenceHeight - HANDLE_HEIGHT) / 2;
  const firstLineHeight = Math.min(referenceHeight, Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : BODY_LINE_HEIGHT);
  return Math.max(0, (firstLineHeight - HANDLE_HEIGHT) / 2);
}

/** Restore the clicked block, then reveal only any new content below the viewport. */
export function restoreVisualViewportWithReveal(
  viewport: HTMLElement, scrollTop: number, anchor: HTMLElement | null, anchorTop: number | null, reveal: HTMLElement | null,
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

const BLOCK_LABELS: Record<string, string> = {
  blockquote: "quote",
  codeBlock: "code block",
  footnoteDefinition: "footnote",
  heading: "heading",
  listItem: "list item",
  paragraph: "paragraph",
  rawMdxFallback: "source-preserved Markdown",
  table: "table",
  thematicBreak: "divider",
};
const COMPONENT_LABELS: Record<string, string> = {
  Math: "display equation",
  DollarMath: "display equation",
  MathFence: "display equation",
  MermaidFence: "Mermaid diagram",
};

function blockLabel(node: ProseMirrorNode | null): string {
  if (node?.type.name === "list") {
    const task = node.firstChild?.attrs.checked != null;
    return `Select ${task ? "task list" : node.attrs.ordered ? "numbered list" : "bullet list"}`;
  }
  const label = node?.type.name === "jsxComponent"
    ? COMPONENT_LABELS[String(node.attrs.componentName ?? "")] ?? "component"
    : BLOCK_LABELS[node?.type.name ?? ""] ?? "block";
  return `Select ${label}`;
}

/** Images align their controls to the resizable frame, not the wrapper's first line. */
function imageVisualTopOffset(editor: Editor, node: ProseMirrorNode | null, position: number): number | undefined {
  if (node?.type.name !== "jsxComponent" || position < 0) return undefined;
  if (!["img", "CommonMarkImage", "WikiEmbedImage"].includes(String(node.attrs.componentName ?? ""))) return undefined;
  const reference = editor.view.nodeDOM(position);
  if (!(reference instanceof HTMLElement)) return undefined;
  const image = reference.querySelector<HTMLElement>(".ok-image-resizable");
  if (!image) return undefined;
  const offset = image.getBoundingClientRect().top - reference.getBoundingClientRect().top;
  return Number.isFinite(offset) ? offset : undefined;
}

function controlButton(className: string, label: string, iconPaths: string): HTMLButtonElement {
  const button = element("button", className);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>`;
  return button;
}

function createBlockControls() {
  const container = element("div", "visual-block-controls ok-block-controls");
  container.style.visibility = "hidden";
  const addButton = controlButton("visual-add-block-button ok-add-block-btn", "Add block below", '<path d="M5 12h14"/><path d="M12 5v14"/>');
  addButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  const grip = controlButton(
    "visual-drag-grip ok-drag-grip",
    "Select block",
    [5, 12, 19].map((y) => `<circle cx="9" cy="${y}" r="1"/><circle cx="15" cy="${y}" r="1"/>`).join(""),
  );
  grip.setAttribute("tabindex", "-1");
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

/** Resolve the nearest item, keeping nested lists in their own sibling group. */
function listItemAt(state: EditorState, position: number) {
  const $pos = state.doc.resolve(position);
  if ($pos.nodeAfter?.type.name === "listItem") {
    return { from: position, to: position + $pos.nodeAfter.nodeSize, parent: $pos.start() };
  }
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "listItem") {
      return { from: $pos.before(depth), to: $pos.after(depth), parent: $pos.start(depth - 1) };
    }
  }
  return null;
}

function selectedListItems(state: EditorState) {
  const first = listItemAt(state, state.selection.from);
  const last = listItemAt(state, Math.max(state.selection.from, state.selection.to - 1));
  return first && last && first.parent === last.parent
    ? { from: first.from, to: last.to, parent: first.parent }
    : null;
}

function listDropTarget(editor: Editor, parent: number, x: number, y: number) {
  const listDom = editor.view.nodeDOM(parent - 1);
  const list = editor.state.doc.nodeAt(parent - 1);
  if (!(listDom instanceof HTMLElement) || !list) return null;
  const bounds = listDom.getBoundingClientRect();
  const editorBounds = editor.view.dom.getBoundingClientRect();
  // The grip travels through the marker gutter, and the insertion boundary
  // after the last item lies just outside its text hitbox. Resolve sibling
  // geometry rather than asking ProseMirror for a text caret at that point.
  if (x < editorBounds.left - 40 || x > editorBounds.right + 40
    || y < bounds.top - 12 || y > bounds.bottom + 12) return null;
  let target: { from: number; rect: DOMRect } | null = null;
  list.forEach((_item, offset) => {
    if (target && y < target.rect.bottom) return;
    const from = parent + offset;
    const dom = editor.view.nodeDOM(from);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    target = { from, rect };
  });
  return target;
}

function createDragGhost(source: HTMLElement): HTMLElement {
  const ghost = element("div", "visual-block-drag-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  // A body-level clone no longer matches the editor's scoped typography.
  // Snapshot its resolved styles once, so headings, lists and inline marks
  // retain the exact size and wrapping the user picked up.
  originals.forEach((element, index) => {
    const copy = copies[index]!;
    const style = getComputedStyle(element);
    for (const property of style) copy.style.setProperty(property, style.getPropertyValue(property));
    copy.style.pointerEvents = "none";
    copy.removeAttribute("id");
    copy.removeAttribute("contenteditable");
  });
  clone.style.margin = "0";
  ghost.style.width = `${source.getBoundingClientRect().width}px`;
  ghost.appendChild(clone);
  return ghost;
}

/** Reorder siblings without converting list types or changing nesting. */
export function moveListItems(state: EditorState, dispatch: Dispatch, sourcePosition: number, targetPosition: number, placeAfter: boolean): boolean {
  const item = listItemAt(state, sourcePosition);
  const target = listItemAt(state, targetPosition);
  if (!item || !target || item.parent !== target.parent) return false;
  const selected = selectedListItems(state);
  const preserveSelection = selected && item.from >= selected.from && item.to <= selected.to;
  const source = preserveSelection ? selected : item;
  const insertAt = placeAfter ? target.to : target.from;
  if (insertAt >= source.from && insertAt <= source.to) return false;
  if (!dispatch) return true;

  const content = state.doc.slice(source.from, source.to).content;
  const tr = state.tr.delete(source.from, source.to);
  const destination = tr.mapping.map(insertAt);
  tr.insert(destination, content);
  const list = tr.doc.nodeAt(item.parent - 1)!;
  // Source ordinals preserve authored numbering during normal edits, but must
  // follow the new order after an explicit reorder (including non-1 starts).
  if (list.attrs.ordered) {
    list.forEach((child, offset, index) => {
      tr.setNodeMarkup(item.parent + offset, undefined, { ...child.attrs, sourceOrdinal: Number(list.attrs.start) + index });
    });
  }
  if (preserveSelection && state.selection instanceof TextSelection) {
    const shift = destination - source.from;
    tr.setSelection(TextSelection.create(tr.doc, state.selection.anchor + shift, state.selection.head + shift));
  } else {
    tr.setSelection(NodeSelection.create(tr.doc, destination));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

function moveSelectedListItems(state: EditorState, dispatch: Dispatch, down: boolean) {
  const items = selectedListItems(state);
  if (!items) return false;
  const parent = state.doc.nodeAt(items.parent - 1)!;
  if (down ? items.to === items.parent + parent.content.size : items.from === items.parent) return false;
  return moveListItems(state, dispatch, items.from, down ? items.to : items.from - 1, down);
}

export function moveTopLevelBlock(state: EditorState, dispatch: Dispatch, sourcePosition: number, targetPosition: number, placeAfter: boolean): boolean {
  const source = topLevelBlockAt(state, sourcePosition);
  const target = topLevelBlockAt(state, targetPosition);
  if (!source || !target || source.from === target.from) return false;
  const insertAt = placeAfter ? target.to : target.from;
  if (insertAt >= source.from && insertAt <= source.to) return false;
  if (!dispatch) return true;

  const content = state.doc.slice(source.from, source.to).content;
  const tr = state.tr.delete(source.from, source.to);
  const destination = tr.mapping.map(insertAt);
  tr.insert(destination, content);
  dispatch(tr.setSelection(NodeSelection.create(tr.doc, destination)).scrollIntoView());
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

function currentTopLevelBlock(state: EditorState): { from: number; to: number } | null {
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

/** Swap the current top-level block (or selected list items) with its neighbour. */
function moveBlock(state: EditorState, dispatch: Dispatch, down: boolean): boolean {
  if (listItemAt(state, state.selection.from)) return moveSelectedListItems(state, dispatch, down);
  const block = currentTopLevelBlock(state);
  if (!block || (down ? block.to >= state.doc.content.size : block.from === 0)) return false;
  const $neighbour = state.doc.resolve(down ? block.to + 1 : block.from - 1);
  if ($neighbour.depth === 0) return false;

  const from = down ? block.from : $neighbour.before(1);
  const to = down ? $neighbour.after(1) : block.to;
  const moving = state.doc.slice(block.from, block.to).content;
  const neighbour = down ? state.doc.slice(block.to, to).content : state.doc.slice(from, block.from).content;
  if (!dispatch) return true;

  const tr = state.tr.replaceWith(from, to, down ? neighbour.append(moving) : moving.append(neighbour));
  const movedFrom = down ? from + neighbour.size : from;
  if (state.selection instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, movedFrom));
  } else {
    const cursor = Math.min(movedFrom + 1 + state.selection.from - block.from, movedFrom + moving.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

export const moveBlockUp = (state: EditorState, dispatch?: Dispatch) => moveBlock(state, dispatch, false);
export const moveBlockDown = (state: EditorState, dispatch?: Dispatch) => moveBlock(state, dispatch, true);

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
    let pointerStart: { id: number; x: number; y: number; sourcePosition: number; ghostOffsetX: number } | null = null;
    let pointerTarget: { position: number; placeAfter: boolean } | null = null;
    let dragGhost: HTMLElement | null = null;
    const { container, addButton, grip } = createBlockControls();

    const dropLine = element("div", "visual-block-drop-line");
    dropLine.hidden = true;
    const ensureDropLineMounted = () => {
      if (!dropLine.isConnected) document.body.appendChild(dropLine);
    };
    // Fixed overlays must live at the viewport root. The editor itself sits
    // inside an overflow-clipped ScrollArea, which can completely hide a line
    // placed just outside a target block even though its fixed coordinates are
    // correct. The drag ghost already uses this same body-level plane.
    ensureDropLineMounted();

    const hideDropTarget = () => {
      pointerTarget = null;
      dropLine.hidden = true;
    };
    const resetPointerDrag = () => {
      if (pointerStart && grip.hasPointerCapture(pointerStart.id)) grip.releasePointerCapture(pointerStart.id);
      pointerStart = null;
      didPointerDrag = false;
      hideDropTarget();
      dragGhost?.remove();
      dragGhost = null;
      container.dataset.dragging = "false";
      if (previousDraggable === null) container.removeAttribute("draggable");
      else container.setAttribute("draggable", previousDraggable);
      previousDraggable = null;
    };

    /** End the gesture; a real drag swallows the click that follows it. */
    const cancelPointerDrag = () => {
      suppressNextClick = didPointerDrag;
      resetPointerDrag();
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
      const ghostOffsetX = sourceRect ? event.clientX - sourceRect.left : 0;
      pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, sourcePosition: currentNodePosition, ghostOffsetX };
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
          dragGhost = createDragGhost(sourceDom);
          document.body.appendChild(dragGhost);
        }
      }
      if (dragGhost) {
        dragGhost.style.left = `${event.clientX - pointerStart.ghostOffsetX}px`;
        // Keep the dragged text clear of the insertion line under the pointer.
        dragGhost.style.top = `${event.clientY + 12}px`;
      }

      const sourceItem = listItemAt(editor.state, pointerStart.sourcePosition);
      const coordinates = sourceItem ? null : editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const target = sourceItem
        ? listDropTarget(editor, sourceItem.parent, event.clientX, event.clientY)
        : coordinates && topLevelBlockAt(editor.state, coordinates.pos);
      if (!target || target.from === pointerStart.sourcePosition) return hideDropTarget();
      const targetDom = editor.view.nodeDOM(target.from);
      if (!(targetDom instanceof HTMLElement)) return;
      const rect = targetDom.getBoundingClientRect();
      const placeAfter = event.clientY >= rect.top + rect.height / 2;
      if (sourceItem && !moveListItems(editor.state, undefined, sourceItem.from, target.from, placeAfter)) return hideDropTarget();
      pointerTarget = { position: target.from, placeAfter };
      Object.assign(dropLine.style, { left: `${rect.left}px`, top: `${placeAfter ? rect.bottom : rect.top}px`, width: `${rect.width}px` });
      dropLine.hidden = false;
    });
    const finishPointerDrag = (event: PointerEvent) => {
      if (!pointerStart || event.pointerId !== pointerStart.id) return;
      if (didPointerDrag && pointerTarget) {
        event.preventDefault();
        const { sourcePosition } = pointerStart;
        const move = listItemAt(editor.state, sourcePosition) ? moveListItems : moveTopLevelBlock;
        move(editor.state, editor.view.dispatch, sourcePosition, pointerTarget.position, pointerTarget.placeAfter);
      }
      cancelPointerDrag();
    };
    container.addEventListener("dragstart", (event) => {
      if (pointerStart) event.preventDefault();
    });
    grip.addEventListener("pointerup", finishPointerDrag);
    grip.addEventListener("pointercancel", () => cancelPointerDrag());

    addButton.addEventListener("click", () => {
      if (currentNode && currentNodePosition >= 0) addBlockBelow(editor, currentNodePosition, currentNode);
    });
    grip.addEventListener("click", () => {
      const suppressed = suppressNextClick;
      suppressNextClick = false;
      if (suppressed || currentNodePosition < 0 || !editor.state.doc.nodeAt(currentNodePosition)) return;
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, currentNodePosition)));
      editor.view.focus();
    });

    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousemove: (view, event) => {
              if (currentNode?.type.name !== "listItem" || container.style.visibility === "hidden") return false;
              const item = view.nodeDOM(currentNodePosition);
              if (!(item instanceof HTMLElement)) return false;
              const itemRect = item.getBoundingClientRect();
              const handleRect = container.getBoundingClientRect();
              const rtl = getComputedStyle(view.dom).direction === "rtl";
              // Keep the hovered item while crossing its marker/gutter to the
              // grip. Hit-testing that gap resolves to the list itself, which
              // otherwise moves the handle away before it can be clicked.
              // Restrict this bridge to the handle's row so other items and
              // nested lists remain independently targetable.
              return event.clientY >= Math.min(itemRect.top, handleRect.top)
                && event.clientY <= handleRect.bottom
                && event.clientX >= (rtl ? itemRect.right : handleRect.left)
                && event.clientX <= (rtl ? handleRect.right : itemRect.left);
            },
          },
        },
        view: () => ({
          update: (_view, previousState) => {
            // External edits can invalidate pointer-held positions. Cancel
            // rather than moving a different item after a collaborative update.
            if (pointerStart && previousState.doc !== editor.state.doc) cancelPointerDrag();
          },
          destroy: () => {
            resetPointerDrag();
            dropLine.remove();
          },
        }),
      }),
      DragHandlePlugin({
        editor,
        element: container,
        nestedOptions: normalizeNestedOptions({
          defaultRules: false,
          edgeDetection: "none",
          rules: [{
            id: "lattice-list-items",
            evaluate: ({ node, depth }) => depth > 1 && node.type.name !== "listItem" ? 1000 : 0,
          }],
        }),
        onNodeChange({ node, pos }: { node: ProseMirrorNode | null; pos: number }) {
          currentNode = node;
          currentNodePosition = pos ?? -1;
          grip.setAttribute("aria-label", blockLabel(node));
          // A paragraph cannot be inserted as a sibling of a list item.
          addButton.style.display = node?.type.name === "listItem" ? "none" : "";
        },
        getReferencedVirtualElement: () => {
          if (currentNode?.type.name !== "listItem") return null;
          const item = editor.view.nodeDOM(currentNodePosition);
          if (!(item instanceof HTMLElement) || !item.parentElement) return null;
          const list = item.parentElement;
          // Markers sit outside the li's box. Anchor horizontally to its own
          // list's outer edge, but vertically to the item being moved. This
          // reserves the list's full marker gutter, including wide ordinals.
          return {
            contextElement: item,
            getBoundingClientRect: () => {
              const itemRect = item.getBoundingClientRect();
              const listRect = list.getBoundingClientRect();
              return new DOMRect(listRect.left, itemRect.top, listRect.width, itemRect.height);
            },
          };
        },
        computePositionConfig: {
          placement: getComputedStyle(editor.view.dom).direction === "rtl" ? "right-start" : "left-start",
          strategy: "absolute",
          middleware: [
            offset(({ elements, rects }) => {
              const lineHeight = elements.reference instanceof Element
                ? Number.parseFloat(getComputedStyle(elements.reference).lineHeight)
                : Number.NaN;
              const visualTopOffset = imageVisualTopOffset(editor, currentNode, currentNodePosition);
              const crossAxis = blockControlCrossAxisOffset(rects.reference.height, lineHeight, currentNode?.type.name, visualTopOffset);
              return { mainAxis: 10, crossAxis };
            }),
          ],
        },
      }).plugin,
    ];
  },
});
