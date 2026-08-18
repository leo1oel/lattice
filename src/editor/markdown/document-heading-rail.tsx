import type { JSONContent } from "@tiptap/core";
import { motion, useReducedMotion } from "motion/react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { getHeadingSlug } from "@ok-app/editor/extensions/wiki-link-helpers";
import { MAGNET_SPRING } from "../../components/ui/motion-values";

const MAX_DETAILED_HEADINGS = 28;
const MIN_RAIL_VIEWPORT_WIDTH = 480;
const RAIL_WAVE = {
  radius: 2.75,
  activeRestingScale: 0.66,
  primaryRestingScale: 0.4,
  secondaryRestingScale: 0.27,
  tertiaryRestingScale: 0.18,
};

export type DocumentHeadingItem = {
  id: string;
  label: string;
  level: number;
  /** Approximate document position, used only by the passive virtual viewport. */
  position: number;
};

function jsonTextContent(node: JSONContent): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(jsonTextContent).join("");
}

function jsonHasInternalAnchor(node: JSONContent): boolean {
  if (node.marks?.some((mark) => (
    mark.type === "link"
    && typeof mark.attrs?.href === "string"
    && mark.attrs.href.startsWith("#")
  ))) return true;
  return (node.content ?? []).some(jsonHasInternalAnchor);
}

