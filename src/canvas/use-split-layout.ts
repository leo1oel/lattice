import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { clamp, loadSplitRatio, persistSplitRatio } from "../settings/app-settings";
import { SPLIT_PREVIEW_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH } from "../app/window-layout";
import type { CanvasMode } from "../app-types";
import { setSplitResizerResistance, trackResizeDrag } from "./split-resizer";

/**
 * The canvas's source/preview split, remembered across sessions, plus the
 * resizer gestures that change it.
 */
export type SplitMinimums = { source: number; preview: number };
const SPLIT_MINIMUMS: SplitMinimums = { source: SPLIT_SOURCE_MIN_WIDTH, preview: SPLIT_PREVIEW_MIN_WIDTH };

/**
 * The pane minimums a split of `tracksWidth` (its width less the 1 px
 * divider) can honour. A Trellis file panel may be narrower than both
 * minimums together; there they shrink in proportion so the panes share the
 * panel instead of the preview running under the neighbouring panel.
 */
function fitSplitMinimums(minimums: SplitMinimums, tracksWidth: number): SplitMinimums {
  const scale = Math.min(1, tracksWidth / (minimums.source + minimums.preview));
  return { source: minimums.source * scale, preview: minimums.preview * scale };
}

/**
 * The split's grid columns: the source at `--split-ratio` of the tracks, held
 * between the pane minimums. CSS does the fitting so it stays exact between
 * resize observations; it is `fitSplitMinimums` with 100% as the split's width.
 * The ratio is a custom property rather than baked into the template so a drag
 * can move it outside React without ever replacing the responsive columns: a
 * pixel grid left behind by a drag would stop fitting when the panel narrows.
 */
export function splitGridTemplate(minimums: SplitMinimums) {
  const total = minimums.source + minimums.preview;
  const source = `min(${minimums.source}px, (100% - 1px) * ${minimums.source / total})`;
  const preview = `min(${minimums.preview}px, (100% - 1px) * ${minimums.preview / total})`;
  return `clamp(${source}, calc((100% - 1px) * var(--split-ratio)), calc(100% - 1px - ${preview})) 1px minmax(${preview}, 1fr)`;
}

export function useSplitLayout(mode: CanvasMode, minimums: SplitMinimums = SPLIT_MINIMUMS) {
  const { source: sourceMinimum, preview: previewMinimum } = minimums;
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const preferredSplitRatioRef = useRef(splitRatio);
  const commitSplitRatio = useCallback((ratio: number) => {
    preferredSplitRatioRef.current = ratio;
    setSplitRatio(ratio);
    persistSplitRatio(ratio);
  }, []);

  const constrainSplitRatio = useCallback((ratio: number) => {
    const width = splitRef.current?.getBoundingClientRect().width ?? 0;
    if (!width) return clamp(ratio, 0.2, 0.8);
    const tracksWidth = Math.max(1, width - 1);
    const fitted = fitSplitMinimums({ source: sourceMinimum, preview: previewMinimum }, tracksWidth);
    const minimum = Math.min(1, fitted.source / tracksWidth);
    const maximum = Math.max(minimum, 1 - fitted.preview / tracksWidth);
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
      const fitted = fitSplitMinimums({ source: sourceMinimum, preview: previewMinimum }, tracksWidth);
      const minimum = Math.min(Math.ceil(tracksWidth), fitted.source);
      const maximum = Math.max(minimum, Math.floor(tracksWidth - fitted.preview));
      const sourceWidth = clamp(Math.round(moveEvent.clientX - bounds.left), minimum, maximum);
      latest = constrainSplitRatio(sourceWidth / tracksWidth);
      setSplitResizerResistance(grip, Math.round(moveEvent.clientX - bounds.left) - sourceWidth);
      // Keep the hot drag path outside React: re-rendering the PDF viewer per
      // pointer event made its toolbar icons shift. Pointer-up commits the
      // same ratio, so React finds the property already current.
      split.style.setProperty("--split-ratio", String(latest));
    }, () => commitSplitRatio(latest));
  };
  const nudgeSplit = (delta: number) => commitSplitRatio(constrainSplitRatio(splitRatio + delta));

  return { splitRef, splitRatio, beginSplitResize, nudgeSplit };
}
