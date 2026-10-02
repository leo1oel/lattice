import { useLingui } from "@lingui/react/macro";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAGNET_SPRING } from "../../components/ui/motion-values";

const MAX_DETAILED_HEADINGS = 28;
const MIN_RAIL_VIEWPORT_WIDTH = 480;
const WAVE_RADIUS = 2.75;
const ACTIVE_RESTING_SCALE = 0.66;
/** Resting tick scale by heading depth below the shallowest level. */
const RESTING_SCALES = [0.4, 0.27, 0.18];
const next = (index: number, length: number) => (index + 1) % length;
const previous = (index: number, length: number) => (index - 1 + length) % length;
const KEYBOARD_STEPS: Record<string, (index: number, length: number) => number> = {
  ArrowDown: next,
  ArrowRight: next,
  ArrowUp: previous,
  ArrowLeft: previous,
  Home: () => 0,
  End: (_index, length) => length - 1,
};

export type DocumentHeadingItem = {
  id: string;
  label: string;
  level: number;
  /** Approximate document position, used only by the passive virtual viewport. */
  position: number;
};

function navigableHeadingItems(items: DocumentHeadingItem[]): DocumentHeadingItem[] {
  if (items.length < 2) return items;
  const shallowest = Math.min(...items.map((item) => item.level));
  const shallowestItems = items.filter((item) => item.level === shallowest);
  const withoutDocumentTitle = shallowest === 1 && shallowestItems.length === 1
    ? items.filter((item) => item !== shallowestItems[0])
    : items;
  if (withoutDocumentTitle.length <= MAX_DETAILED_HEADINGS) return withoutDocumentTitle;

  const baseLevel = Math.min(...withoutDocumentTitle.map((item) => item.level));
  const primaryAndSecondary = withoutDocumentTitle.filter((item) => item.level <= baseLevel + 1);
  if (primaryAndSecondary.length <= MAX_DETAILED_HEADINGS) return primaryAndSecondary;
  return withoutDocumentTitle.filter((item) => item.level === baseLevel);
}

/**
 * The rendered heading for each id, from one query. Measuring used to query
 * every heading once per rail item, which is quadratic: opening a document of
 * 150 sections ran 150 queries of 150 headings, and the rail re-measures after
 * every edit.
 */
function headingTargets(root: HTMLElement, ids: ReadonlySet<string>): Map<string, HTMLElement> {
  const targets = new Map<string, HTMLElement>();
  // By id rather than by tag: a heading of a long document that is not drawn
  // yet is a placeholder carrying the heading's id (block-window.ts).
  for (const heading of root.querySelectorAll<HTMLElement>("[id]")) {
    if (ids.has(heading.id) && !targets.has(heading.id)) targets.set(heading.id, heading);
  }
  return targets;
}

function scaleForPointer(restingScale: number, index: number, pointerPosition: number): number {
  const linearInfluence = Math.max(0, 1 - Math.abs(index - pointerPosition) / WAVE_RADIUS);
  const smoothInfluence = linearInfluence * linearInfluence * (3 - 2 * linearInfluence);
  return restingScale + (1 - restingScale) * smoothInfluence;
}

