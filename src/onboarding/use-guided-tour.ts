import { useCallback, useRef, useState } from "react";
import { hasFinishedGuidedTour, rememberGuidedTour } from "../settings/app-settings";
import type { GuidedTourOutcome } from "./guided-tour";

/**
 * Whether the guided tour is running. The tutorial entries start it once the
 * sample project is open; entering any project (the sample again included)
 * ends the one before, so a replay always starts from its welcome.
 */
export function useGuidedTour() {
  /** `run` remounts the tour on every start; `replay` offers it to a writer who finished it before. */
  const [tour, setTour] = useState<{ run: number; replay: boolean } | null>(null);
  // Counted apart from `tour`: entering the sample ends a running tour and
  // starts the next in one batch, which must still remount it.
  const runsRef = useRef(0);
  const start = useCallback(() => {
    runsRef.current += 1;
    setTour({ run: runsRef.current, replay: hasFinishedGuidedTour() });
  }, []);
  const end = useCallback(() => setTour(null), []);
  const finish = useCallback((outcome: GuidedTourOutcome) => {
    rememberGuidedTour(outcome);
    setTour(null);
  }, []);
  return { tour, start, end, finish };
}
