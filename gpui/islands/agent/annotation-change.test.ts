/**
 * What the Agent page sends the window's store for a change its revision
 * rounds made (`annotation-change.ts`): only what the change touched, so a
 * note another writer added meanwhile survives the store applying it.
 *
 *   pnpm vitest run --config gpui/islands/vitest.config.ts
 */
import { describe, expect, it } from "vitest";
import type { AnnotationsState } from "../../../src/app/use-editor-comments";
import { annotationsChange } from "./annotation-change";

type Annotation = AnnotationsState["annotations"][number];

function note(id: string, body: string): Annotation {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    path: "main.tex",
    from: 0,
    to: 5,
    quote: "Hello",
    prefix: "",
    suffix: " world",
    body,
    authorId: "me",
    authorName: "Me",
    resolved: false,
    replies: [],
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
  };
}

const first = note("a1", "Tighten this.");
const second = note("a2", "Cite the survey.");
const roundOne = { number: 1, startedAt: "2026-11-14T10:05:00.000Z", outcomes: { a1: "proposed" as const } };

const view: AnnotationsState = { annotations: [first, second], rounds: [roundOne] };

describe("annotationsChange", () => {
  it("is null when nothing changed, even when the notes are new copies", () => {
    expect(annotationsChange(view, view)).toBeNull();
    const copied: AnnotationsState = {
      annotations: [{ ...first, replies: [] }, { ...second, replies: [] }],
      rounds: [{ ...roundOne, outcomes: { a1: "proposed" } }],
    };
    expect(annotationsChange(view, copied)).toBeNull();
  });

  it("upserts an edited note and only that note", () => {
    const edited = { ...first, body: "Tighten this sentence.", updatedAt: "2026-11-14T10:10:00.000Z" };
    expect(annotationsChange(view, { ...view, annotations: [edited, second] })).toEqual({
      upsert: [edited],
      remove: [],
      roundsUpsert: [],
      roundsRemove: [],
    });
  });

  it("upserts a new note", () => {
    const added = note("a3", "Define the term.");
    expect(annotationsChange(view, { ...view, annotations: [first, second, added] })).toEqual({
      upsert: [added],
      remove: [],
      roundsUpsert: [],
      roundsRemove: [],
    });
  });

  it("lists a removed note by id", () => {
    expect(annotationsChange(view, { ...view, annotations: [first] })).toEqual({
      upsert: [],
      remove: ["a2"],
      roundsUpsert: [],
      roundsRemove: [],
    });
  });

  it("upserts a round started and a round settled", () => {
    const settled = { ...roundOne, settledAt: "2026-11-14T10:20:00.000Z", outcomes: { a1: "accepted" as const } };
    const started = { number: 2, startedAt: "2026-11-14T10:30:00.000Z", outcomes: {} };
    expect(annotationsChange(view, { ...view, rounds: [settled, started] })).toEqual({
      upsert: [],
      remove: [],
      roundsUpsert: [settled, started],
      roundsRemove: [],
    });
  });

  it("lists a removed round by number", () => {
    expect(annotationsChange(view, { ...view, rounds: [] })).toEqual({
      upsert: [],
      remove: [],
      roundsUpsert: [],
      roundsRemove: [1],
    });
  });

  it("neither removes nor upserts a note the page never saw", () => {
    // The store holds a3 too (written in the Annotations panel after the page
    // read the list); the page's view, before and after, never had it.
    const edited = { ...second, resolved: true };
    const change = annotationsChange(view, { ...view, annotations: [first, edited] });
    expect(change).toEqual({ upsert: [edited], remove: [], roundsUpsert: [], roundsRemove: [] });
    expect(change?.upsert.map((item) => item.id)).not.toContain("a3");
    expect(change?.remove).not.toContain("a3");
  });
});
