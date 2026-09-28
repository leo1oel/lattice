import { describe, expect, it } from "vitest";
import { peerColorForKey, peerColorForName, peerInitials } from "./collab-colors";

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

describe("peerInitials", () => {
  it.each([
    ["uses first and last initials for a full name", "Ada Lovelace", "AL"],
    ["uses first and last initials, skipping middle names", "Jean Luc Picard", "JP"],
    ["takes two letters from a single word", "robin", "RO"],
    ["never renders empty", "   ", "?"],
  ])("%s", (_name, name, initials) => {
    expect(peerInitials(name)).toBe(initials);
  });
});
