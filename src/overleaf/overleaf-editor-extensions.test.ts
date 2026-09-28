import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  buildPresenceCursorDecorations,
  buildTrackedChangeDecorations,
  buildTrackedChangeTooltipDom,
  hueFromColorHex,
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

const actions = (overrides: Partial<TrackedChangeTooltipActions> = {}): TrackedChangeTooltipActions => ({
  authorName: () => "Ada Lovelace", canAct: () => true, onAccept: vi.fn(), onReject: vi.fn(), ...overrides,
});

describe("presence colors", () => {
  it.each([["#ff0000", 0], ["#00ff00", 120], ["#0000ff", 240], ["#888888", 0], ["not-a-color", 210]])(
    "maps %s to hue %i, falling back for greys and malformed input",
    (hex, hue) => expect(hueFromColorHex(hex)).toBe(hue),
  );

  it("reads a bare hex, keeps an exact collaboration color, and falls back to the provider hue", () => {
    expect(hueFromColorHex("1971c2")).toBeCloseTo(209, 0);
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

  it("span exactly the suggested text, or nothing once stale or empty", () => {
    expect(trackedChangeRange(doc, change())).toEqual({ from: 6, to: 11 });
    expect(trackedChangeRange(docOf("hi"), change())).toBeNull();
    expect(trackedChangeRange(doc, change({ text: "" }))).toBeNull();
  });

  it("quote the suggestion with surrounding text", () => {
    expect(trackedChangeContext("the quick brown fox jumps", change({ position: 4, text: "quick" }), 3))
      .toEqual({ prefix: "he ", quote: "quick", suffix: " br" });
  });

  it("hit inside the span, not at its exclusive end", () => {
    const insertion = change({ id: "ins" });
    expect([5, 6, 10, 11].map((pos) => trackedChangesAtPosition(doc, [insertion], pos).length)).toEqual([0, 1, 1, 0]);
  });
});

describe("buildTrackedChangeDecorations", () => {
  const doc = docOf("hello world, goodbye now");

  it("marks an insertion and a deletion differently, each in its author's hue", () => {
    const seen = new Map<string, { className: string; style: string }>();
    buildTrackedChangeDecorations(doc, [
      change({ id: "ins", position: 6, text: "world", hue: 120 }),
      change({ id: "del", position: 13, text: "goodbye", deletion: true, hue: 0 }),
    ]).between(0, doc.length, (_from, _to, deco) => {
      const spec = deco.spec as { class: string; attributes: Record<string, string> };
      seen.set(spec.attributes["data-change-id"]!, { className: spec.class, style: spec.attributes.style! });
    });
    const insertion = seen.get("ins")!;
    const deletion = seen.get("del")!;
    expect(insertion.className).toBe("cm-tracked-change-insert");
    expect(insertion.style).toContain("border-bottom");
    expect(insertion.style).not.toContain("line-through");
    expect(insertion.style).toContain("hsl(120");
    expect(deletion.className).toBe("cm-tracked-change-delete");
    expect(deletion.style).toContain("line-through");
    expect(deletion.style).not.toContain("border-bottom");
    expect(deletion.style).toContain("hsl(0");
  });

  it("skips a suggestion the current document is too short for", () => {
    expect(buildTrackedChangeDecorations(doc, [change({ position: 999 })]).size).toBe(0);
  });
});

describe("the suggestion hover card", () => {
  it("names the author and wires Accept/Reject to this one suggestion", () => {
    const target = change();
    const handlers = actions();
    const dom = buildTrackedChangeTooltipDom([target], handlers);
    expect(dom.querySelector(".cm-tracked-change-tooltip-author")?.textContent).toBe("Ada Lovelace");
    const [accept, reject] = dom.querySelectorAll("button");
    accept!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onAccept).toHaveBeenCalledWith(target);
    reject!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onReject).toHaveBeenCalledWith(target);
  });

  it("disables both buttons when this account cannot act, read live rather than baked in", () => {
    const dom = buildTrackedChangeTooltipDom([change()], actions({ canAct: () => false }));
    for (const button of dom.querySelectorAll("button")) expect(button).toBeDisabled();
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
