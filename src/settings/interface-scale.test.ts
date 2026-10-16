import { describe, expect, it } from "vitest";
import { interfaceScalePercent, nearestInterfaceStep, zoomedInterfaceScale } from "./interface-scale";

describe("interface size steps", () => {
  it("steps through the named sizes and holds at either end", () => {
    expect(zoomedInterfaceScale(1, "in")).toBe(1.1);
    expect(zoomedInterfaceScale(1.2, "in")).toBe(1.35);
    expect(zoomedInterfaceScale(1.35, "in")).toBe(1.35);
    expect(zoomedInterfaceScale(1, "out")).toBe(0.9);
    expect(zoomedInterfaceScale(0.9, "out")).toBe(0.9);
    expect(zoomedInterfaceScale(1.35, "reset")).toBe(1);
  });

  it("reads a stored size between steps as the nearest one", () => {
    expect(nearestInterfaceStep(1.04)).toBe(1);
    expect(nearestInterfaceStep(1.3)).toBe(1.35);
    expect(zoomedInterfaceScale(1.16, "in")).toBe(1.35);
    expect(interfaceScalePercent(1.35)).toBe("135%");
  });
});
