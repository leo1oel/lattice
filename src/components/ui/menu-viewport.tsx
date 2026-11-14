import { useCallback, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { ExternalScrollbar } from "./external-scrollbar";
import { FluidHoverSurface } from "./fluid-hover-surface";
import { menuViewportClassName } from "./menu-surface";

/**
 * A menu's scrolling list, with the app's one scrollbar over it.
 *
 * Radix owns the menu's content element, so the list cannot be a ScrollArea
 * viewport; it scrolls a plain box inside the surface instead, with the native
 * bar hidden, and `ExternalScrollbar` draws the ScrollArea's track beside it
 * (8% at rest, 12% over the track, 16% held, shown while the pointer is over
 * the list or it scrolls). The surface stays the positioned, non-scrolling box
 * the track spans (`menuContentClassName`). The fluid hover lives in the
 * scrolling box, so its fill scrolls with the rows.
 */
export function MenuViewport({ children, className }: { children: ReactNode; className?: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const getViewport = useCallback(() => viewport.current, []);
  return (
    <>
      <div ref={viewport} data-slot="menu-viewport" className={cn(menuViewportClassName, "fluid-hover-surface", className)}>
        <FluidHoverSurface />
        {children}
      </div>
      <ExternalScrollbar getViewport={getViewport} />
    </>
  );
}
