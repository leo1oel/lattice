import { describe, expect, it } from "vitest";
import { peerColorForKey, peerColorForName } from "./collab-colors";

describe("peer colors", () => {
  it("is stable for the same key", () => {
    expect(peerColorForKey("Ada")).toEqual(peerColorForKey("Ada"));
    expect(peerColorForName("Ada")).toEqual(peerColorForKey("Ada"));
  });

  it("gives different colors to different client identities", () => {
    const a = peerColorForKey("Anonymous\u00001");
    const b = peerColorForKey("Anonymous\u00002");
    expect(a.color).not.toEqual(b.color);
  });
});
