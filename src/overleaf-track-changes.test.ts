import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  buildTrackedChangeDecorations,
  buildTrackedChangeTooltipDom,
  overleafTrackChangesExtension,
  setTrackedChangesEffect,
  trackedChangeContext,
  trackedChangeRange,
  trackedChangesAtPosition,
  type TrackedChangeTooltipActions,
} from "./overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";

function change(overrides: Partial<TrackedChange> = {}): TrackedChange {
  return {
    id: "c1",
    position: 6,
    text: "world",
    deletion: false,
    userId: "user-1",
    timestamp: "2026-07-01T10:00:00.000Z",
    hue: 200,
    ...overrides,
  };
}

function actions(overrides: Partial<TrackedChangeTooltipActions> = {}): TrackedChangeTooltipActions {
  return {
    authorName: () => "Ada Lovelace",
    canAct: () => true,
    onAccept: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
}

describe("trackedChangeRange", () => {
  const doc = EditorState.create({ doc: "hello world" }).doc;

  it("spans exactly the suggested text", () => {
    expect(trackedChangeRange(doc, change())).toEqual({ from: 6, to: 11 });
  });

  it("is null once the document is too short for the suggestion (stale until reload)", () => {
    const shortDoc = EditorState.create({ doc: "hi" }).doc;
    expect(trackedChangeRange(shortDoc, change())).toBeNull();
  });

  it("is null for an empty suggestion", () => {
    expect(trackedChangeRange(doc, change({ text: "" }))).toBeNull();
  });
});

describe("trackedChangeContext", () => {
  it("quotes the suggestion with surrounding text", () => {
    const context = trackedChangeContext("the quick brown fox jumps", change({ position: 4, text: "quick" }), 3);
    expect(context).toEqual({ prefix: "he ", quote: "quick", suffix: " br" });
  });
});

describe("buildTrackedChangeDecorations", () => {
  const doc = EditorState.create({ doc: "hello world, goodbye now" }).doc;

  it("marks an insertion and a deletion differently", () => {
    const decorations = buildTrackedChangeDecorations(doc, [
      change({ id: "ins", position: 6, text: "world", deletion: false, hue: 120 }),
      change({ id: "del", position: 13, text: "goodbye", deletion: true, hue: 0 }),
    ]);

    const seen: { id: string | null; className: string; style: string }[] = [];
    decorations.between(0, doc.length, (_from, _to, deco) => {
      const spec = deco.spec as { class?: string; attributes?: Record<string, string> };
      seen.push({
        id: spec.attributes?.["data-change-id"] ?? null,
        className: spec.class ?? "",
        style: spec.attributes?.style ?? "",
      });
    });

    const insertion = seen.find((item) => item.id === "ins")!;
    const deletion = seen.find((item) => item.id === "del")!;

    expect(insertion.className).toBe("cm-tracked-change-insert");
    expect(insertion.style).toContain("border-bottom");
    expect(insertion.style).not.toContain("line-through");

    expect(deletion.className).toBe("cm-tracked-change-delete");
    expect(deletion.style).toContain("line-through");
    expect(deletion.style).not.toContain("border-bottom");

    // Both are tinted with their own author's hue rather than a shared color.
    expect(insertion.style).toContain("hsl(120");
    expect(deletion.style).toContain("hsl(0");
  });

  it("skips a suggestion the current document is too short for", () => {
    const decorations = buildTrackedChangeDecorations(doc, [change({ position: 999 })]);
    expect(decorations.size).toBe(0);
  });
});

describe("trackedChangesAtPosition", () => {
  const doc = EditorState.create({ doc: "hello world" }).doc;
  const insertion = change({ id: "ins", position: 6, text: "world" });

  it("hits inside the span, not at its exclusive end", () => {
    expect(trackedChangesAtPosition(doc, [insertion], 6).map((c) => c.id)).toEqual(["ins"]);
    expect(trackedChangesAtPosition(doc, [insertion], 10).map((c) => c.id)).toEqual(["ins"]);
    expect(trackedChangesAtPosition(doc, [insertion], 11)).toEqual([]);
    expect(trackedChangesAtPosition(doc, [insertion], 5)).toEqual([]);
  });
});

describe("buildTrackedChangeTooltipDom", () => {
  it("names the author and wires Accept/Reject to this one suggestion", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const target = change();
    const dom = buildTrackedChangeTooltipDom([target], actions({ onAccept, onReject }));

    expect(dom.querySelector(".cm-tracked-change-tooltip-author")?.textContent).toBe("Ada Lovelace");
    const [acceptBtn, rejectBtn] = dom.querySelectorAll("button");
    acceptBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAccept).toHaveBeenCalledWith(target);
    rejectBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReject).toHaveBeenCalledWith(target);
  });

  it("disables both buttons when this account cannot act, read live rather than baked in", () => {
    const dom = buildTrackedChangeTooltipDom([change()], actions({ canAct: () => false }));
    for (const button of dom.querySelectorAll("button")) {
      expect(button).toBeDisabled();
    }
  });
});

describe("overleafTrackChangesExtension", () => {
  it("starts empty and draws a mark once the effect dispatches a suggestion", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "hello world", extensions: overleafTrackChangesExtension(actions()) }),
    });
    expect(view.dom.querySelector(".cm-tracked-change-insert")).toBeNull();

    view.dispatch({ effects: setTrackedChangesEffect.of([change()]) });
    expect(view.dom.querySelector(".cm-tracked-change-insert")).not.toBeNull();
    view.destroy();
  });

  it("re-reads a live getter after a reconfigure, instead of starting empty", () => {
    let changes: TrackedChange[] = [change()];
    const extensions = overleafTrackChangesExtension({ ...actions(), getChanges: () => changes });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "hello world", extensions }),
    });
    expect(view.dom.querySelector(".cm-tracked-change-insert")).not.toBeNull();

    changes = [];
    view.setState(EditorState.create({ doc: "hello world", extensions }));
    expect(view.dom.querySelector(".cm-tracked-change-insert")).toBeNull();
    view.destroy();
  });
});
