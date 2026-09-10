"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShapeContext, shapeMap, type ShapeVariant } from "./shape-context";

export function ShapeProvider({ children, defaultShape = "rounded" }: {
  children: ReactNode;
  defaultShape?: ShapeVariant;
}) {
  const [shape, setShapeState] = useState<ShapeVariant>(defaultShape);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush the guard before changing the radius so the existing cross-fade runs.
  const setShape = useCallback((next: ShapeVariant) => {
    const root = document.documentElement;
    root.classList.add("transitioning");
    void root.offsetHeight;
    setShapeState(next);
    if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
    transitionTimeoutRef.current = setTimeout(() => root.classList.remove("transitioning"), 200);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--shape-input-radius", `${shapeMap[shape].bgRadius}px`);
  }, [shape]);

  const value = useMemo(() => ({ shape, setShape, classes: shapeMap[shape] }), [shape, setShape]);
  return <ShapeContext.Provider value={value}>{children}</ShapeContext.Provider>;
}
