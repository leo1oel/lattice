/**
 * The page's annotation tools' host (`annotation-tools.ts`): it finds by pin
 * number in the page's view and hands each call to the window as written,
 * recording nothing itself.
 *
 *   pnpm vitest run --config gpui/islands/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import type { AnnotationsState } from "../../../src/app/use-editor-comments";
import { annotationToolHost, type AnnotationToolCall } from "./annotation-tools";

const note = (id: string, number: number) => ({
  id, number, path: "main.tex", from: 0, to: 4, quote: "text", prefix: "", suffix: "", body: "note",
  authorId: "a", authorName: "A", resolved: false, replies: [], createdAt: "1", updatedAt: "1",
}) as unknown as AnnotationsState["annotations"][number];

describe("annotationToolHost", () => {
  const view: AnnotationsState = { annotations: [note("first", 1), note("second", 2)], rounds: [] };

  it("finds an annotation by its pin number, and none for a number nobody has", () => {
    const host = annotationToolHost(() => view, () => undefined);
    expect(host.find(2)?.id).toBe("second");
    expect(host.find(7)).toBeNull();
  });

  it("hands a proposal and a question to the window as the surface reads them", () => {
    const calls: AnnotationToolCall[] = [];
    const host = annotationToolHost(() => view, (call) => calls.push(call));
    host.propose(view.annotations[0], "the revised passage", "clearer");
    host.ask(view.annotations[1], "Which result?");
    expect(calls).toEqual([
      { annotationId: "first", action: "propose", text: "the revised passage", reason: "clearer" },
      { annotationId: "second", action: "ask", question: "Which result?" },
    ]);
    // Nothing of the page's view changed: the window records.
    expect(view.rounds).toEqual([]);
    expect(view.annotations.map((annotation) => annotation.revision)).toEqual([undefined, undefined]);
  });
});
