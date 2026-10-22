import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  buildPresenceCursorDecorations,
  buildTrackedChangeDecorations,
  buildTrackedChangeTooltipDom,
  measureCursorLabelPlacements,
  overleafCursorsExtension,
  overleafTrackChangesExtension,
  posForRowColumn,
  presenceCursorColor,
  setOverleafCursorsEffect,
  trackedChangeContext,
  trackedChangeRange,
  trackedChangesAtPosition,
  type PresenceCursor,
  type TrackedChangeTooltipActions,
} from "./overleaf-editor-extensions";
import type { TrackedChange } from "./use-overleaf-realtime";

const docOf = (text: string) => EditorState.create({ doc: text }).doc;
const mountView = (doc: string, extensions: Extension) =>
  new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions }) });

const cursor = (overrides: Partial<PresenceCursor> = {}): PresenceCursor => ({ name: "Ada Lovelace", hue: 200, row: 0, column: 0, ...overrides });

const change = (overrides: Partial<TrackedChange> = {}): TrackedChange => ({
  id: "c1", position: 6, text: "world", deletion: false, userId: "user-1", timestamp: "2026-07-01T10:00:00.000Z", hue: 200, ...overrides,
});

/** "quick " suggested away from "The quick brown fox", which now reads "The brown fox". */
const removedQuick = change({ id: "del", position: 4, text: "quick ", deletion: true });

const actions = (overrides: Partial<TrackedChangeTooltipActions> = {}): TrackedChangeTooltipActions => ({
  authorName: () => "Ada Lovelace", canAct: () => true, onAccept: vi.fn(), onReject: vi.fn(), ...overrides,
});

describe("presence colors", () => {
  it("keeps an exact cursor color and falls back to the provider hue", () => {
    expect(presenceCursorColor({ color: "#0E7490", hue: 188 })).toBe("#0E7490");
    expect(presenceCursorColor({ color: "invalid", hue: 188 })).toBe("hsl(188, 70%, 50%)");
  });
});

describe("posForRowColumn", () => {
  const doc = docOf("alpha\nbeta\ngamma");
  it.each([
    ["an interior line", 1, 2, doc.line(2).from + 2],
    ["a column past the end of its line", 0, 99, doc.line(1).to],
    ["a row past the end of the document", 99, 0, doc.line(3).from],
    ["a negative row or column", -1, -1, doc.line(1).from],
  ])("clamps %s", (_label, row, column, expected) => expect(posForRowColumn(doc, row, column)).toBe(expected));
});

describe("overleafCursorsExtension", () => {
  it("places one widget per cursor", () => {
    const doc = docOf("alpha\nbeta\ngamma");
    expect(buildPresenceCursorDecorations(doc, []).size).toBe(0);
    const positions: number[] = [];
    buildPresenceCursorDecorations(doc, [cursor({ row: 0, column: 1 }), cursor({ row: 2, name: "Grace Hopper" })])
      .between(0, doc.length, (from) => { positions.push(from); });
    expect(positions).toEqual([doc.line(1).from + 1, doc.line(3).from]);
  });

  it("starts empty and draws a caret, in its exact color, once the effect dispatches a roster", () => {
    const view = mountView("alpha\nbeta", overleafCursorsExtension());
    expect(view.dom.querySelector(".cm-overleaf-caret")).toBeNull();
    view.dispatch({ effects: setOverleafCursorsEffect.of([cursor({ row: 1, column: 1, color: "#0E7490" })]) });
    const label = view.dom.querySelector<HTMLElement>(".cm-overleaf-caret-label");
    expect(label?.textContent).toBe("Ada Lovelace");
    expect(label).toHaveStyle({ backgroundColor: "#0E7490" });
    view.destroy();
  });

  it("places a top-edge name label below its caret", async () => {
    const view = mountView("alpha\nbeta", overleafCursorsExtension({ getCursors: () => [cursor()] }));
    const caret = view.dom.querySelector<HTMLElement>(".cm-overleaf-caret")!;
    const label = view.dom.querySelector<HTMLElement>(".cm-overleaf-caret-label")!;
    view.scrollDOM.getBoundingClientRect = () => ({ top: 40 } as DOMRect);
    label.getBoundingClientRect = () => ({ height: 14 } as DOMRect);
    for (const [top, below] of [[50, true], [80, false]] as const) {
      caret.getBoundingClientRect = () => ({ top } as DOMRect);
      expect(measureCursorLabelPlacements(view)).toEqual([{ caret, below }]);
      view.scrollDOM.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(caret.classList.contains("cm-caret-label-below")).toBe(below);
    }
    view.destroy();
  });
});

