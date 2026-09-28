import { useState } from "react";
import { clamp } from "../settings/app-settings";

export type ZoomScaleUpdate = number | ((current: number) => number);

/** A zoom factor that every writer (buttons, typed percentage, wheel) keeps within bounds. */
export function useZoomScale(initial: number, min: number, max: number) {
  const [scale, setScale] = useState(initial);
  const updateScale = (next: ZoomScaleUpdate) => {
    setScale((current) => clamp(typeof next === "function" ? next(current) : next, min, max));
  };
  return [scale, updateScale] as const;
}
