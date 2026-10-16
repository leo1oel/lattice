import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, loadReleaseNotes, takeUpdatedFrom } from "./whats-new";

afterEach(() => localStorage.clear());

describe("what's new", () => {
  it("speaks up only on the first launch after an update", () => {
    expect(takeUpdatedFrom("0.8.0")).toBeNull();
    expect(takeUpdatedFrom("0.8.0")).toBeNull();
    expect(takeUpdatedFrom("0.10.0")).toBe("0.8.0");
    expect(takeUpdatedFrom("0.10.0")).toBeNull();
    // Going back to an older build is not an update.
    expect(takeUpdatedFrom("0.9.1")).toBeNull();
  });

  it("orders versions by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("lists the bundled notes up to the running version, newest first", async () => {
    const notes = await loadReleaseNotes("0.7.5");
    expect(notes.map((release) => release.version)).toEqual(["0.7.0"]);
    expect((await loadReleaseNotes("0.8.0")).map((release) => release.version).slice(0, 2)).toEqual(["0.8.0", "0.7.0"]);
  });
});
