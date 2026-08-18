export type SidebarModeTier = 1 | 2 | 3 | 4;

export function resolveSidebarModeTier(options: {
  availableWidth: number;
  collapsedWidth: number;
  expandedWidth: number;
  tabCount: number;
  tabGap: number;
}): SidebarModeTier {
  const { availableWidth, collapsedWidth, expandedWidth, tabCount, tabGap } = options;
  if (tabCount <= 0) return 1;

  const collapsedGroupWidth = collapsedWidth * tabCount
    + tabGap * Math.max(0, tabCount - 1);
  const expansionStep = Math.max(0, expandedWidth - collapsedWidth);
  const expansionSlots = expansionStep === 0
    ? tabCount
    : Math.floor((availableWidth - collapsedGroupWidth + 0.01) / expansionStep);
  return Math.max(1, Math.min(4, expansionSlots + 1)) as SidebarModeTier;
}
