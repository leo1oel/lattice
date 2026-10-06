import type { Theme } from "../settings/app-settings";
import type { ThemeAccent, ThemeTint, Translucency } from "../settings/theme-customization";

/**
 * The host's theme, for the embedded agent to paint with. Synara's embed
 * still carries its own copy of the Graphite palette and only reads `theme`
 * from the frame URL; this message is the contract that replaces that copy.
 * Lattice posts it when the agent frame reports `synara:embed-ready`,
 * whenever any of it changes, and in answer to LATTICE_HOST_THEME_REQUEST.
 * An embed that predates it ignores it.
 */
export const LATTICE_HOST_THEME = "lattice:host-theme";
export const LATTICE_HOST_THEME_REQUEST = "lattice:request-host-theme";

/**
 * Each color is the host's resolved CSS color (`rgb()`, or `color(srgb …)`
 * for a translucent mix), ready to set as a custom property. The names
 * follow the roles Synara's `applyEmbedTheme` already fills.
 */
export interface AgentHostThemeColors {
  /** The agent panel's own surface (the `chrome` embed surface). */
  chrome: string;
  /** Right-hand drawers and the Settings dialog (the `drawer` embed surface). */
  drawer: string;
  /** Menus, popovers, the composer and code blocks. */
  elevated: string;
  foreground: string;
  muted: string;
  faint: string;
  border: string;
  strongBorder: string;
  accent: string;
  accentSoft: string;
  /** Text and icons on an accent fill. */
  accentContrast: string;
  focusRing: string;
  controlHover: string;
}

export interface AgentHostThemeSnapshot {
  type: typeof LATTICE_HOST_THEME;
  version: 1;
  theme: Theme;
  tint: ThemeTint;
  /** A preset name, or the custom color as `#rrggbb` (colors.accent is it fitted to the theme). */
  accent: ThemeAccent;
  /** What the writer chose, and whether vibrancy is behind the window now. The agent panel stays opaque either way. */
  translucency: Translucency;
  translucent: boolean;
  colors: AgentHostThemeColors;
}

const COLOR_ROLES: Record<keyof AgentHostThemeColors, string> = {
  chrome: "--surface-sidebar",
  drawer: "--surface-input",
  elevated: "--surface-panel-raised",
  foreground: "--text-primary",
  muted: "--text-secondary",
  faint: "--text-tertiary",
  border: "--border-subtle",
  strongBorder: "--border-strong",
  accent: "--control-active",
  accentSoft: "--control-active-soft",
  accentContrast: "--control-active-contrast",
  focusRing: "--focus-ring",
  controlHover: "--control-hover-surface",
};

/**
 * The snapshot for the theme the document shows now. Read after
 * use-appearance has applied it: the colors come from the live cascade, so
 * tints, accents (custom ones included) and future palette changes travel
 * without a second copy of the palette here.
 */
export function readAgentHostTheme(input: {
  theme: Theme;
  tint: ThemeTint;
  accent: ThemeAccent;
  translucency: Translucency;
  translucent: boolean;
}): AgentHostThemeSnapshot {
  // A custom property's computed value is its token text (`var(...)`,
  // `color-mix(...)`); a probe's `color` resolves it to a color.
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  const colors = Object.fromEntries(Object.entries(COLOR_ROLES).map(([role, token]) => {
    probe.style.color = `var(${token})`;
    return [role, getComputedStyle(probe).color];
  })) as unknown as AgentHostThemeColors;
  probe.remove();
  return { type: LATTICE_HOST_THEME, version: 1, ...input, colors };
}
