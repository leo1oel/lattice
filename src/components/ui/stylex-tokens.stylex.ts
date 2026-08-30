import * as stylex from "@stylexjs/stylex";

/**
 * Bridge the existing semantic CSS-variable contract into typed StyleX values.
 *
 * `defineConsts` inlines these references at build time, so the current theme
 * remains the source of truth and the PoC does not introduce a second runtime
 * theme provider or duplicate light/dark values.
 */
export const uiTokens = stylex.defineConsts({
  badgeHeight: "var(--badge-height)",
  badgeHeightCompact: "var(--badge-height-compact)",
  borderSubtle: "var(--border-subtle)",
  controlActive: "var(--control-active)",
  controlActiveSoft: "var(--control-active-soft)",
  controlDisabledOpacity: "var(--control-disabled-opacity)",
  controlHeightSwitch: "var(--control-height-switch)",
  controlOffSurface: "var(--control-off-surface)",
  controlOnSurface: "var(--control-on-surface)",
  controlSizeSwitchThumb: "var(--control-size-switch-thumb)",
  controlThumbSurface: "var(--control-thumb-surface)",
  controlWidthSwitch: "var(--control-width-switch)",
  radiusIcon: "var(--radius-icon)",
  radiusPill: "var(--radius-pill)",
  space1: "var(--space-1)",
  space2: "var(--space-2)",
  space3: "var(--space-3)",
  statusDanger: "var(--status-danger)",
  statusDangerSoft: "var(--status-danger-soft)",
  statusInfo: "var(--status-info)",
  statusSuccess: "var(--status-success)",
  statusSuccessSoft: "var(--status-success-soft)",
  statusWarning: "var(--status-warning)",
  statusWarningSoft: "var(--status-warning-soft)",
  switchTransitionDuration: "var(--duration-base), var(--duration-quick)",
  switchTransitionTiming: "var(--ease-default), var(--ease-default)",
  textPrimary: "var(--text-primary)",
  textSecondary: "var(--text-secondary)",
  typeCaptionLineHeight: "var(--type-caption-line-height)",
  typeCaptionSize: "var(--type-caption-size)",
  typeCaptionWeight: "var(--type-caption-weight)",
  typeMicroLineHeight: "var(--type-micro-line-height)",
  typeMicroSize: "var(--type-micro-size)",
  typeMicroWeight: "var(--type-micro-weight)",
});
