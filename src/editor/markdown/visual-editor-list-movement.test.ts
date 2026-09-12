import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { sharedExtensions } from "../../open-knowledge-core/extensions/shared";
import { MarkdownManager } from "../../open-knowledge-core/markdown";
import { moveBlockDown, moveBlockUp, moveListItems } from "./visual-editor-block-controls";

const schema = getSchema(sharedExtensions);
const manager = new MarkdownManager({ extensions: sharedExtensions });

function setup(markdown: string) {
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(manager.parse(markdown)), plugins: [history()] });
  const dispatch = (tr: Transaction) => { state = state.apply(tr); };
  const position = (text: string) => {
    let found = -1;
    state.doc.descendants((node, pos) => { if (node.isText && node.text === text) found = pos; });
    if (found < 0) throw new Error(`Missing text: ${text}`);
    return found;
  };
  return {
    get state() { return state; }, dispatch, position,
    select: (anchor: number, head = anchor) => dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head))),
    source: () => manager.serialize(state.doc.toJSON()).trimEnd(),
  };
}

describe("list item movement", () => {
  it("moves a task item instead of its whole list, preserves its cursor and undoes once", () => {
    const original = "Before\n\n- [ ] Alpha\n- [x] Bravo longer\n- [ ] Charlie\n\nAfter";
    const h = setup(original);
    h.select(h.position("Bravo longer") + 4);
    expect(moveBlockUp(h.state, h.dispatch)).toBe(true);
    expect(h.source()).toBe("Before\n\n- [x] Bravo longer\n- [ ] Alpha\n- [ ] Charlie\n\nAfter");
    expect(h.state.selection.from).toBe(h.position("Bravo longer") + 4);
    expect(undo(h.state, h.dispatch)).toBe(true);
    expect(h.source()).toBe(original);
  });

  it("moves a backwards multi-item selection down and renumbers from the authored start", () => {
    const h = setup("7. Alpha\n8. Bravo longer\n9. Charlie\n10. Delta");
    h.select(h.position("Bravo longer") + 5, h.position("Alpha") + 1);
    expect(moveBlockDown(h.state, h.dispatch)).toBe(true);
    expect(h.source()).toBe("7. Charlie\n8. Alpha\n9. Bravo longer\n10. Delta");
    expect(h.state.selection.anchor).toBe(h.position("Bravo longer") + 5);
    expect(h.state.selection.head).toBe(h.position("Alpha") + 1);
  });

  it("sorts nested siblings without moving their parent or crossing the list boundary", () => {
    const h = setup("- Parent\n  - Alpha\n  - Bravo longer\n- Other");
    h.select(h.position("Bravo longer"));
    expect(moveBlockUp(h.state, h.dispatch)).toBe(true);
    expect(h.source()).toBe("- Parent\n  - Bravo longer\n  - Alpha\n- Other");
    expect(moveBlockUp(h.state, h.dispatch)).toBe(false);
    expect(moveListItems(h.state, h.dispatch, h.position("Bravo longer"), h.position("Other"), true)).toBe(false);
  });

  it("drags the selected group, rejects a drop within itself, and keeps a node selection usable", () => {
    const h = setup("- Alpha\n- Bravo longer\n- Charlie\n- Delta");
    h.select(h.position("Alpha"), h.position("Bravo longer") + 5);
    expect(moveListItems(h.state, h.dispatch, h.position("Bravo longer"), h.position("Alpha"), false)).toBe(false);
    expect(moveListItems(h.state, h.dispatch, h.position("Bravo longer"), h.position("Delta"), true)).toBe(true);
    expect(h.source()).toBe("- Charlie\n- Delta\n- Alpha\n- Bravo longer");
    h.dispatch(h.state.tr.setSelection(NodeSelection.create(h.state.doc, h.position("Delta") - 2)));
    expect(moveBlockUp(h.state, h.dispatch)).toBe(true);
    expect(h.source()).toBe("- Delta\n- Charlie\n- Alpha\n- Bravo longer");
    expect(h.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("does not move the entire list at either edge or join different lists", () => {
    const h = setup("Before\n\n- Alpha\n- Bravo longer\n\nBetween\n\n- Charlie\n\nAfter");
    h.select(h.position("Alpha"));
    expect(moveBlockUp(h.state, h.dispatch)).toBe(false);
    expect(moveListItems(h.state, h.dispatch, h.position("Alpha"), h.position("Charlie"), false)).toBe(false);
    h.select(h.position("Bravo longer"));
    expect(moveBlockDown(h.state, h.dispatch)).toBe(false);
  });
});
