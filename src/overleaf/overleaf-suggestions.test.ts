/**
 * Suggestions riding along with the text: a suggested deletion is a point
 * (its text has left the document), a suggested insertion is a span, and an
 * edit sent as a suggestion adds to them the way Overleaf's review panel
 * shows it.
 */
import { describe, expect, it } from "vitest";
import { applyOps, type OtOp } from "./ot";
import { anchorsAfter, type TrackedChange } from "./overleaf-realtime-model";
import { changesAfter, isProvisional, type Suggester } from "./overleaf-suggestions";

const ada: Suggester = { userId: "ada", hue: 30 };
const grace: Suggester = { userId: "grace", hue: 250 };

const insertion = (position: number, text: string, by = grace, id = "ins"): TrackedChange =>
  ({ id, position, text, deletion: false, userId: by.userId, timestamp: null, hue: by.hue });
const deletion = (position: number, text: string, by = grace, id = "del"): TrackedChange =>
  ({ id, position, text, deletion: true, userId: by.userId, timestamp: null, hue: by.hue });

/** What review shows for `changes`: each one's kind, where it sits and its text. */
const shown = (changes: TrackedChange[]) => changes
  .map((change) => `${change.deletion ? "-" : "+"}${change.position}:${change.text}`)
  .sort();

/** Apply `ops` to `text` as suggestions from `by` (or as ordinary edits), checking each suggested insertion still spans its text. */
function edit(text: string, changes: TrackedChange[], ops: OtOp[], by: Suggester | null) {
  const after = applyOps(text, ops)!;
  const next = changesAfter(changes, ops, by, "2026-10-22T00:00:00.000Z");
  for (const change of next) {
    if (!change.deletion) expect(after.slice(change.position, change.position + change.text.length)).toBe(change.text);
  }
  return { text: after, changes: next };
}

describe("ordinary edits", () => {
  const removed = deletion(4, "quick ");

  it("keep a suggested deletion as a point: text after it moves nothing, text before moves it", () => {
    // "The brown fox", with "quick " suggested away at 4.
    expect(shown(edit("The brown fox", [removed], [{ p: 4, d: "brown " }], null).changes)).toEqual(["-4:quick "]);
    expect(shown(edit("The brown fox", [removed], [{ p: 10, i: "red " }], null).changes)).toEqual(["-4:quick "]);
    expect(shown(edit("The brown fox", [removed], [{ p: 0, i: "See: " }], null).changes)).toEqual(["-9:quick "]);
    expect(shown(edit("The brown fox", [removed], [{ p: 0, d: "The " }], null).changes)).toEqual(["-0:quick "]);
  });

  it("never drop a suggested deletion when the text around it goes, nor put typing at its point inside it", () => {
    // Used to read as a five-character span that "lost" its text and vanished
    // here while the suggestion still stood on Overleaf.
    expect(shown(edit("The brown fox", [removed], [{ p: 2, d: "e brown" }], null).changes)).toEqual(["-2:quick "]);
    // Typed at the point it follows the removed text, as a replacement reads.
    expect(shown(edit("The brown fox", [removed], [{ p: 4, i: "fast " }], null).changes)).toEqual(["-4:quick "]);
  });

  it("keep a suggested insertion's text in step with what is left of it, and drop it once it is all gone", () => {
    const added = insertion(4, "quick ");
    expect(shown(edit("The quick brown fox", [added], [{ p: 6, d: "ic" }], null).changes)).toEqual(["+4:quk "]);
    expect(shown(edit("The quick brown fox", [added], [{ p: 2, d: "e qu" }], null).changes)).toEqual(["+2:ick "]);
    expect(shown(edit("The quick brown fox", [added], [{ p: 6, i: "XX" }], null).changes)).toEqual(["+4:quXXick "]);
    // Typing at either edge stays outside it.
    expect(shown(edit("The quick brown fox", [added], [{ p: 4, i: "a " }], null).changes)).toEqual(["+6:quick "]);
    expect(shown(edit("The quick brown fox", [added], [{ p: 10, i: "a " }], null).changes)).toEqual(["+4:quick "]);
    expect(edit("The quick brown fox", [added], [{ p: 3, d: " quick b" }], null).changes).toEqual([]);
  });

  it("move comments as before and leave the changes they did not touch as they were", () => {
    const untouched = insertion(10, "brown");
    const moved = anchorsAfter(
      { id: "doc", comments: [{ threadId: "t", position: 16, quote: "fox" }], changes: [untouched, removed] },
      [{ p: 19, i: "!" }],
    );
    expect(moved.comments[0]!.position).toBe(16);
    expect(moved.changes[0]).toBe(untouched);
  });
});

