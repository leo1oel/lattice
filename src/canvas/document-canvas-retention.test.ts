import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DocumentCanvas is not compiled by the React Compiler, so every closure it
 * creates while rendering captures that render's whole scope, and CodeMirror
 * keeps its extensions' closures alive for as long as the view lives. React
 * state that held an EditorView (or the Markdown preview element) strongly
 * therefore chained each replaced editor to its successor: new view →
 * extension closure → render scope → previous view → … Heap snapshots of a
 * long session showed every file switch retaining the previous editor with its
 * whole document. Such state must hold a WeakRef and deref at the point of use.
 */
describe("DocumentCanvas retention", () => {
  it("keeps replaceable editor views and elements out of strong React state", () => {
    const source = readFileSync(path.join(import.meta.dirname, "document-canvas.tsx"), "utf8");
    const stateTypes = [...source.matchAll(/useState<([^>]*(?:EditorView|HTML\w*Element)[^>]*)>/g)]
      .map((match) => match[1]);
    expect(stateTypes.length).toBeGreaterThan(0);
    expect(stateTypes.filter((type) => !type.startsWith("WeakRef<"))).toEqual([]);
  });
});
