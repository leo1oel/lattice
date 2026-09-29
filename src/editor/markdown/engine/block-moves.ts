/**
 * Moving blocks in the visual engine (spec R-FMT-15, R-FMT-16, R-BLK-19):
 * the block around the caret, or the selected list items, move one step up or
 * down, or to a dropped position. A list item moves among its siblings only:
 * never out of its list, never taking the whole list along at an edge, and
 * never joining two lists. A moved block keeps its bytes (the round-trip core
 * writes an unchanged node from its source) and stays selected when it was.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

type Dispatch = ((transaction: Transaction) => void) | undefined;

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/** The run of siblings to move: list items the selection touches, or the top-level block around it. */
type Group = { parent: PmNode; parentStart: number; first: number; last: number; depth: number };

function listItemDepth($position: ResolvedPos): number {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if (LIST_ITEMS.has($position.node(depth).type.name)) return depth;
  }
  return -1;
}

function selectedGroup(state: EditorState): Group | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    const $at = state.doc.resolve(selection.from);
    const index = $at.index();
    return { parent: $at.parent, parentStart: $at.start(), first: index, last: index, depth: $at.depth };
  }
  const itemDepth = listItemDepth(selection.$from);
  if (itemDepth > 0) {
    const listDepth = itemDepth - 1;
    const $from = selection.$from;
    const $to = selection.$to;
    // A selection that leaves the list moves nothing: lists never move whole at their edges.
    if ($to.depth < itemDepth || $to.node(listDepth) !== $from.node(listDepth)) return null;
    return { parent: $from.node(listDepth), parentStart: $from.start(listDepth), first: $from.index(listDepth), last: $to.index(listDepth), depth: listDepth };
  }
  const $from = selection.$from;
  if ($from.depth < 1) return null;
  const index = $from.index(0);
  return { parent: state.doc, parentStart: 0, first: index, last: index, depth: 0 };
}

const offsetOf = (parent: PmNode, index: number) => {
  let offset = 0;
  for (let child = 0; child < index; child += 1) offset += parent.child(child).nodeSize;
  return offset;
};

/**
 * Move children `first`…`last` of the parent at `parentStart` so they sit
 * before child `target` (or at the end when `target` is the child count),
 * keeping the selection on what moved.
 */
function moveChildren(state: EditorState, group: Group, target: number, selectMoved = false): Transaction | null {
  const { parent, parentStart, first, last } = group;
  if (target >= first && target <= last + 1) return null;
  const from = parentStart + offsetOf(parent, first);
  const to = parentStart + offsetOf(parent, last + 1);
  const moved = parent.slice(from - parentStart, to - parentStart).content;
  const transaction = state.tr.delete(from, to);
  const insertAt = target > last ? parentStart + offsetOf(parent, target) - (to - from) : parentStart + offsetOf(parent, target);
  transaction.insert(insertAt, moved);
  const selection = state.selection;
  if (selectMoved && first === last) {
    transaction.setSelection(NodeSelection.create(transaction.doc, insertAt));
  } else if (selection instanceof NodeSelection) {
    transaction.setSelection(NodeSelection.create(transaction.doc, insertAt + (selection.from - from)));
  } else {
    const shift = insertAt - from;
    const inside = (position: number) => position >= from && position <= to;
    const anchor = inside(selection.anchor) ? selection.anchor + shift : transaction.mapping.map(selection.anchor);
    const head = inside(selection.head) ? selection.head + shift : transaction.mapping.map(selection.head);
    transaction.setSelection(TextSelection.create(transaction.doc, anchor, head));
  }
  return transaction.scrollIntoView();
}

/** Move the current block (or the selected list items) one step up or down. */
export function moveBlock(state: EditorState, dispatch: Dispatch, direction: -1 | 1): boolean {
  const group = selectedGroup(state);
  if (!group) return false;
  const target = direction < 0 ? group.first - 1 : group.last + 2;
  if (target < 0 || target > group.parent.childCount) return false;
  const transaction = moveChildren(state, group, target);
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
}

export const moveBlockUp = (state: EditorState, dispatch: Dispatch) => moveBlock(state, dispatch, -1);
export const moveBlockDown = (state: EditorState, dispatch: Dispatch) => moveBlock(state, dispatch, 1);

/**
 * Move the block (or list item) at `position` so it sits before the sibling at
 * `targetPosition`, or after it when `after`. Both must share a parent: a
 * list item never leaves its list. When the selection spans several siblings
 * including this one (list items selected together), they all move.
 */
export function moveBlockTo(state: EditorState, dispatch: Dispatch, position: number, targetPosition: number, after: boolean): boolean {
  const $at = state.doc.resolve(position);
  const $target = state.doc.resolve(targetPosition);
  if ($at.parent !== $target.parent || $at.depth !== $target.depth) return false;
  const index = $at.index();
  const selected = selectedGroup(state);
  const group: Group = selected && selected.parent === $at.parent && selected.first <= index && index <= selected.last
    ? selected
    : { parent: $at.parent, parentStart: $at.start(), first: index, last: index, depth: $at.depth };
  const transaction = moveChildren(state, group, $target.index() + (after ? 1 : 0), true);
  if (!transaction) return false;
  dispatch?.(transaction);
  return true;
}
