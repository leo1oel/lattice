import { describe, expect, it } from "vitest";
import { peerInitials, readCollabPeers } from "./collab-session";

describe("readCollabPeers", () => {
  it("lists everyone but us, in a stable order", () => {
    const states = new Map<number, unknown>([
      [7, { user: { name: "Zoe", color: "#f00" }, path: "main.tex" }],
      [1, { user: { name: "Alex", color: "#0f0" }, path: "intro.tex" }],
      [3, { user: { name: "Me", color: "#00f" }, path: "main.tex" }],
    ]);
    const peers = readCollabPeers(states, 3);
    expect(peers.map((peer) => peer.name)).toEqual(["Alex", "Zoe"]);
    expect(peers[0]).toEqual({ clientId: 1, name: "Alex", color: "#0f0", path: "intro.tex" });
  });

  it("survives a peer on an older build that announces nothing useful", () => {
    // Awareness records come from other clients, so nothing here is guaranteed.
    const states = new Map<number, unknown>([
      [3, { user: { name: "   " }, instanceId: "i3" }],
      [4, { user: { name: "Ada" }, path: 42 }],
    ]);
    const peers = readCollabPeers(states, 99);
    expect(peers).toHaveLength(2);
    expect(peers.map((peer) => peer.name)).toEqual(["Anonymous", "Ada"]);
    expect(peers.every((peer) => typeof peer.color === "string" && peer.color)).toBe(true);
    expect(peers[1].path).toBeNull();
  });

  it("ignores connections that never announced anyone", () => {
    // Awareness publishes `{}` for a client the moment it is constructed, and a
    // document opened only to mirror it to disk never announces over that. Each
    // such state used to render as its own "Anonymous" collaborator.
    const states = new Map<number, unknown>([
      [1, null],
      [2, {}],
      [5, { path: "main.tex" }],
      [6, { user: {} }],
      [7, { user: { name: "Ada" }, instanceId: "i7" }],
    ]);
    expect(readCollabPeers(states, 99).map((peer) => peer.name)).toEqual(["Ada"]);
  });
});

describe("peerInitials", () => {
  it("uses first and last initials for a full name", () => {
    expect(peerInitials("Ada Lovelace")).toBe("AL");
    expect(peerInitials("Jean Luc Picard")).toBe("JP");
  });

  it("takes two letters from a single word", () => {
    expect(peerInitials("robin")).toBe("RO");
  });

  it("never renders empty", () => {
    expect(peerInitials("   ")).toBe("?");
  });
});
