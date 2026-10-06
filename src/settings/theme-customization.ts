/**
 * The theme choices in Settings → Appearance beyond light and dark: a tint
 * for the surfaces, an accent, and how translucent the window is. The presets
 * themselves are palette blocks in styles/theme.css keyed by `data-tint` and
 * `data-accent`; this module names them, validates stored values, and fits a
 * custom accent to the same contrast floor as the presets.
 */

import type { Theme } from "./app-settings";

export const THEME_TINTS = ["graphite", "paper", "sage", "mist", "dusk"] as const;
export type ThemeTint = typeof THEME_TINTS[number];

export const ACCENT_PRESETS = ["graphite", "blue", "purple", "pink", "orange", "green", "teal"] as const;
export type AccentPreset = typeof ACCENT_PRESETS[number];
/** A preset, or a custom color as `#rrggbb`. */
export type ThemeAccent = AccentPreset | `#${string}`;

export const TRANSLUCENCY_LEVELS = ["off", "subtle", "strong"] as const;
export type Translucency = typeof TRANSLUCENCY_LEVELS[number];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isCustomAccent(accent: ThemeAccent): accent is `#${string}` {
  return accent.startsWith("#");
}

/** A stored accent, or undefined when it is neither a preset nor a hex color. */
export function normalizeAccent(value: unknown): ThemeAccent | undefined {
  if (typeof value !== "string") return undefined;
  if ((ACCENT_PRESETS as readonly string[]).includes(value)) return value as AccentPreset;
  return HEX_COLOR.test(value) ? value.toLowerCase() as `#${string}` : undefined;
}

type Rgb = [number, number, number];

const toLinear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const toGamma = (channel: number) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

function parseHex(hex: string): Rgb {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
}

function formatHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map(toLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function toOklch(rgb: Rgb): [number, number, number] {
  const [red, green, blue] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, b), Math.atan2(b, a)];
}

/** The sRGB color at an OKLCH point, or null outside the gamut. */
function fromOklch(lightness: number, chroma: number, hue: number): Rgb | null {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (linear.some((channel) => channel < -1e-4 || channel > 1 + 1e-4)) return null;
  return linear.map((channel) => toGamma(Math.min(1, Math.max(0, channel)))) as Rgb;
}

/**
 * The accent luminance each theme allows. The accent colors text on every
 * surface, so it must read at 4.6:1 (the presets' floor) on the surface
 * closest to it: Dusk's chrome (#f0edf7) in light, Mist's raised panel
 * (#1d2125) in dark. Each theme's --accent-contrast label then clears 5:1.
 */
const ACCENT_LUMINANCE_LIMIT: Record<Theme, (value: number) => boolean> = {
  light: (value) => (0.8581 + 0.05) / (value + 0.05) >= 4.6,
  dark: (value) => (value + 0.05) / (0.01483 + 0.05) >= 4.6,
};

/**
 * A custom accent as the theme can use it: the color itself when it already
 * reads on every surface, otherwise the nearest color with its hue that does,
 * found by moving lightness (and giving up chroma only where sRGB runs out).
 */
export function fitAccent(hex: string, theme: Theme): string {
  const rgb = parseHex(hex);
  const fits = ACCENT_LUMINANCE_LIMIT[theme];
  if (fits(luminance(rgb))) return formatHex(rgb);
  const [, chroma, hue] = toOklch(rgb);
  const at = (lightness: number) => {
    for (let reduced = chroma; reduced >= 0; reduced -= 0.005) {
      const candidate = fromOklch(lightness, reduced, hue);
      if (candidate) return candidate;
    }
    return fromOklch(lightness, 0, hue)!;
  };
  // Light themes darken toward black, dark themes lighten toward white; the
  // first lightness that fits is the closest one, to 0.001 in OKLCH.
  let [inside, outside] = theme === "light" ? [0, toOklch(rgb)[0]] : [1, toOklch(rgb)[0]];
  for (let step = 0; step < 14; step += 1) {
    const middle = (inside + outside) / 2;
    if (fits(luminance(at(middle)))) inside = middle;
    else outside = middle;
  }
  return formatHex(at(inside));
}
