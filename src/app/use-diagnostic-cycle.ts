import { useCallback, useRef } from "react";
import type { BuildResult } from "../app-types";
import { sortDiagnostics, type CompileDiagnostic } from "../build/compile-diagnostics";

/**
 * F8 / Shift-F8: step to the next or previous diagnostic of the current build
 * in the order the panel lists them, wrapping. A new build restarts the walk
 * at its first diagnostic (or its last, stepping back).
 */
export function useDiagnosticCycle(
  build: BuildResult | null,
  openDiagnosticRef: { readonly current: (diagnostic: CompileDiagnostic) => Promise<void> },
) {
  const cursorRef = useRef<{ build: BuildResult | null; index: number }>({ build: null, index: 0 });
  return useCallback((direction: 1 | -1) => {
    const diagnostics = sortDiagnostics(build?.diagnostics ?? []);
    if (!diagnostics.length) return;
    const walking = cursorRef.current.build === build;
    const next = walking
      ? (cursorRef.current.index + direction + diagnostics.length) % diagnostics.length
      : direction === 1 ? 0 : diagnostics.length - 1;
    cursorRef.current = { build, index: next };
    void openDiagnosticRef.current(diagnostics[next]);
  }, [build, openDiagnosticRef]);
}