/**
 * The rail follows the same parsed document that TipTap renders rather than a
 * second Markdown regex. Slugs are accumulated before presentation filtering
 * so duplicate heading IDs stay byte-identical to HeadingAnchorsStateful.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the visual editor shares this parsed-heading adapter with the component.
export function documentHeadingItems(
  document: JSONContent,
  options: { hideGeneratedContents?: boolean } = {},
): DocumentHeadingItem[] {
  const roots = document.content ?? [];
  const slugCounts = new Map<string, number>();
  const headings: DocumentHeadingItem[] = [];
  const lastRootIndex = Math.max(1, roots.length - 1);
  const generatedContentsHeadings = new Set<JSONContent>();
  if (options.hideGeneratedContents) {
    for (let index = 0; index < roots.length - 1; index += 1) {
      const heading = roots[index];
      const list = roots[index + 1];
      if (
        heading?.type === "heading"
        && Number(heading.attrs?.level) === 2
        && jsonTextContent(heading).trim().toLocaleLowerCase() === "contents"
        && list?.type === "list"
        && jsonHasInternalAnchor(list)
      ) generatedContentsHeadings.add(heading);
    }
  }

  const visit = (node: JSONContent, rootIndex: number) => {
    if (node.type === "heading") {
      const label = jsonTextContent(node).replace(/\s+/g, " ").trim();
      const level = Number(node.attrs?.level);
      const id = getHeadingSlug(label, slugCounts);
      if (
        id
        && label
        && !generatedContentsHeadings.has(node)
      ) {
        headings.push({
          id,
          label,
          level: Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 2,
          position: rootIndex / lastRootIndex,
        });
      }
    }
    for (const child of node.content ?? []) visit(child, rootIndex);
  };

  roots.forEach((root, index) => visit(root, index));
  return headings;
}

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

function headingTarget(root: HTMLElement, id: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]"))
    .find((heading) => heading.id === id) ?? null;
}

function nextKeyboardIndex(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  length: number,
): number | null {
  if (event.key === "ArrowDown" || event.key === "ArrowRight") return (index + 1) % length;
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") return (index - 1 + length) % length;
  if (event.key === "Home") return 0;
  if (event.key === "End") return length - 1;
  return null;
}

function restingScaleForDepth(depth: number): number {
  if (depth === 0) return RAIL_WAVE.primaryRestingScale;
  if (depth === 1) return RAIL_WAVE.secondaryRestingScale;
  return RAIL_WAVE.tertiaryRestingScale;
}

function scaleForPointer(restingScale: number, index: number, pointerPosition: number): number {
  const linearInfluence = Math.max(
    0,
    1 - Math.abs(index - pointerPosition) / RAIL_WAVE.radius,
  );
  const smoothInfluence = linearInfluence * linearInfluence * (3 - 2 * linearInfluence);
  return restingScale + (1 - restingScale) * smoothInfluence;
}

export function DocumentHeadingRail({
  items: rawItems,
  virtualized = false,
  onSelect,
}: {
  items: DocumentHeadingItem[];
  virtualized?: boolean;
  onSelect: (item: DocumentHeadingItem) => void;
}) {
  const items = useMemo(() => navigableHeadingItems(rawItems), [rawItems]);
  const reduceMotion = useReducedMotion() ?? false;
  const navRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  const [pointerPosition, setPointerPosition] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [fitsViewport, setFitsViewport] = useState(true);

  const selectedId = items.some((item) => item.id === activeId)
    ? activeId
    : (items[0]?.id ?? "");
  const hoveredIndex = pointerPosition == null
    ? -1
    : Math.max(0, Math.min(items.length - 1, Math.round(pointerPosition)));
  const hoveredId = hoveredIndex >= 0 ? (items[hoveredIndex]?.id ?? null) : null;
  const displayedId = hoveredId ?? focusedId;
  const displayedIndex = displayedId
    ? items.findIndex((item) => item.id === displayedId)
    : -1;
  const baseLevel = items.length ? Math.min(...items.map((item) => item.level)) : 1;
  const wavePosition = pointerPosition ?? (focusedId && displayedIndex >= 0 ? displayedIndex : null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const root = nav?.closest<HTMLElement>(".visual-markdown-editor");
    const scroller = root?.closest<HTMLElement>(".editor-doc-scroll");
    if (!nav || !root || !scroller || items.length < 2) return;

    let frame: number | null = null;
    let offsets: Array<{ id: string; top: number }> = [];
    const updateActive = () => {
      const readingLine = scroller.scrollTop + Math.min(scroller.clientHeight * 0.22, 160);
      let nextId = items[0]?.id ?? "";
      if (virtualized || offsets.length < items.length) {
        const range = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        const progress = Math.min(1, Math.max(0, readingLine / range));
        for (const item of items) {
          if (item.position > progress) break;
          nextId = item.id;
        }
      } else {
        for (const offset of offsets) {
          if (offset.top > readingLine) break;
          nextId = offset.id;
        }
      }
      setActiveId((current) => current === nextId ? current : nextId);
    };
    const measure = () => {
      frame = null;
      const viewportRect = scroller.getBoundingClientRect();
      offsets = items.flatMap((item) => {
        const target = headingTarget(root, item.id);
        return target ? [{
          id: item.id,
          top: target.getBoundingClientRect().top - viewportRect.top + scroller.scrollTop,
        }] : [];
      });
      setFitsViewport(
        scroller.clientWidth === 0 || scroller.clientWidth >= MIN_RAIL_VIEWPORT_WIDTH,
      );
      updateActive();
    };
    const scheduleMeasure = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(measure);
    };
    const onScroll = () => updateActive();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scroller);
    resizeObserver.observe(root);
    const proseMirror = root.querySelector<HTMLElement>(".ProseMirror");
    const mutationObserver = new MutationObserver(scheduleMeasure);
    if (proseMirror) {
      mutationObserver.observe(proseMirror, {
        attributes: true,
        attributeFilter: ["id"],
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    scroller.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [items, virtualized]);

  if (items.length < 2 || !fitsViewport) return null;

  return (
    <div className="visual-heading-rail">
      <nav
        ref={navRef}
        className="visual-heading-rail-nav"
        aria-label="Document sections"
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
          const restingScale = restingScaleForDepth(depth);
          const scale = wavePosition == null
            ? (selected ? RAIL_WAVE.activeRestingScale : restingScale)
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
                const nextIndex = nextKeyboardIndex(event, index, items.length);
                if (nextIndex == null) return;
                event.preventDefault();
                const next = items[nextIndex];
                if (!next) return;
                setFocusedId(next.id);
                buttonRefs.current.get(next.id)?.focus();
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
                  <div className="visual-heading-rail-preview-card">
                    {item.label}
                  </div>
                </motion.div>
              )}
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
