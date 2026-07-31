export type FontOption = {
  label: string;
  value: string;
  /** Primary family name used for availability checks. */
  family: string;
  /** Always present in a supported application environment. */
  alwaysAvailable?: boolean;
};

export const FIXED_UI_FONT = '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif';
export const FIXED_EDITOR_FONT =
  '"TX-02 Variable", "TX-02", "Berkeley Mono Variable", "Berkeley Mono", ' +
  '"JetBrains Mono Variable", "JetBrains Mono", Menlo, "SF Mono", ui-monospace, monospace';

export const UI_FONT_OPTIONS: FontOption[] = [
  { label: "Inter", value: FIXED_UI_FONT, family: "Inter Variable", alwaysAvailable: true },
];

export const EDITOR_FONT_OPTIONS: FontOption[] = [
  {
    label: "TX-02 / JetBrains Mono",
    value: FIXED_EDITOR_FONT,
    family: "JetBrains Mono Variable",
    alwaysAvailable: true,
  },
];

export const DEFAULT_EDITOR_FONT = EDITOR_FONT_OPTIONS[0].value;
export const DEFAULT_UI_FONT = FIXED_UI_FONT;

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
  return options.filter((option) => option.alwaysAvailable || isFontAvailable(option.family, measure));
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
