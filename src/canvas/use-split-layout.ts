import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { clamp, loadSplitRatio, persistSplitRatio } from "../settings/app-settings";
import { SPLIT_PREVIEW_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH } from "../app/window-layout";
import type { CanvasMode } from "../app-types";
import { setSplitResizerResistance, trackResizeDrag } from "./split-resizer";

/**
 * The canvas's pane proportions: the source/preview split (shared with the two
 * dual editors), remembered across sessions, plus the resizer gestures that
 * change it.
 */
export type SplitMinimums = { source: number; preview: number };
const SPLIT_MINIMUMS: SplitMinimums = { source: SPLIT_SOURCE_MIN_WIDTH, preview: SPLIT_PREVIEW_MIN_WIDTH };

export function useSplitLayout(
  mode: CanvasMode,
  dualRatioResetGeneration: number,
  minimums: SplitMinimums = SPLIT_MINIMUMS,
) {
  const { source: sourceMinimum, preview: previewMinimum } = minimums;
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const preferredSplitRatioRef = useRef(splitRatio);
  const handledDualRatioResetRef = useRef(dualRatioResetGeneration);
  const commitSplitRatio = useCallback((ratio: number) => {
    preferredSplitRatioRef.current = ratio;
    setSplitRatio(ratio);
    persistSplitRatio(ratio);
  }, []);

  useLayoutEffect(() => {
    if (mode !== "dual" || handledDualRatioResetRef.current === dualRatioResetGeneration) return;
    handledDualRatioResetRef.current = dualRatioResetGeneration;
    commitSplitRatio(0.5);
  }, [commitSplitRatio, dualRatioResetGeneration, mode]);

  const constrainSplitRatio = useCallback((ratio: number) => {
    const width = splitRef.current?.getBoundingClientRect().width ?? 0;
    if (!width) return clamp(ratio, 0.2, 0.8);
    const tracksWidth = Math.max(1, width - 1);
    const minimum = Math.min(1, sourceMinimum / tracksWidth);
    const maximum = Math.max(minimum, 1 - previewMinimum / tracksWidth);
    return clamp(ratio, minimum, maximum);
  }, [previewMinimum, sourceMinimum]);

  useEffect(() => {
    const split = splitRef.current;
    if (!split || mode !== "split" || typeof ResizeObserver === "undefined") return;
    const fitRatio = () => {
      // A smaller window must not overwrite the divider position to restore
      // next time. Only explicit resize gestures change the preference.
      setSplitRatio(constrainSplitRatio(preferredSplitRatioRef.current));
    };
    const observer = new ResizeObserver(fitRatio);
    observer.observe(split);
    fitRatio();
    return () => observer.disconnect();
  }, [constrainSplitRatio, mode]);

  const beginDualResize = (event: PointerEvent<HTMLDivElement>) => {
    let latest = splitRatio;
    trackResizeDrag(event, (moveEvent, grip) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      latest = clamp((moveEvent.clientX - bounds.left) / bounds.width, 0.2, 0.8);
      const edge = clamp(latest * bounds.width, 220, Math.max(220, bounds.width - 220));
      setSplitResizerResistance(grip, moveEvent.clientX - bounds.left - edge);
      setSplitRatio(latest);
    }, () => commitSplitRatio(latest));
  };
  const beginSplitResize = (event: PointerEvent<HTMLDivElement>) => {
    let latest = splitRatio;
    trackResizeDrag(event, (moveEvent, grip) => {
      const split = splitRef.current;
      const bounds = split?.getBoundingClientRect();
      if (!split || !bounds?.width) {
        latest = splitRatio;
        return;
      }
      const tracksWidth = Math.max(1, bounds.width - 1);
      const minimum = Math.min(Math.ceil(tracksWidth), sourceMinimum);
      const maximum = Math.max(minimum, Math.floor(tracksWidth - previewMinimum));
      const sourceWidth = clamp(Math.round(moveEvent.clientX - bounds.left), minimum, maximum);
      latest = constrainSplitRatio(sourceWidth / tracksWidth);
      setSplitResizerResistance(grip, Math.round(moveEvent.clientX - bounds.left) - sourceWidth);
      // Keep the hot drag path outside React: re-rendering the PDF viewer per
      // pointer event made its toolbar icons shift. Pointer-up commits the ratio.
      split.style.gridTemplateColumns = `${sourceWidth}px 1px minmax(${previewMinimum}px, 1fr)`;
    }, () => commitSplitRatio(latest));
  };
  const nudgeSplit = (delta: number) => commitSplitRatio(constrainSplitRatio(splitRatio + delta));

  return { splitRef, splitRatio, beginDualResize, beginSplitResize, nudgeSplit };
}
