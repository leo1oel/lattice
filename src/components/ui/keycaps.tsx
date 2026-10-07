import { renderKeycaps } from "./render-keycaps";

/** A key combination drawn as keycaps: the shortcut sheet's rows and the focus bar's hint (see `renderKeycaps`). */
export function Keycaps({ keys, className }: { keys: readonly string[]; className?: string }) {
  return renderKeycaps(keys, className);
}
