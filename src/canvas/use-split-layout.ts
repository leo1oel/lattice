import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import {
  clamp,
  loadColumnsPdfRatio,
  loadSplitRatio,
  persistColumnsPdfRatio,
  persistSplitRatio,
} from "../settings/app-settings";
import { SPLIT_PDF_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH } from "../app/window-layout";
import type { CanvasMode } from "../app-types";
import { setSplitResizerResistance, trackResizeDrag } from "./split-resizer";

/**
 * The canvas's pane proportions: the source/preview split (shared with the two
 * dual editors) and the columns-mode PDF column, each remembered across
 * sessions, plus the resizer gestures that change them.
 */
export function useSplitLayout(mode: CanvasMode, dualRatioResetGeneration: number) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const preferredSplitRatioRef = useRef(splitRatio);
  const handledDualRatioResetRef = useRef(dualRatioResetGeneration);
  const [columnsPdfRatio, setColumnsPdfRatio] = useState(loadColumnsPdfRatio);
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
    const minimum = Math.min(1, SPLIT_SOURCE_MIN_WIDTH / tracksWidth);
    const maximum = Math.max(minimum, 1 - SPLIT_PDF_MIN_WIDTH / tracksWidth);
    return clamp(ratio, minimum, maximum);
  }, []);

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
    // Columns mode resizes only across the two editor panes (everything left of the PDF).
    const [share, minimumRatio, minimumWidth] = mode === "columns" ? [1 - columnsPdfRatio, 0.25, 160] : [1, 0.2, 220];
    trackResizeDrag(event, (moveEvent, grip) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      const editorsWidth = bounds.width * share;
      latest = clamp((moveEvent.clientX - bounds.left) / Math.max(editorsWidth, 1), minimumRatio, 1 - minimumRatio);
      const edge = clamp(latest * editorsWidth, minimumWidth, Math.max(minimumWidth, editorsWidth - minimumWidth));
      setSplitResizerResistance(grip, moveEvent.clientX - bounds.left - edge);
      setSplitRatio(latest);
    }, () => commitSplitRatio(latest));
  };
  const beginColumnsPdfResize = (event: PointerEvent<HTMLDivElement>) => {
    let latest = columnsPdfRatio;
    trackResizeDrag(event, (moveEvent, grip) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      const fromRight = (bounds.right - moveEvent.clientX) / bounds.width;
      latest = clamp(fromRight, 0.22, 0.55);
      const edge = clamp(latest * bounds.width, SPLIT_PDF_MIN_WIDTH, Math.max(SPLIT_PDF_MIN_WIDTH, bounds.width - 320));
      setSplitResizerResistance(grip, edge - fromRight * bounds.width);
      setColumnsPdfRatio(latest);
    }, () => persistColumnsPdfRatio(latest));
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
      const minimum = Math.min(Math.ceil(tracksWidth), SPLIT_SOURCE_MIN_WIDTH);
      const maximum = Math.max(minimum, Math.floor(tracksWidth - SPLIT_PDF_MIN_WIDTH));
      const sourceWidth = clamp(Math.round(moveEvent.clientX - bounds.left), minimum, maximum);
      latest = constrainSplitRatio(sourceWidth / tracksWidth);
      setSplitResizerResistance(grip, Math.round(moveEvent.clientX - bounds.left) - sourceWidth);
      // Keep the hot drag path outside React: re-rendering the PDF viewer per
      // pointer event made its toolbar icons shift. Pointer-up commits the ratio.
      split.style.gridTemplateColumns = `${sourceWidth}px 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, 1fr)`;
    }, () => commitSplitRatio(latest));
  };
  const nudgeSplit = (delta: number) => commitSplitRatio(constrainSplitRatio(splitRatio + delta));

  return { splitRef, splitRatio, columnsPdfRatio, beginDualResize, beginColumnsPdfResize, beginSplitResize, nudgeSplit };
}
