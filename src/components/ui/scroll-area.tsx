// Adapted from Fluid Functionalism's Base UI ScrollArea, whose scrollbar
// implementation is adapted from Lina by SameerJS6 (https://lina.sameer.sh).

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type Ref,
} from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { useTouchPrimary } from "@/hooks/use-touch-primary";
import { cn } from "@/lib/utils";
import "./scroll-area.css";

const ScrollAreaContext = createContext(false);

type Orientation = "vertical" | "horizontal" | "both";
type ViewportProps = Omit<ComponentPropsWithoutRef<"div">, "children">;

interface ScrollAreaProps extends ComponentPropsWithoutRef<"div"> {
  contentClassName?: string;
  /** Subtle edge mask for content that continues offscreen. Defaults to the active orientation. */
  fadeEdges?: boolean | Orientation;
  viewportClassName?: string;
  viewportProps?: ViewportProps;
  viewportRef?: Ref<HTMLDivElement>;
  /** Which axes get scrollbars. Defaults to `"vertical"`. */
  orientation?: Orientation;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function updateScrollEdges(viewport: HTMLDivElement) {
  const tolerance = 1;
  const verticalOverflow = viewport.scrollHeight > viewport.clientHeight + tolerance;
  const horizontalOverflow = viewport.scrollWidth > viewport.clientWidth + tolerance;
  viewport.dataset.hasVerticalOverflow = String(verticalOverflow);
  viewport.dataset.hasHorizontalOverflow = String(horizontalOverflow);
  viewport.dataset.canScrollUp = String(verticalOverflow && viewport.scrollTop > tolerance);
  viewport.dataset.canScrollDown = String(
    verticalOverflow
      && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - tolerance,
  );
  viewport.dataset.canScrollLeft = String(horizontalOverflow && viewport.scrollLeft > tolerance);
  viewport.dataset.canScrollRight = String(
    horizontalOverflow
      && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - tolerance,
  );
}

const ScrollArea = forwardRef<
  ComponentRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(function ScrollArea(
  {
    className,
    children,
    contentClassName,
    fadeEdges = true,
    viewportClassName,
    viewportProps,
    viewportRef,
    orientation = "vertical",
    ...props
  },
  ref,
) {
  const isTouch = useTouchPrimary();
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewportCallback = useCallback((node: HTMLDivElement | null) => {
    assignRef(viewportRef, node);
    setViewport(node);
  }, [viewportRef]);

  useEffect(() => {
    if (!viewport) return;
    const update = () => updateScrollEdges(viewport);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(viewport);
    const content = viewport.firstElementChild;
    if (content instanceof HTMLElement) resizeObserver.observe(content);
    viewport.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", update);
    };
  }, [viewport]);

  const content = (
    <div data-slot="scroll-area-content" className={contentClassName}>
      {children}
    </div>
  );
  const fadeOrientation = fadeEdges === true ? orientation : fadeEdges;
  const fadeClassName = fadeOrientation === "vertical"
    ? "scroll-fade"
    : fadeOrientation === "horizontal"
      ? "scroll-fade-x"
      : fadeOrientation === "both"
        ? "scroll-fade-both"
        : undefined;
  const sharedViewportProps = {
    ...viewportProps,
    ref: viewportCallback,
    "data-slot": "scroll-area-viewport",
    className: cn(
      "size-full rounded-[inherit] outline-none",
      fadeClassName,
      viewportClassName,
      viewportProps?.className,
    ),
  };

  return (
    <ScrollAreaContext.Provider value={isTouch}>
      {isTouch ? (
        <div
          ref={ref}
          role="group"
          data-slot="scroll-area"
          aria-roledescription="scroll area"
          className={cn("relative overflow-hidden", className)}
          {...props}
        >
          <div
            {...sharedViewportProps}
            className={cn(
              sharedViewportProps.className,
              orientation === "vertical" && "overflow-y-auto",
              orientation === "horizontal" && "overflow-x-auto",
              orientation === "both" && "overflow-auto",
            )}
            tabIndex={viewportProps?.tabIndex ?? 0}
          >
            {content}
          </div>
        </div>
      ) : (
        <ScrollAreaPrimitive.Root
          ref={ref}
          data-slot="scroll-area"
          className={cn("relative overflow-hidden", className)}
          {...props}
        >
          <ScrollAreaPrimitive.Viewport {...sharedViewportProps}>
            <ScrollAreaPrimitive.Content
              data-slot="scroll-area-content-shell"
              style={orientation === "vertical" ? { minWidth: 0, width: "100%" } : undefined}
            >
              {content}
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
          {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
          {orientation === "both" && <ScrollAreaPrimitive.Corner />}
        </ScrollAreaPrimitive.Root>
      )}
    </ScrollAreaContext.Provider>
  );
});

const ScrollBar = forwardRef<
  ComponentRef<typeof ScrollAreaPrimitive.Scrollbar>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Scrollbar>
>(function ScrollBar({ className, orientation = "vertical", ...props }, ref) {
  const isTouch = useContext(ScrollAreaContext);
  if (isTouch) return null;

  return (
    <ScrollAreaPrimitive.Scrollbar
      ref={ref}
      orientation={orientation}
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      className={cn("lattice-scrollbar", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="lattice-scrollbar-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
});

export { ScrollArea, ScrollBar };
export type { ScrollAreaProps };
