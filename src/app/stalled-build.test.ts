import { describe, expect, it } from "vitest";
import { automaticBuildWouldStall, noteBuildOutcome } from "./stalled-build";

describe("automatic builds after a stall", () => {
  it("wait for an edit, and resume after any other result", () => {
    noteBuildOutcome([{ code: "build-stalled" }], "text");
    expect(automaticBuildWouldStall("text")).toBe(true);
    expect(automaticBuildWouldStall("edited")).toBe(false);
    noteBuildOutcome([{ code: "other" }], "text");
    expect(automaticBuildWouldStall("text")).toBe(false);
  });
});
