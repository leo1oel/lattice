import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createShareRoomCode,
  createShareToken,
  defaultCollabRoom,
  formatCollabInvite,
  maybeSeedCollabText,
  normalizeCollabHost,
  parseCollabInvite,
  peerColorForName,
} from "./collab-session";

describe("collab session helpers", () => {
  it("normalizes host urls to a host:port form", () => {
    expect(normalizeCollabHost("https://example.partykit.dev/")).toBe("example.partykit.dev");
    expect(normalizeCollabHost("ws://localhost:1999")).toBe("localhost:1999");
    expect(normalizeCollabHost("  localhost:1999  ")).toBe("localhost:1999");
  });

  it("builds a stable default room from project and file", () => {
    expect(defaultCollabRoom("paper-id", "sections/intro.tex")).toBe("paper-id/sections/intro.tex");
    expect(defaultCollabRoom("", "")).toBe("project/main.tex");
  });

  it("creates short share room codes", () => {
    const code = createShareRoomCode();
    expect(code).toMatch(/^LT-[A-Z0-9]{6}$/);
  });

  it("formats and parses lattice invites", () => {
    const invite = formatCollabInvite("https://demo.partykit.dev/", "LT-ABC123");
    expect(invite).toBe("lattice:demo.partykit.dev/LT-ABC123");
    expect(parseCollabInvite(`Join me\n${invite}\nthanks`)).toEqual({
      host: "demo.partykit.dev",
      room: "LT-ABC123",
      token: "",
    });
    expect(parseCollabInvite("LT-ZZ99KK")?.room).toBe("LT-ZZ99KK");
  });

  it("round-trips the room token through the invite", () => {
    const token = createShareToken();
    expect(token).toMatch(/^[A-Za-z0-9\-_]{24}$/);
    const invite = formatCollabInvite("demo.partykit.dev", "LT-ABC123", token);
    expect(invite).toBe(`lattice:demo.partykit.dev/LT-ABC123#${token}`);
    expect(parseCollabInvite(`Join me\n${invite}\nthanks`)).toEqual({
      host: "demo.partykit.dev",
      room: "LT-ABC123",
      token,
    });
  });

  it("seeds only empty shared text once", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("latex");
    expect(maybeSeedCollabText(ytext, "hello")).toBe(true);
    expect(ytext.toString()).toBe("hello");
    expect(maybeSeedCollabText(ytext, "other")).toBe(false);
    expect(ytext.toString()).toBe("hello");
    expect(maybeSeedCollabText(ytext, "")).toBe(false);
  });

  it("assigns a stable peer color from the display name", () => {
    expect(peerColorForName("Ada")).toEqual(peerColorForName("Ada"));
    expect(peerColorForName("Ada").color).toMatch(/^#/);
  });

  it("builds UndoManager on a doc-bound pending text, not a detached Y.Text", () => {
    const doc = new Y.Doc();
    const pending = doc.getText("__lattice_pending__");
    expect(() => new Y.UndoManager(pending)).not.toThrow();
    expect(() => new Y.UndoManager(new Y.Text())).toThrow(/null|undefined|doc/i);
  });
});
