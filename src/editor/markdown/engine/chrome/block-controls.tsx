/**
 * Block controls (spec R-CHR-5, R-FMT-15, R-FMT-16): hovering a block shows
 * "Add block below" and a "Select block" grip in the left gutter; hovering a
 * list item shows its own grip. The grip selects its block on click and moves
 * it by pointer drag, with a ghost that keeps the block's type metrics and a
 * drop line between siblings (a list item drops only within its list). Add
 * below inserts a paragraph holding `/`, so the slash menu opens there.
 * Mod-Shift-↑/↓ move the block around the caret.
 *
 * The pointer drag is ProseMirror transactions, not native drag and drop, so
 * it behaves the same in WebKit.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the keymap belongs with the controls */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { GripVertical, Plus } from "lucide-react";
import { moveBlockDown, moveBlockTo, moveBlockUp } from "../block-moves";

export const BlockMoveKeymap = Extension.create({
  name: "latticeBlockMoves",
  addKeyboardShortcuts: () => ({
    "Mod-Shift-ArrowUp": ({ editor }) => moveBlockUp(editor.state, editor.view.dispatch),
    "Mod-Shift-ArrowDown": ({ editor }) => moveBlockDown(editor.state, editor.view.dispatch),
  }),
});

/** A block the controls act on: its DOM, its position, and what kind it is. */
type Target = { element: HTMLElement; position: number; kind: "block" | "item" | "list"; listKind?: string };

/** Insert a paragraph holding `/` after the block at `position`, caret after the slash. */
export function addBlockBelow(editor: Editor, position: number) {
  const node = editor.state.doc.nodeAt(position);
  if (!node) return;
  // Below a list item, the new line starts after its list.
  const $at = editor.state.doc.resolve(position);
  const after = $at.depth > 0 && editor.state.doc.nodeAt($at.before($at.depth)) ? $at.after(1) : position + node.nodeSize;
  const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text("/"));
  const transaction = editor.state.tr.insert(after, paragraph);
  transaction.setSelection(TextSelection.create(transaction.doc, after + 2));
  editor.view.dispatch(transaction);
  editor.view.focus();
  revealBelow(editor, after + 2);
}

/** Bring a caret below the fold into view with some room to spare, without jumping otherwise. */
function revealBelow(editor: Editor, position: number) {
  const scroller = editor.view.dom.closest(".markdown-preview-content, .editor-doc-scroll") as HTMLElement | null;
  if (!scroller) return;
  const caret = editor.view.coordsAtPos(position);
  const bounds = scroller.getBoundingClientRect();
  const room = 40;
  if (caret.bottom + room > bounds.bottom) scroller.scrollTop += caret.bottom + room - bounds.bottom;
}

/** The top-level child of the surface under vertical position `y`, found by bisection. */
function topLevelAt(surface: HTMLElement, y: number): HTMLElement | null {
  const children = surface.children;
  let low = 0;
  let high = children.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const rect = (children[middle] as HTMLElement).getBoundingClientRect();
    if (y < rect.top) high = middle - 1;
    else if (y >= rect.bottom) low = middle + 1;
    else return children[middle] as HTMLElement;
  }
  // Between blocks: the one just above.
  return (children[Math.max(0, Math.min(high, children.length - 1))] as HTMLElement | undefined) ?? null;
}

function targetAt(editor: Editor, x: number, y: number): Target | null {
  const surface = editor.view.dom;
  const block = topLevelAt(surface, y);
  if (!block) return null;
  const resolved = resolveTopLevel(editor, editor.view.posAtDOM(block, 0));
  if (resolved == null) return null;
  const list = block.matches("ul, ol") ? block : null;
  if (list) {
    const items = [...list.querySelectorAll<HTMLElement>(":scope li")].filter((item) => {
      const rect = item.getBoundingClientRect();
      return y >= rect.top && y < rect.bottom;
    });
    // The innermost item under the pointer, unless the pointer is in the list's
    // marker gutter (left of the item, or right of it in right-to-left text).
    const item = items[items.length - 1];
    const itemRect = item?.getBoundingClientRect();
    if (item && itemRect && (isRtl(item) ? x <= itemRect.right + 4 : x >= itemRect.left - 4)) {
      const inside = editor.view.posAtDOM(item, 0);
      const itemPosition = editor.state.doc.resolve(inside).before();
      return { element: item, position: itemPosition, kind: "item" };
    }
    return { element: list, position: resolved, kind: "list", listKind: editor.state.doc.nodeAt(resolved)?.type.name };
  }
  return { element: block, position: resolved, kind: "block" };
}