describe("suggestion spans", () => {
  const doc = docOf("hello world");

  it("span exactly the suggested text (or nothing once stale or empty) and hit inside it, not at its exclusive end", () => {
    expect(trackedChangeRange(doc, change())).toEqual({ from: 6, to: 11 });
    expect(trackedChangeRange(docOf("hi"), change())).toBeNull();
    expect(trackedChangeRange(doc, change({ text: "" }))).toBeNull();
    expect([5, 6, 10, 11].map((pos) => trackedChangesAtPosition(doc, [change()], pos).length)).toEqual([0, 1, 1, 0]);
  });

  it("quote the suggestion with surrounding text", () => {
    expect(trackedChangeContext("the quick brown fox jumps", change({ position: 4, text: "quick" }), 3))
      .toEqual({ prefix: "he ", quote: "quick", suffix: " br" });
  });

  // Overleaf's model: a suggested deletion's text has left the document. It
  // is a point, and treating it as a span struck through and quoted whatever
  // came after it ("brown " below) instead of the removed "quick ".
  it("give a deletion the empty span at its point, hit only there, and quote the removed text", () => {
    const after = docOf("The brown fox");
    expect(trackedChangeRange(after, removedQuick)).toEqual({ from: 4, to: 4 });
    expect([3, 4, 5].map((pos) => trackedChangesAtPosition(after, [removedQuick], pos).length)).toEqual([0, 1, 0]);
    expect(trackedChangeContext("The brown fox", removedQuick, 4)).toEqual({ prefix: "The ", quote: "quick ", suffix: "brow" });
    // A deletion at the very end of the text still has a point to stand on.
    expect(trackedChangeRange(docOf("The "), removedQuick)).toEqual({ from: 4, to: 4 });
  });
});

describe("buildTrackedChangeDecorations", () => {
  const doc = docOf("hello world, now");

  it("marks an insertion and draws a deletion's removed text at its point, each in its author's hue, skipping one the text is too short for", () => {
    const marks = new Map<string, { from: number; to: number; className: string; style: string }>();
    const widgets: { from: number; to: number; dom: HTMLElement }[] = [];
    buildTrackedChangeDecorations(doc, [
      change({ id: "ins", position: 6, text: "world", hue: 120 }),
      change({ id: "del", position: 13, text: "goodbye ", deletion: true, hue: 0 }),
      change({ id: "stale", position: 999 }),
    ]).between(0, doc.length, (from, to, deco) => {
      const spec = deco.spec as { class?: string; attributes?: Record<string, string>; widget?: { toDOM: () => HTMLElement } };
      if (spec.widget) widgets.push({ from, to, dom: spec.widget.toDOM() });
      else marks.set(spec.attributes!["data-change-id"]!, { from, to, className: spec.class!, style: spec.attributes!.style! });
    });
    expect([...marks.keys()]).toEqual(["ins"]);
    const insertion = marks.get("ins")!;
    expect(insertion).toMatchObject({ from: 6, to: 11, className: "cm-tracked-change-insert" });
    expect(insertion.style).toContain("border-bottom");
    expect(insertion.style).not.toContain("line-through");
    expect(insertion.style).toContain("hsl(120");
    // The deletion covers none of the document's text ("now" stays plain).
    expect(widgets).toHaveLength(1);
    const [{ from, to, dom }] = widgets as [typeof widgets[number]];
    expect([from, to]).toEqual([13, 13]);
    expect(dom.className).toBe("cm-tracked-change-delete");
    expect(dom.textContent).toBe("goodbye ");
    expect(dom.dataset.changeId).toBe("del");
    expect(dom.getAttribute("style")).toContain("line-through");
    expect(dom.getAttribute("style")).toContain("hsl(0");
  });

  it("strikes through the removed words in the editor, not the words that follow them", () => {
    const view = mountView("The brown fox", overleafTrackChangesExtension({ ...actions(), getChanges: () => [removedQuick] }));
    expect(view.dom.querySelector(".cm-tracked-change-delete")?.textContent).toBe("quick ");
    expect(view.dom.querySelector(".cm-tracked-change-insert")).toBeNull();
    expect(view.state.doc.toString()).toBe("The brown fox");
    expect(view.contentDOM.textContent).toBe("The quick brown fox");
    view.destroy();
  });
});

describe("the suggestion hover card", () => {
  it("names the author, wires Accept/Reject to this one suggestion, and disables both when the account cannot act", () => {
    const target = change();
    const handlers = actions();
    const dom = buildTrackedChangeTooltipDom([target], handlers);
    expect(dom.querySelector(".cm-tracked-change-tooltip-author")?.textContent).toBe("Ada Lovelace");
    const [accept, reject] = dom.querySelectorAll("button");
    accept!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onAccept).toHaveBeenCalledWith(target);
    reject!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onReject).toHaveBeenCalledWith(target);
    // Permission is read live rather than baked in.
    const denied = buildTrackedChangeTooltipDom([target], actions({ canAct: () => false }));
    for (const button of denied.querySelectorAll("button")) expect(button).toBeDisabled();
  });
});

describe("extensions fed by a live getter", () => {
  it.each([
    ["presence carets", ".cm-overleaf-caret", (get) => overleafCursorsExtension({ getCursors: get as () => PresenceCursor[] }), cursor()],
    ["suggestions", ".cm-tracked-change-insert", (get) => overleafTrackChangesExtension({ ...actions(), getChanges: get as () => TrackedChange[] }), change()],
  ] as Array<[string, string, (get: () => unknown[]) => Extension, unknown]>)(
    "draw the getter's %s and re-read it after a reconfigure, instead of starting empty",
    (_label, selector, extension, item) => {
      let items = [item];
      const extensions = extension(() => items);
      const view = mountView("hello world", extensions);
      const reconfigure = () => view.setState(EditorState.create({ doc: "hello world", extensions }));
      expect(view.dom.querySelector(selector)).not.toBeNull();
      reconfigure();
      expect(view.dom.querySelector(selector)).not.toBeNull();
      items = [];
      reconfigure();
      expect(view.dom.querySelector(selector)).toBeNull();
      view.destroy();
    },
  );
});