describe("edits sent as suggestions", () => {
  it("record removed text as a deletion at its point: the report's 'quick ' case", () => {
    const { text, changes } = edit("The quick brown fox", [], [{ p: 4, d: "quick " }], ada);
    expect(text).toBe("The brown fox");
    expect(changes).toEqual([expect.objectContaining({ position: 4, text: "quick ", deletion: true, userId: "ada", hue: 30 })]);
    expect(isProvisional(changes[0]!)).toBe(true);
  });

  it("record typed text as an insertion, and extend the suggester's own insertion rather than start another", () => {
    let state = edit("The fox", [], [{ p: 4, i: "qu" }], ada);
    expect(shown(state.changes)).toEqual(["+4:qu"]);
    state = edit(state.text, state.changes, [{ p: 6, i: "ick " }], ada);
    expect(shown(state.changes)).toEqual(["+4:quick "]);
    // Someone else typing at its edge starts their own.
    state = edit(state.text, state.changes, [{ p: 10, i: "brown " }], grace);
    expect(shown(state.changes)).toEqual(["+10:brown ", "+4:quick "]);
  });

  it("split someone else's insertion around a suggestion typed inside it", () => {
    const { changes } = edit("The quick fox", [insertion(4, "quick ")], [{ p: 6, i: "ZZ" }], ada);
    expect(shown(changes)).toEqual(["+4:qu", "+6:ZZ", "+8:ick "]);
    expect(changes.find((change) => change.text === "ick ")?.userId).toBe("grace");
  });

  it("withdraw suggested text that is deleted again, rather than suggesting its removal", () => {
    const { text, changes } = edit("The quick brown fox", [insertion(4, "quick ", ada)], [{ p: 2, d: "e quick b" }], ada);
    expect(text).toBe("Thrown fox");
    // Only the text that was really in the document becomes a deletion.
    expect(shown(changes)).toEqual(["-2:e b"]);
  });

  it("read backspacing and forward-deleting through a word as one deletion, in the word's own order", () => {
    let state = { text: "The quick brown fox", changes: [] as TrackedChange[] };
    for (const op of [{ p: 8, d: "k" }, { p: 7, d: "c" }, { p: 4, d: "qui" }]) state = edit(state.text, state.changes, [op], ada);
    expect(shown(state.changes)).toEqual(["-4:quick"]);
    for (const op of [{ p: 4, d: " " }, { p: 4, d: "brown" }]) state = edit(state.text, state.changes, [op], ada);
    expect(shown(state.changes)).toEqual(["-4:quick brown"]);
  });

  it("keep another suggester's deletion separate when a deletion reaches it", () => {
    const { changes } = edit("The brown fox", [deletion(4, "quick ")], [{ p: 3, d: " brown" }], ada);
    expect(shown(changes)).toEqual(["-3: brown", "-3:quick "]);
    expect(changes.find((change) => change.text === "quick ")?.id).toBe("del");
  });

  it("apply each op of a composed operation to the text the previous one left", () => {
    const { text, changes } = edit("abcdef", [], [{ p: 1, i: "XY" }, { p: 5, d: "de" }], ada);
    expect(text).toBe("aXYbcf");
    expect(shown(changes)).toEqual(["+1:XY", "-5:de"]);
  });
});
