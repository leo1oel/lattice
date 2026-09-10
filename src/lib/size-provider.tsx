"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SizeContext, sizeMap, type SizeVariant } from "./size-context";

export function SizeProvider({ children, size, defaultSize = "default" }: {
  children: ReactNode;
  size?: SizeVariant;
  defaultSize?: SizeVariant;
}) {
  const [internalSize, setInternalSize] = useState<SizeVariant>(defaultSize);
  const isControlled = size !== undefined;
  const resolved = size ?? internalSize;

  // A controlled provider must not write shadowed state that could reappear
  // when its size prop is removed.
  const setSize = useCallback((next: SizeVariant) => {
    if (!isControlled) setInternalSize(next);
  }, [isControlled]);

  const value = useMemo(() => ({ size: resolved, setSize, classes: sizeMap[resolved] }), [resolved, setSize]);
  return <SizeContext.Provider value={value}>{children}</SizeContext.Provider>;
}
