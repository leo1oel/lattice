import { createContext, forwardRef, useContext, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { assignRef, cn } from "@/lib/utils";
import { spring, springExit } from "./motion-values";
import { useFluidHover, useRegisterFluidHoverItem } from "./use-fluid-hover";
import { FluidHoverHighlight } from "./fluid-hover-highlight";

// Adapted from Fluid Functionalism's radio group, at its rounded shape and
// default (36px) size step.

const fontWeights = {
  normal: "'wght' 400, 'opsz' 14",
  semibold: "'wght' 550, 'opsz' 18",
};

interface RadioGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  selectedIndex: number | null;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext() {
  const ctx = useContext(RadioGroupContext);
  if (!ctx) throw new Error("useRadioGroup must be used within a RadioGroup");
  return ctx;
}

interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  children: ReactNode;
  selectedIndex?: number;
}

const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  function RadioGroup({ children, selectedIndex: requestedIndex, className, ...props }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const hover = useFluidHover(containerRef);
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem } = hover;
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const selectedIndex = requestedIndex !== undefined && requestedIndex >= 0 ? requestedIndex : null;
    const selectedRect = selectedIndex === null ? null : itemRects[selectedIndex];

    return (
      <RadioGroupContext.Provider
        value={{ registerItem, activeIndex, selectedIndex }}
      >
        <div
          ref={(node) => {
            containerRef.current = node;
            assignRef(ref, node);
          }}
          onMouseEnter={handlers.onMouseEnter}
          onMouseMove={handlers.onMouseMove}
          onMouseLeave={handlers.onMouseLeave}
          onClick={handlers.onClick}
          onFocus={(e) => {
            const indexAttr = (e.target as HTMLElement)
              .closest("[data-fluid-hover-index]")
              ?.getAttribute("data-fluid-hover-index");
            if (indexAttr == null) return;
            const idx = Number(indexAttr);
            setActiveIndex(idx);
            setFocusedIndex((e.target as HTMLElement).matches(":focus-visible") ? idx : null);
          }}
          onBlur={(e) => {
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            setActiveIndex(null);
          }}
          onKeyDown={(e) => {
            // Scope to the rows that carry an index: a caller can withhold it
            // to keep a row out of arrow-key navigation.
            const items = Array.from(
              containerRef.current?.querySelectorAll<HTMLElement>("[data-fluid-hover-index]") ?? [],
            );
            const current = items.indexOf(e.target as HTMLElement);
            if (current === -1) return;
            const next = ({
              ArrowDown: current + 1,
              ArrowRight: current + 1,
              ArrowUp: current - 1,
              ArrowLeft: current - 1,
              Home: 0,
              End: items.length - 1,
            } as Record<string, number>)[e.key];
            if (next === undefined) return;
            e.preventDefault();
            const target = items[(next + items.length) % items.length];
            target.focus();
            target.click();
          }}
          role="radiogroup"
          className={cn("relative flex flex-col w-72 max-w-full select-none", className)}
          {...props}
        >
          {selectedRect && (
            <motion.div
              className="absolute rounded-lg bg-active pointer-events-none"
              initial={false}
              animate={{ ...selectedRect, opacity: 1 }}
              transition={{ ...spring.moderate, opacity: { duration: 0.08 } }}
            />
          )}
          <FluidHoverHighlight hover={hover} className="rounded-lg" />
          <AnimatePresence>
            {focusRect && (
              <motion.div
                className="absolute rounded-[10px] pointer-events-none z-20 border border-[color:var(--focus-ring,#6B97FF)]"
                initial={false}
                animate={{
                  left: focusRect.left - 2,
                  top: focusRect.top - 2,
                  width: focusRect.width + 4,
                  height: focusRect.height + 4,
                }}
                exit={{ opacity: 0, transition: springExit.fast }}
                transition={{ ...spring.fast, opacity: { duration: 0.08 } }}
              />
            )}
          </AnimatePresence>
          {children}
        </div>
      </RadioGroupContext.Provider>
    );
  },
);

interface RadioItemProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  index: number;
  onSelect?: () => void;
}

const RadioItem = forwardRef<HTMLDivElement, RadioItemProps>(
  function RadioItem({ label, index, onSelect, className, ...props }, ref) {
    const internalRef = useRef<HTMLDivElement>(null);
    const { registerItem, activeIndex, selectedIndex } = useRadioGroupContext();
    useRegisterFluidHoverItem(registerItem, index, internalRef);

    const isActive = activeIndex === index;
    const isSelected = selectedIndex === index;

    return (
      <div
        ref={(node) => {
          internalRef.current = node;
          assignRef(ref, node);
        }}
        data-fluid-hover-index={index}
        // Roving tabindex: selected item is the tab stop; with no selection the
        // first item takes it so the group stays keyboard-reachable.
        tabIndex={isSelected || (selectedIndex === null && index === 0) ? 0 : -1}
        role="radio"
        aria-checked={isSelected}
        aria-label={label}
        onClick={() => onSelect?.()}
        onMouseDown={(e) => {
          // Land focus on the row itself rather than whatever the native
          // mousedown would focus, or arrow-key nav dead-zones: the group
          // keydown handler only finds the row wrappers. The click still
          // fires. Genuinely interactive children keep their own focus.
          const interactive = (e.target as HTMLElement).closest(
            'button:not([tabindex="-1"]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (interactive && interactive !== e.currentTarget) return;
          e.preventDefault();
          e.currentTarget.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onSelect?.();
          }
        }}
        className={cn(
          // Fixed height so the text-box trim on the label doesn't shrink the row.
          "relative z-10 flex h-9 items-center gap-2 rounded-lg px-3 cursor-pointer outline-none",
          className,
        )}
        {...props}
      >
        <div className="relative shrink-0 w-[16px] h-[16px]">
          <div
            className={cn(
              "absolute inset-0 rounded-full border-solid transition-all duration-80 border-[1.5px]",
              isSelected
                ? "border-transparent"
                : isActive
                  ? "border-neutral-400 dark:border-neutral-500"
                  : "border-border",
            )}
          />
          <AnimatePresence initial={false}>
            {isSelected && (
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: 0.3 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.3, transition: { duration: 0.04 } }}
                transition={spring.fast}
              >
                <div className="rounded-full bg-foreground w-[8px] h-[8px]" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {/* Both stacked spans carry the text-box trim so the invisible bold
            sizer and the visible label keep identical boxes. */}
        <span className="inline-grid text-[length:var(--type-body-size)]">
          <span
            className="col-start-1 row-start-1 invisible [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]",
              isSelected || isActive ? "text-foreground" : "text-muted-foreground",
            )}
            style={{ fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal }}
          >
            {label}
          </span>
        </span>
      </div>
    );
  },
);

export { RadioGroup, RadioItem };
