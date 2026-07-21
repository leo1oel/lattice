import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPreCollabProjectRoot,
  isLatticeSharesPath,
  loadPreCollabProjectRoot,
  rememberPreCollabProjectRoot,
  resolvePreCollabProjectRoot,
} from "./collab-return";

describe("collab return project", () => {
  beforeEach(() => {
    clearPreCollabProjectRoot();
  });

  it("detects Lattice Shares paths", () => {
    expect(isLatticeSharesPath("/Users/me/Documents/Lattice Shares/LT-ABC")).toBe(true);
    expect(isLatticeSharesPath("/Users/me/papers/folder-1")).toBe(false);
  });

  it("remembers and loads a prior project root", () => {
    rememberPreCollabProjectRoot("/Users/me/papers/folder-1");
    expect(loadPreCollabProjectRoot()).toBe("/Users/me/papers/folder-1");
  });

  it("refuses to remember a Shares folder as the return target", () => {
    rememberPreCollabProjectRoot("/Users/me/Documents/Lattice Shares/LT-ABC");
    expect(loadPreCollabProjectRoot()).toBeNull();
  });

  it("falls back to the newest non-share recent project", () => {
    expect(resolvePreCollabProjectRoot(null, [
      "/Users/me/Documents/Lattice Shares/LT-ABC",
      "/Users/me/papers/folder-1",
      "/Users/me/papers/folder-2",
    ])).toBe("/Users/me/papers/folder-1");
  });
});
