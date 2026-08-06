import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collabCommentsContent,
  collabCommentsMap,
  readCollabComments,
  seedCollabCommentsFromContent,
  writeCollabComments,
} from "./collab-comments";
import { serializeEditorComments, type EditorComment } from "./editor-comment-data";

function comment(id: string, body: string, createdAt = "2026-01-01T00:00:00.000Z"): EditorComment {
  return {
    id,
    path: "main.tex",
    from: 0,
    to: 4,
    quote: "text",
    prefix: "",
    suffix: "",
    body,
    authorId: `author-${id}`,
    authorName: "Ada",
    resolved: false,
    replies: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/** Exchange updates both ways, the way two connected peers converge. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("shared editor comments", () => {
  it("keeps both peers' comments when they add at the same time", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const first = comment("a1", "from A", "2026-01-01T00:00:00.000Z");
    const second = comment("b1", "from B", "2026-01-01T00:00:01.000Z");

    // Neither has seen the other's yet — this is exactly the case a
    // whole-document publish lost, because each wrote only its own list.
    writeCollabComments(a, [first], []);
    writeCollabComments(b, [second], []);
    sync(a, b);

    expect(readCollabComments(a).map((item) => item.body)).toEqual(["from A", "from B"]);
    expect(readCollabComments(b).map((item) => item.body)).toEqual(["from A", "from B"]);
  });

  it("propagates a delete instead of resurrecting it on the next merge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const one = comment("a1", "keep");
    const two = comment("a2", "remove", "2026-01-01T00:00:01.000Z");
    writeCollabComments(a, [one, two], []);
    sync(a, b);
    expect(readCollabComments(b)).toHaveLength(2);

    writeCollabComments(a, [one], [one, two]);
    sync(a, b);
    expect(readCollabComments(b).map((item) => item.id)).toEqual(["a1"]);

    // B writing its own view afterwards must not bring the deleted one back.
    writeCollabComments(b, readCollabComments(b), readCollabComments(b));
    sync(a, b);
    expect(readCollabComments(a).map((item) => item.id)).toEqual(["a1"]);
  });

  it("never deletes a comment this client had not seen", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const mine = comment("a1", "mine");
    writeCollabComments(a, [mine], []);
    sync(a, b);

    // B adds one; A edits its own list without knowing about it yet.
    writeCollabComments(b, [...readCollabComments(b), comment("b1", "theirs", "2026-01-01T00:00:02.000Z")], readCollabComments(b));
    writeCollabComments(a, [{ ...mine, body: "mine edited" }], [mine]);
    sync(a, b);

    expect(readCollabComments(a).map((item) => item.body)).toEqual(["mine edited", "theirs"]);
  });

  it("adopts a room whose comments predate the map exactly once", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, serializeEditorComments([comment("legacy", "old")]));

    expect(seedCollabCommentsFromContent(doc)).toBe(true);
    expect(readCollabComments(doc).map((item) => item.id)).toEqual(["legacy"]);
    // Already imported: a second peer attaching must not re-add what was deleted.
    expect(seedCollabCommentsFromContent(doc)).toBe(false);

    writeCollabComments(doc, [], readCollabComments(doc));
    expect(seedCollabCommentsFromContent(doc)).toBe(false);
    expect(readCollabComments(doc)).toEqual([]);
  });

  it("serializes the workspace file from the map, not the empty content text", () => {
    const doc = new Y.Doc();
    writeCollabComments(doc, [comment("a1", "body")], []);
    expect(doc.getText("content").toString()).toBe("");
    expect(collabCommentsContent(doc)).toBe(serializeEditorComments([comment("a1", "body")]));
  });

  it("ignores malformed entries a peer wrote", () => {
    const doc = new Y.Doc();
    writeCollabComments(doc, [comment("a1", "ok")], []);
    collabCommentsMap(doc).set("junk", { id: "junk" } as unknown as EditorComment);
    expect(readCollabComments(doc).map((item) => item.id)).toEqual(["a1"]);
  });
});