const isRtl = (element: HTMLElement) => getComputedStyle(element).direction === "rtl";

/**
 * Whether the pointer is still on a hovered list item's row, out in its marker
 * gutter: the path from the item's text to its grip, which keeps the item
 * targeted there. Anywhere else in the gutter targets the whole list.
 */
function besideItem(target: Target | null, x: number, y: number): boolean {
  if (target?.kind !== "item" || !target.element.isConnected) return false;
  const rect = target.element.getBoundingClientRect();
  return y >= rect.top && y < rect.bottom && (isRtl(target.element) ? x > rect.right : x < rect.left);
}

/** The start of the top-level node containing `position`. */
function resolveTopLevel(editor: Editor, position: number): number | null {
  const { doc } = editor.state;
  const clamped = Math.max(0, Math.min(position, doc.content.size));
  const $at = doc.resolve(clamped);
  if ($at.depth === 0) {
    const index = $at.index(0);
    if (index >= doc.childCount) return null;
    let offset = 0;
    for (let child = 0; child < index; child += 1) offset += doc.child(child).nodeSize;
    return offset;
  }
  return $at.before(1);
}

type Drag = { target: Target; startY: number; ghost: HTMLElement | null; line: HTMLElement; drop: { position: number; after: boolean } | null };

export function BlockControls({ editor, layer }: { editor: Editor; layer: HTMLElement | null }) {
  const { t } = useLingui();
  const [target, setTarget] = useState<Target | null>(null);
  const drag = useRef<Drag | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!layer) return;
    const onMove = (event: MouseEvent) => {
      if (drag.current || !editor.isEditable) return;
      if ((event.target as Element | null)?.closest?.(".lx-md-block-controls")) return;
      clearTimeout(hideTimer.current);
      setTarget((current) => {
        if (besideItem(current, event.clientX, event.clientY)) return current;
        const next = targetAt(editor, event.clientX, event.clientY);
        return current?.element === next?.element && current?.kind === next?.kind ? current : next;
      });
    };
    const onLeave = () => {
      if (drag.current) return;
      hideTimer.current = setTimeout(() => setTarget(null), 200);
    };
    layer.addEventListener("mousemove", onMove);
    layer.addEventListener("mouseleave", onLeave);
    return () => {
      layer.removeEventListener("mousemove", onMove);
      layer.removeEventListener("mouseleave", onLeave);
      clearTimeout(hideTimer.current);
    };
  }, [editor, layer]);

  // A document change can move or remove the hovered block; look again at the next pointer move.
  useEffect(() => {
    const reset = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged && !drag.current) setTarget(null);
    };
    editor.on("transaction", reset);
    return () => {
      editor.off("transaction", reset);
    };
  }, [editor]);

  if (!target || !layer || !target.element.isConnected) return null;
  const origin = layer.getBoundingClientRect();
  const rect = target.element.getBoundingClientRect();
  const firstLine = Math.min(rect.height, parseFloat(getComputedStyle(target.element).lineHeight) || 24);
  const top = rect.top - origin.top + Math.max(0, (firstLine - 24) / 2);
  // Controls sit before the block: on its left, or its right in right-to-left text.
  const rtl = isRtl(target.element);
  const left = (rtl ? rect.right : rect.left) - origin.left;

  const select = () => {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target.position)));
    editor.view.focus();
  };

  const startDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const line = document.createElement("div");
    line.className = "lx-md-drop-line";
    line.hidden = true;
    document.body.append(line);
    drag.current = { target, startY: event.clientY, ghost: null, line, drop: null };
    const move = (moveEvent: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      if (!current.ghost && Math.abs(moveEvent.clientY - current.startY) < 4) return;
      current.ghost ??= createGhost(current.target.element);
      current.ghost.style.transform = `translate(${moveEvent.clientX + 12}px, ${moveEvent.clientY - 8}px)`;
      current.drop = dropAt(editor, current.target, moveEvent.clientY, current.line);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      const current = drag.current;
      drag.current = null;
      current?.line.remove();
      current?.ghost?.remove();
      if (!current?.ghost) {
        select();
        return;
      }
      if (current.drop) moveBlockTo(editor.state, editor.view.dispatch, current.target.position, current.drop.position, current.drop.after);
      editor.view.focus();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const gripLabel = target.kind === "item" ? t`Select list item`
    : target.kind === "list" ? (target.listKind === "orderedList" ? t`Select numbered list` : target.listKind === "taskList" ? t`Select task list` : t`Select bulleted list`)
      : t`Select block`;
  return (
    <div className="lx-md-block-controls" data-kind={target.kind} data-direction={rtl ? "rtl" : undefined} style={{ top, left }} contentEditable={false}>
      {target.kind !== "item" && (
        <button type="button" className="lx-md-block-control" aria-label={t`Add block below`} title={t`Add block below`} onMouseDown={(event) => event.preventDefault()} onClick={() => addBlockBelow(editor, target.position)}>
          <Plus aria-hidden="true" />
        </button>
      )}
      <button type="button" className="lx-md-block-control is-grip" aria-label={gripLabel} title={gripLabel} onPointerDown={startDrag} onClick={(event) => event.preventDefault()}>
        <GripVertical aria-hidden="true" />
      </button>
    </div>
  );
}

