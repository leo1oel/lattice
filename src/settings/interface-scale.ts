/**
 * The interface size: named steps, as Linear, hilos and Discord offer rather
 * than a free value, inside the range app-settings.ts clamps a stored scale
 * to (0.9–1.35). Settings › Appearance picks one; ⌘+, ⌘− and ⌘0 (and the View
 * menu) step through them anywhere, and use-appearance.ts applies the result
 * as the webview's zoom.
 */
export const INTERFACE_SCALE_STEPS = [0.9, 1, 1.1, 1.2, 1.35] as const;

/** The step closest to `scale` (a stored value from before the steps, or a hand edit). */
export function nearestInterfaceStep(scale: number): number {
  return INTERFACE_SCALE_STEPS.reduce<number>((best, step) => (Math.abs(step - scale) < Math.abs(best - scale) ? step : best), 1);
}

export type InterfaceZoomChange = "in" | "out" | "reset";

/** The size after `change`, held at the smallest and largest step. */
export function zoomedInterfaceScale(scale: number, change: InterfaceZoomChange): number {
  if (change === "reset") return 1;
  const index = INTERFACE_SCALE_STEPS.indexOf(nearestInterfaceStep(scale) as (typeof INTERFACE_SCALE_STEPS)[number]);
  const next = Math.min(INTERFACE_SCALE_STEPS.length - 1, Math.max(0, index + (change === "in" ? 1 : -1)));
  return INTERFACE_SCALE_STEPS[next]!;
}

/** "120%". */
export const interfaceScalePercent = (scale: number) => `${Math.round(scale * 100)}%`;
