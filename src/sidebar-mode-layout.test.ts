import { describe, expect, it } from "vitest";
import { resolveSidebarModeTier } from "./sidebar-mode-layout";

const layout = {
  collapsedWidth: 29,
  expandedWidth: 85,
  tabCount: 3,
  tabGap: 8,
};

describe("resolveSidebarModeTier", () => {
  it.each([
    { availableWidth: 271, tier: 4 },
    { availableWidth: 270.5, tier: 3 },
    { availableWidth: 270, tier: 3 },
    { availableWidth: 215, tier: 3 },
    { availableWidth: 214, tier: 2 },
    { availableWidth: 159, tier: 2 },
    { availableWidth: 158, tier: 1 },
  ] as const)("uses tier $tier at $availableWidth px", ({ availableWidth, tier }) => {
    expect(resolveSidebarModeTier({ ...layout, availableWidth })).toBe(tier);
  });
});
