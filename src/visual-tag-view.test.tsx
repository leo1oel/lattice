/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original file: packages/app/src/editor/components/TagView.test.tsx.
 * Licensed under GPL-3.0-or-later.
 *
 * VisualTagView — structural unit tests via `renderToString`.
 *
 * Interactive concerns (auto-focus on mount, keystroke filtering,
 * Enter/Escape/blur commit) require a live editor + DOM. The unit-level
 * structural tests here pin three contracts:
 *
 *   1. Filled atom renders the same `<a class="tag" data-tag="…">` shape
 *      core's `renderHTML` emits — so `a[data-tag]` click handling and
 *      the `.tag` CSS keep working on the live pill.
 *   2. Empty atom renders a placeholder pill carrying an inline `<input>`
 *      (so the user can type into it without a separate popover surface)
 *      and the `tag-placeholder` class (so CSS can style the dashed-
 *      border state).
 *   3. Empty atom does NOT carry `data-tag` (so click handling doesn't
 *      fire over an unfilled pill — the inline input handles its own
 *      focus / commit lifecycle).
 */

import type { NodeViewProps } from "@tiptap/react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { VisualTagView } from "./visual-tag-view";

/**
 * Minimal `NodeViewProps` stub for static-render tests. Most fields are
 * never read in the SSR path (they're touched by the input's onChange /
 * onKeyDown handlers, which `renderToString` doesn't drive). The cast
 * is structural — production calls always have a real editor + getPos.
 */
function makeProps(value: string): NodeViewProps {
  const node = {
    attrs: { value },
    type: { name: "tag" },
  } as unknown as NodeViewProps["node"];
  return {
    node,
    selected: false,
    getPos: () => 0,
    editor: {} as NodeViewProps["editor"],
    decorations: [],
    extension: {} as NodeViewProps["extension"],
    HTMLAttributes: {},
    innerDecorations: [],
    updateAttributes: () => {},
    deleteNode: () => {},
    view: {} as NodeViewProps["view"],
  } as unknown as NodeViewProps;
}

describe("VisualTagView — filled chip", () => {
  test('renders `<a class="tag" data-tag="…" href="#tag/…">#value</a>`', () => {
    const html = renderToString(<VisualTagView {...makeProps("typescript")} />);
    expect(html).toContain('class="tag"');
    expect(html).toContain('data-tag="typescript"');
    expect(html).toContain('href="#tag/typescript"');
    // React's server renderer inserts a `<!-- -->` comment between the
    // literal `#` text and the `{value}` expression so the client can
    // hydrate the two text nodes correctly. Match the value separately.
    expect(html).toContain("typescript</a>");
  });

  test("hierarchy value preserves the slash in data-tag and href", () => {
    const html = renderToString(<VisualTagView {...makeProps("proj/team/2026")} />);
    expect(html).toContain('data-tag="proj/team/2026"');
    expect(html).toContain('href="#tag/proj/team/2026"');
    expect(html).toContain("proj/team/2026</a>");
  });

  test("filled chip does NOT render an input element", () => {
    // Pin the read/write split — once the atom has a value, the
    // placeholder input is gone and the chip is just an anchor. A
    // future refactor that accidentally rendered the input on filled
    // atoms would steal focus when the user navigates near the chip.
    const html = renderToString(<VisualTagView {...makeProps("typescript")} />);
    expect(html).not.toContain("<input");
  });
});

describe("VisualTagView — empty placeholder", () => {
  test("empty value renders the placeholder pill with `tag-placeholder` class", () => {
    const html = renderToString(<VisualTagView {...makeProps("")} />);
    expect(html).toContain("tag-placeholder");
  });

  test("placeholder embeds an `<input>` (inline-edit, no separate popover)", () => {
    const html = renderToString(<VisualTagView {...makeProps("")} />);
    // The inline input is the load-bearing edit surface — pin its
    // presence so a regression that drops it (and falls back to the
    // old popover-panel UX) fails this test.
    expect(html).toContain("<input");
    expect(html).toContain('aria-label="Tag value"');
  });

  test("placeholder does NOT carry `data-tag` (so click handling skips it)", () => {
    const html = renderToString(<VisualTagView {...makeProps("")} />);
    // The filled chip carries `data-tag="…"`; the placeholder must not,
    // so `a[data-tag]` selectors don't fire over an unfilled pill.
    expect(html).not.toContain("data-tag=");
  });
});

describe("VisualTagView — wrapper invariant", () => {
  test("NodeViewWrapper renders as a span (inline-flow safe)", () => {
    // Atom is `inline: true` in core schema; wrapping in <div> would
    // break paragraph's `inline*` content expression and crash the
    // editor on remount. The `as="span"` prop on NodeViewWrapper is
    // load-bearing — pin it here so a future refactor that changes
    // the wrapper element fails this test rather than the editor.
    const html = renderToString(<VisualTagView {...makeProps("foo")} />);
    expect(html.startsWith("<span")).toBe(true);
  });
});
