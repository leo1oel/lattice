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
  const commitSplitRatio = (ratio: number) => {
    preferredSplitRatioRef.current = ratio;
    setSplitRatio(ratio);
    persistSplitRatio(ratio);
  };

  useLayoutEffect(() => {
    if (mode !== "dual" || handledDualRatioResetRef.current === dualRatioResetGeneration) return;
    handledDualRatioResetRef.current = dualRatioResetGeneration;
    preferredSplitRatioRef.current = 0.5;
    setSplitRatio(0.5);
    persistSplitRatio(0.5);
  }, [dualRatioResetGeneration, mode]);

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

  const editorsShare = 1 - columnsPdfRatio;
  const beginDualResize = (event: PointerEvent<HTMLDivElement>) => {
    let latest = splitRatio;
    trackResizeDrag(event, (moveEvent, grip) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      if (mode === "columns") {
        // Resize only across the two editor panes (everything left of the PDF).
        const editorsWidth = bounds.width * editorsShare;
        latest = clamp((moveEvent.clientX - bounds.left) / Math.max(editorsWidth, 1), 0.25, 0.75);
        const edge = clamp(latest * editorsWidth, 160, Math.max(160, editorsWidth - 160));
        setSplitResizerResistance(grip, moveEvent.clientX - bounds.left - edge);
      } else {
        latest = clamp((moveEvent.clientX - bounds.left) / bounds.width, 0.2, 0.8);
        const edge = clamp(latest * bounds.width, 220, Math.max(220, bounds.width - 220));
        setSplitResizerResistance(grip, moveEvent.clientX - bounds.left - edge);
      }
      setSplitRatio(latest);
    }, () => {
      preferredSplitRatioRef.current = latest;
      persistSplitRatio(latest);
    });
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
      // Keep the hot drag path outside React. Re-rendering the PDF viewer for
      // every pointer event made WebKit repeatedly lay out and repaint the
      // toolbar, which showed up as tiny icon shifts. The committed ratio is
      // still sent through React on pointer-up.
      split.style.gridTemplateColumns = `${sourceWidth}px 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, 1fr)`;
    }, () => commitSplitRatio(latest));
  };
  const nudgeSplit = (delta: number) => commitSplitRatio(constrainSplitRatio(splitRatio + delta));

  return { splitRef, splitRatio, columnsPdfRatio, beginDualResize, beginColumnsPdfResize, beginSplitResize, nudgeSplit };
}
