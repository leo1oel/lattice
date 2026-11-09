import { describe, expect, it } from "vitest";
import { createStallHold } from "./stalled-build";

describe("automatic builds after a stall", () => {
  it("wait for the inputs to change, and resume after any other result", () => {
    const hold = createStallHold();
    hold.note([{ code: "build-stalled" }], 3);
    expect(hold.holds(3)).toBe(true);
    expect(hold.holds(4)).toBe(false);
    hold.note([{ code: "other" }], 3);
    expect(hold.holds(3)).toBe(false);
  });
});
