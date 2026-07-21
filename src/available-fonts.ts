export type FontOption = {
  label: string;
  value: string;
  /** Primary family name used for availability checks. */
  family: string;
  /** Bundled via @fontsource / always present in the app. */
  bundled?: boolean;
};

export const UI_FONT_OPTIONS: FontOption[] = [
  { label: "DM Sans", value: '"DM Sans", -apple-system, sans-serif', family: "DM Sans", bundled: true },
  { label: "System", value: "-apple-system, BlinkMacSystemFont, sans-serif", family: "-apple-system", bundled: true },
  { label: "Avenir Next", value: '"Avenir Next", sans-serif', family: "Avenir Next" },
];

export const EDITOR_FONT_OPTIONS: FontOption[] = [
  { label: "Menlo", value: "Menlo, ui-monospace, monospace", family: "Menlo", bundled: true },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Menlo, monospace', family: "JetBrains Mono", bundled: true },
  { label: "SF Mono", value: '"SF Mono", "SFMono-Regular", Menlo, monospace', family: "SF Mono" },
  { label: "Fira Code", value: '"Fira Code", Menlo, monospace', family: "Fira Code" },
  { label: "MonoLisa", value: '"MonoLisa", Menlo, monospace', family: "MonoLisa" },
];

export const DEFAULT_EDITOR_FONT = EDITOR_FONT_OPTIONS[0].value;
export const DEFAULT_UI_FONT = UI_FONT_OPTIONS[0].value;

/**
 * `document.fonts.check` is unreliable in WKWebView — it often returns true for
 * families that are not installed. Measure against a baseline monospace face instead.
 */
export function isFontAvailable(
  family: string,
  measure: (font: string) => number = measureTextWidth,
): boolean {
  if (family === "-apple-system") return true;
  const baseline = measure(`72px monospace`);
  const candidate = measure(`72px "${family}", monospace`);
  // If the engine ignored the family, width matches the monospace baseline.
  return Number.isFinite(candidate) && Number.isFinite(baseline) && Math.abs(candidate - baseline) > 0.5;
}

export function availableFontOptions(
  options: FontOption[],
  measure: (font: string) => number = measureTextWidth,
): FontOption[] {
  return options.filter((option) => option.bundled || isFontAvailable(option.family, measure));
}

export function resolveFontValue(
  preferred: string | undefined,
  options: FontOption[],
  fallback: string,
  measure: (font: string) => number = measureTextWidth,
): string {
  const available = availableFontOptions(options, measure);
  if (preferred && available.some((option) => option.value === preferred)) {
    return preferred;
  }
  if (preferred?.includes("MonoLisa") && !available.some((option) => option.family === "MonoLisa")) {
    return fallback;
  }
  if (preferred) {
    const match = available.find((option) => preferred.includes(option.family));
    if (match) return match.value;
  }
  return available[0]?.value ?? fallback;
}

function measureTextWidth(font: string): number {
  if (typeof document === "undefined") {
    // SSR / unit tests without a canvas — treat unknown faces as missing unless bundled.
    return font.includes("monospace") && !font.includes('"') ? 100 : 100;
  }
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.font = font;
    return context.measureText("mmmmmmmmlliWi").width;
  } catch {
    return 0;
  }
}