/** A floating copy of the dragged block, set in the block's own type. */
function createGhost(element: HTMLElement): HTMLElement {
  const rect = element.getBoundingClientRect();
  const ghost = element.cloneNode(true) as HTMLElement;
  const style = getComputedStyle(element);
  ghost.classList.add("lx-md-drag-ghost");
  ghost.removeAttribute("id");
  ghost.style.width = `${rect.width}px`;
  ghost.style.color = style.color;
  // Every text block keeps the metrics it has in place (a list item's
  // paragraphs, a heading's size), whatever the scope outside the surface says.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a DOM selector
  const TEXT = "p, h1, h2, h3, h4, h5, h6, li, pre, code";
  const sources = [element, ...element.querySelectorAll<HTMLElement>(TEXT)];
  const copies = [ghost, ...ghost.querySelectorAll<HTMLElement>(TEXT)];
  sources.forEach((source, index) => {
    const copy = copies[index];
    if (!copy) return;
    const computed = source === element ? style : getComputedStyle(source);
    copy.style.fontSize = computed.fontSize;
    copy.style.lineHeight = computed.lineHeight;
    copy.style.fontFamily = computed.fontFamily;
    copy.style.fontWeight = computed.fontWeight;
  });
  // Wrap it in the editor's scopes so the block keeps its look outside the surface.
  const scope = document.createElement("div");
  scope.className = "lx-md-editor lx-md-drag-scope";
  const surface = document.createElement("div");
  surface.className = "lx-md-surface";
  surface.append(ghost);
  scope.append(surface);
  document.body.append(scope);
  return scope;
}

/**
 * The nearest drop boundary to `y` among the dragged block's siblings: other
 * top-level blocks, or the items of its own list and the gap at the list's
 * end. Draws the drop line there.
 */
function dropAt(editor: Editor, target: Target, y: number, line: HTMLElement): { position: number; after: boolean } | null {
  const { doc } = editor.state;
  const $at = doc.resolve(target.position);
  const parent = $at.parent;
  const parentStart = $at.start();
  const candidates: { position: number; element: HTMLElement }[] = [];
  let offset = parentStart;
  parent.forEach((child) => {
    const element = editor.view.nodeDOM(offset) as HTMLElement | null;
    if (element) candidates.push({ position: offset, element });
    offset += child.nodeSize;
  });
  let best: { position: number; after: boolean; edge: number } | null = null;
  const withinList = target.kind === "item";
  const listRect = withinList ? (editor.view.nodeDOM($at.before()) as HTMLElement | null)?.getBoundingClientRect() : null;
  // A list item drops within its list and the small gap at its end, not into the following prose.
  if (listRect && (y < listRect.top - 8 || y > listRect.bottom + 12)) {
    line.hidden = true;
    return null;
  }
  for (const candidate of candidates) {
    const rect = candidate.element.getBoundingClientRect();
    for (const [edge, after] of [[rect.top, false], [rect.bottom, true]] as const) {
      const distance = Math.abs(edge - y);
      if (!best || distance < Math.abs(best.edge - y)) best = { position: candidate.position, after, edge };
    }
  }
  if (!best) {
    line.hidden = true;
    return null;
  }
  const surfaceRect = editor.view.dom.getBoundingClientRect();
  const left = listRect ? listRect.left : surfaceRect.left + parseFloat(getComputedStyle(editor.view.dom).paddingLeft || "0");
  const right = listRect ? listRect.right : surfaceRect.right - parseFloat(getComputedStyle(editor.view.dom).paddingRight || "0");
  line.hidden = false;
  line.style.top = `${best.edge - 1}px`;
  line.style.left = `${left}px`;
  line.style.width = `${Math.max(0, right - left)}px`;
  return { position: best.position, after: best.after };
}