export function DocumentHeadingRail({ items: rawItems, virtualized = false, onSelect }: {
  items: DocumentHeadingItem[];
  virtualized?: boolean;
  onSelect: (item: DocumentHeadingItem) => void;
}) {
  const items = useMemo(() => navigableHeadingItems(rawItems), [rawItems]);
  const { t } = useLingui();
  const reduceMotion = useReducedMotion() ?? false;
  const navRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  const [pointerPosition, setPointerPosition] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [fitsViewport, setFitsViewport] = useState(true);

  const selectedId = items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? "");
  const hoveredId = pointerPosition == null
    ? null
    : (items[Math.max(0, Math.min(items.length - 1, Math.round(pointerPosition)))]?.id ?? null);
  const displayedId = hoveredId ?? focusedId;
  const displayedIndex = displayedId ? items.findIndex((item) => item.id === displayedId) : -1;
  const baseLevel = items.length ? Math.min(...items.map((item) => item.level)) : 1;
  const wavePosition = pointerPosition ?? (focusedId && displayedIndex >= 0 ? displayedIndex : null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const root = nav?.closest<HTMLElement>(".lx-md-editor");
    const scroller = root?.closest<HTMLElement>(".editor-doc-scroll");
    if (!nav || !root || !scroller || items.length < 2) return;

    let proseMirror: HTMLElement | null = null;
    let frame: number | null = null;
    let offsets: Array<{ id: string; top: number }> = [];
    const updateActive = () => {
      const readingLine = scroller.scrollTop + Math.min(scroller.clientHeight * 0.22, 160);
      // Without every heading mounted, estimate from scroll progress instead.
      const measured = !virtualized && offsets.length >= items.length;
      const reached = measured
        ? readingLine
        : Math.min(1, Math.max(0, readingLine / Math.max(1, scroller.scrollHeight - scroller.clientHeight)));
      let nextId = items[0]?.id ?? "";
      for (const mark of measured ? offsets : items.map(({ id, position }) => ({ id, top: position }))) {
        if (mark.top > reached) break;
        nextId = mark.id;
      }
      setActiveId((current) => current === nextId ? current : nextId);
    };
    const measure = () => {
      frame = null;
      const viewportRect = scroller.getBoundingClientRect();
      const targets = headingTargets(root, new Set(items.map((item) => item.id)));
      offsets = items.flatMap((item) => {
        const target = targets.get(item.id);
        return target ? [{ id: item.id, top: target.getBoundingClientRect().top - viewportRect.top + scroller.scrollTop }] : [];
      });
      // While a panel divider drags, the surface keeps its width
      // (trellis-hold-width.ts) and the rail stays as it is: showing or
      // hiding it changes the surface's padding, which lays out every block
      // placeholder again in the middle of the drag. It settles on release.
      if (!proseMirror?.hasAttribute("data-width-held")) {
        setFitsViewport(scroller.clientWidth === 0 || scroller.clientWidth >= MIN_RAIL_VIEWPORT_WIDTH);
      }
      updateActive();
    };
    const scheduleMeasure = () => {
      frame ??= window.requestAnimationFrame(measure);
    };
    const onScroll = () => updateActive();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scroller);
    resizeObserver.observe(root);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    const watchSurface = () => {
      proseMirror = root.querySelector<HTMLElement>(".ProseMirror");
      if (proseMirror) {
        mutationObserver.observe(proseMirror, { attributes: true, attributeFilter: ["id", "data-width-held"], characterData: true, childList: true, subtree: true });
      }
      return proseMirror !== null;
    };
    // The editor can mount its surface after the rail has mounted.
    const surfaceWatcher = new MutationObserver(() => {
      if (!watchSurface()) return;
      surfaceWatcher.disconnect();
      scheduleMeasure();
    });
    if (!watchSurface()) surfaceWatcher.observe(root, { childList: true, subtree: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      surfaceWatcher.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [items, virtualized]);

  if (items.length < 2 || !fitsViewport) return null;

  return (
    <div className="visual-heading-rail">
      <nav
        ref={navRef}
        className="visual-heading-rail-nav"
        aria-label={t`Document sections`}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const rowHeight = bounds.height / items.length;
          if (rowHeight <= 0) return;
          const nextPosition = (event.clientY - bounds.top) / rowHeight - 0.5;
          setPointerPosition(Math.max(0, Math.min(items.length - 1, nextPosition)));
        }}
        onPointerLeave={() => setPointerPosition(null)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedId;
          const highlighted = item.id === displayedId;
          const depth = Math.min(2, Math.max(0, item.level - baseLevel));
          const restingScale = RESTING_SCALES[depth]!;
          const scale = wavePosition == null
            ? (selected ? ACTIVE_RESTING_SCALE : restingScale)
            : scaleForPointer(restingScale, index, wavePosition);

          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) buttonRefs.current.set(item.id, node);
                else buttonRefs.current.delete(item.id);
              }}
              type="button"
              className="visual-heading-rail-item"
              aria-label={item.label}
              aria-current={selected ? "location" : undefined}
              data-depth={depth}
              tabIndex={selected ? 0 : -1}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setPointerPosition(index);
              }}
              onPointerDown={() => setFocusedId(null)}
              onFocus={(event) => {
                if (event.currentTarget.matches(":focus-visible")) setFocusedId(item.id);
              }}
              onKeyDown={(event) => {
                const step = KEYBOARD_STEPS[event.key];
                if (!step) return;
                event.preventDefault();
                const target = items[step(index, items.length)]!;
                setFocusedId(target.id);
                buttonRefs.current.get(target.id)?.focus();
              }}
              onClick={() => onSelect(item)}
            >
              <motion.span
                aria-hidden="true"
                className={`visual-heading-rail-tick${selected ? " is-active" : ""}${highlighted ? " is-highlighted" : ""}`}
                animate={{ scaleX: scale }}
                transition={reduceMotion ? { duration: 0 } : MAGNET_SPRING}
              />
            </button>
          );
        })}

        <div className="visual-heading-rail-previews" aria-hidden="true">
          {items.map((item) => (
            <div className="visual-heading-rail-preview-row" key={item.id}>
              {item.id === displayedId && (
                <motion.div
                  key={item.id}
                  className="visual-heading-rail-preview-anchor"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, filter: "blur(3px)" }}
                  animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: reduceMotion ? 0 : 0.12, ease: "easeOut" }}
                >
                  <div className="visual-heading-rail-preview-card">{item.label}</div>
                </motion.div>
              )}
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
