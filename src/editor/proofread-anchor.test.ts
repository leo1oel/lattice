import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { proofreadAnchor, proofreadExtension, setProofreadAnchorEffect } from "./proofread-anchor";

const handlers = { request: () => false, accept: () => false, dismiss: () => false };

function anchored(doc: string, from: number, to: number) {
  const host = document.createElement("div");
  const state = EditorState.create({ doc, extensions: proofreadExtension(handlers) });
  return { host, state: state.update({ effects: setProofreadAnchorEffect.of({ from, to, host }) }).state };
}

describe("proofread anchor", () => {
  it("keeps edits at either edge outside the span the card replaces", () => {
    const { host, state } = anchored("one two three", 4, 7);
    const edited = state.update({ changes: [{ from: 4, insert: "[" }, { from: 7, insert: "]" }] }).state;
    expect(edited.sliceDoc(proofreadAnchor(edited)!.from, proofreadAnchor(edited)!.to)).toBe("two");
    expect(proofreadAnchor(edited)!.host).toBe(host);
  });

  it("follows the span through edits before it and collapses when it is deleted", () => {
    const { state } = anchored("one two three", 4, 7);
    const shifted = state.update({ changes: { from: 0, insert: "zero " } }).state;
    expect(proofreadAnchor(shifted)).toMatchObject({ from: 9, to: 12 });
    const deleted = shifted.update({ changes: { from: 8, to: 13 } }).state;
    const anchor = proofreadAnchor(deleted)!;
    expect(anchor.to).toBeGreaterThanOrEqual(anchor.from);
  });

  it("clears with a null effect", () => {
    const { state } = anchored("one two three", 4, 7);
    expect(proofreadAnchor(state.update({ effects: setProofreadAnchorEffect.of(null) }).state)).toBeNull();
    expect(proofreadAnchor(EditorState.create({ doc: "x" }))).toBeNull();
  });
});
