import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { frameCoalescer } from "../../app/effect-helpers";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import { flattenOutline, outlineNumbers, type OutlineNode } from "./latex-outline";

/** More marks than this and the rail keeps the upper levels; the outline it opens lists every one. */
const MAX_MARKS = 32;
/**
 * Below this the source keeps the room the rail would take. The rail sits
 * between the text and the scrollbar, and the text gives up its clearance.
 */
const MIN_RAIL_EDITOR_WIDTH = 360;
/**
 * How long the pointer rests on the rail before the outline opens, so a
 * pointer passing over it on its way to the scrollbar does not open it, and
 * how long it may stray outside before the outline closes.
 */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 200;
/** The writer moving on by hand, which ends a jump's hold on the current section. */
const RELEASES = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
const ROW = ".latex-outline-rail-row";
const CURRENT_ROW = '.latex-outline-rail-row[data-item-selected="true"]';

type RailEntry = { node: OutlineNode; number: string | undefined; depth: number };
type Outline = { entries: RailEntry[]; marks: RailEntry[]; markOf: number[] };
/** The PDF pages last read, by outline and build. */
type PageCache = { key: string; pages: Array<number | null> };
/** What the rail shows as current, kept outside React state: scrolling must not render it. */
type Live = { outline: Outline | null; path: string; line: number; pinned: number; shown: number; fits: boolean };

/**
 * The entry `line` of `path` reads in: the last of the file's own headings at
 * or above it. Above the file's first heading, the one that precedes the file
 * in reading order (its `\input` sits in that section), or for the preamble
 * of the first file, its first heading, as the Markdown rail does. -1 for a
 * file with no headings of its own: where it is included is not in the
 * outline.
 */
function sectionAt(entries: RailEntry[], path: string, line: number): number {
  let previous = -1;
  let current = -1;
  for (const [index, { node }] of entries.entries()) {
    if (node.path !== path) {
      if (current < 0) previous = index;
      continue;
    }
    if (node.line > line) return current >= 0 ? current : previous >= 0 ? previous : index;
    current = index;
  }
  return current;
}

/** Mark the current section on the rail and in the open outline; `force` after a render. */
function showCurrent(state: Live, root: HTMLElement | null, force = false) {
  const entries = state.outline?.entries ?? [];
  const current = state.pinned >= 0 && state.pinned < entries.length ? state.pinned : sectionAt(entries, state.path, state.line);
  if (!root || (!force && current === state.shown)) return;
  state.shown = current;
  const mark = current >= 0 ? state.outline?.markOf[current] ?? -1 : -1;
  root.querySelectorAll(".latex-outline-rail-mark").forEach((node, index) => node.toggleAttribute("data-current", index === mark));
  root.querySelectorAll(ROW).forEach((node, index) => {
    if (index === current) {
      node.setAttribute("data-item-selected", "true");
      node.setAttribute("aria-current", "location");
    } else {
      node.removeAttribute("data-item-selected");
      node.removeAttribute("aria-current");
    }
  });
}

function railOutline(nodes: OutlineNode[]): Outline {
  const sections = flattenOutline(nodes).filter((node) => node.kind !== "input");
  if (!sections.length) return { entries: [], marks: [], markOf: [] };
  const numbers = outlineNumbers(nodes);
  const base = Math.min(...sections.map((node) => node.level));
  const entries = sections.map((node) => ({ node, number: numbers.get(node.id), depth: Math.min(2, node.level - base) }));
  const deepest = entries.length <= MAX_MARKS ? 2
    : entries.filter((entry) => entry.depth <= 1).length <= MAX_MARKS ? 1 : 0;
  const marks = entries.filter((entry) => entry.depth <= deepest);
  // A subsection the rail leaves out lights the mark of the section holding it.
  let mark = -1;
  const markOf = entries.map((entry) => entry.depth <= deepest ? ++mark : mark);
  return { entries, marks, markOf };
}

/**
 * The outline rail on the source editor's right edge: one mark per heading,
 * shorter for each level down, the section being read in the weft's blue. A
 * pointer resting on it, or Enter on it, opens the outline: numbers, titles
 * and the PDF page each heading landed on, and a row sends the editor (and
 * the PDF) there.
 *
 * "Being read" is the middle of the viewport, where every jump centers its
 * target (editor-reveal.ts); the section a row jumped to stays current until
 * the writer scrolls, types or clicks, as a jump near the end of the document
 * cannot center it. Scrolling never renders the rail: the scroll handler
 * finds the section and marks it in the DOM itself, so a scrolled frame costs
 * one line lookup and, when the section changes, two attributes. Marks and
 * rows are keyed by position, as a heading's id moves with every edit above
 * it. The outline mounts only while open.
 */
export function LatexOutlineRail({ view, path, nodes, label, documentName, pdfUrl, onSelect }: {
  view: EditorView;
  /** The file in the editor. */
  path: string;
  nodes: OutlineNode[];
  /** The rail's and the outline's accessible name. */
  label: string;
  /** What the outline is of, for its header. */
  documentName: string;
  /** The compiled PDF the pages are read from; null when there is none. */
  pdfUrl: string | null;
  onSelect: (path: string, line: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  // What the DOM shows as current, kept outside React (see above).
  const live = useRef<Live>({ outline: null, path, line: 1, pinned: -1, shown: -2, fits: true });
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<PageCache | null>(null);
  const [fits, setFits] = useState(true);
  const outline = useMemo(() => railOutline(nodes), [nodes]);

  // Every render may have drawn new marks or rows: mark them again.
  useLayoutEffect(() => {
    live.current.outline = outline;
    live.current.path = path;
    showCurrent(live.current, rootRef.current, true);
  });

  // Where reading is, whether the editor has room for the rail, and the
  // writer's own moves that end a jump's hold.
  useEffect(() => {
    const scroller = view.scrollDOM;
    const pane = rootRef.current?.parentElement ?? scroller;
    const state = live.current;
    const read = () => {
      if (!view.dom.isConnected) return;
      const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2 - view.documentTop;
      state.line = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, middle)).from).number;
      showCurrent(state, rootRef.current);
    };
    const [scheduleRead, cancelRead] = frameCoalescer(read);
    const resize = new ResizeObserver(() => {
      const next = scroller.clientWidth === 0 || scroller.clientWidth >= MIN_RAIL_EDITOR_WIDTH;
      if (next !== state.fits) {
        state.fits = next;
        setFits(next);
      }
      scheduleRead();
    });
    resize.observe(scroller);
    scroller.addEventListener("scroll", scheduleRead, { passive: true });
    const release = (event: Event) => {
      if (state.pinned < 0 || (event.target instanceof Node && rootRef.current?.contains(event.target))) return;
      state.pinned = -1;
      showCurrent(state, rootRef.current);
    };
    for (const type of RELEASES) pane.addEventListener(type, release, { capture: true, passive: true });
    scheduleRead();
    return () => {
      cancelRead();
      resize.disconnect();
      scroller.removeEventListener("scroll", scheduleRead);
      for (const type of RELEASES) pane.removeEventListener(type, release, true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [view]);

  if (outline.marks.length < 2 || !fits) return null;

  const settle = (next: boolean, delay: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpen(next);
    }, delay);
  };
  const close = (refocus: boolean) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
    if (refocus) rootRef.current?.querySelector<HTMLElement>(".latex-outline-rail-marks")?.focus();
  };
  const focusCurrentRow = () => {
    const root = rootRef.current;
    (root?.querySelector<HTMLElement>(CURRENT_ROW) ?? root?.querySelector<HTMLElement>(ROW))?.focus();
  };
  const openFromKeyboard = () => {
    if (open) focusCurrentRow();
    else {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setOpen(true);
      // The outline mounts in this commit; its rows are marked before the next frame.
      window.requestAnimationFrame(focusCurrentRow);
    }
  };

  return (
    <div
      ref={rootRef}
      className="latex-outline-rail"
      data-open={open ? "" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") settle(true, open ? 0 : OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        // A keyboard working in the outline keeps it open; the pointer alone closes it.
        if (rootRef.current?.querySelector(".latex-outline-rail-panel")?.contains(document.activeElement)) return;
        settle(false, CLOSE_DELAY_MS);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) close(false);
      }}
    >
      <button
        type="button"
        className="latex-outline-rail-marks"
        aria-label={label}
        aria-expanded={open}
        onClick={(event) => {
          // A pointer click toggles; Enter and Space arrive here as clicks too.
          if (event.detail === 0) openFromKeyboard();
          else if (open) close(false);
          else settle(true, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openFromKeyboard();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close(false);
          }
        }}
      >
        {outline.marks.map(({ depth }, index) => (
          // By position: a heading's id moves with every edit above it.
          <span key={index} className="latex-outline-rail-mark" data-depth={depth} />
        ))}
      </button>
      {open && (
        <OutlinePanel
          entries={outline.entries}
          path={path}
          label={label}
          documentName={documentName}
          pdfUrl={pdfUrl}
          pages={pages}
          onPages={setPages}
          onEscape={() => close(true)}
          onChoose={(index) => {
            const { node } = outline.entries[index]!;
            live.current.pinned = index;
            close(false);
            showCurrent(live.current, rootRef.current);
            onSelect(node.path, node.line);
          }}
        />
      )}
    </div>
  );
}

/** The opened outline: numbers, titles and pages, one row per heading. */
function OutlinePanel({ entries, path, label, documentName, pdfUrl, pages, onPages, onEscape, onChoose }: {
  entries: RailEntry[];
  path: string;
  label: string;
  documentName: string;
  pdfUrl: string | null;
  /** The pages last read, kept by the rail while the outline is closed. */
  pages: PageCache | null;
  onPages: (pages: PageCache) => void;
  onEscape: () => void;
  onChoose: (index: number) => void;
}) {
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement | null>(null);
  // The pages come from the compiled PDF's SyncTeX map, once per build and outline.
  const pageKey = useMemo(() => pdfUrl && entries.length
    ? `${pdfUrl}\n${entries.map(({ node }) => `${node.path}:${node.line}`).join("\n")}`
    : "", [entries, pdfUrl]);
  const pagesCurrent = pages !== null && pages.key === pageKey;
  useEffect(() => {
    if (!pageKey || pagesCurrent) return;
    let cancelled = false;
    const headings = entries.map(({ node }) => ({ path: node.path, line: node.line }));
    void invoke<Array<number | null>>("synctex_heading_pages", { headings })
      .then((answer) => Array.isArray(answer) ? answer : [], () => [])
      .then((answer) => {
        if (!cancelled) onPages({ key: pageKey, pages: answer });
      });
    return () => {
      cancelled = true;
    };
  }, [entries, onPages, pageKey, pagesCurrent]);

  // Open on the current row. The list scrolls itself, never the editor pane
  // around it (as scrollIntoView would).
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>(CURRENT_ROW);
    if (current && list) list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
  }, []);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = ({
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: rows.length - 1,
    } as Record<string, number>)[event.key];
    if (next === undefined || !rows.length) return;
    event.preventDefault();
    rows[(next + rows.length) % rows.length]?.focus();
  };

  return (
    <nav className="latex-outline-rail-panel" aria-label={label} onKeyDown={moveFocus}>
      <div className="latex-outline-rail-header">
        <span>{label}</span>
        <span className="latex-outline-rail-document" title={documentName}>{documentName}</span>
      </div>
      <div ref={listRef} className="latex-outline-rail-scroll fluid-hover-surface">
        <FluidHoverSurface selector={ROW} follow=":focus" preserveSelection />
        <ul className="latex-outline-rail-list">
          {entries.map(({ node, number, depth }, index) => {
            const page = pagesCurrent ? pages.pages[index] ?? null : null;
            return (
              // By position: a heading's id moves with every edit above it.
              <li key={index}>
                <button
                  type="button"
                  className="latex-outline-rail-row"
                  data-depth={depth}
                  title={node.path === path ? node.title : `${node.title} · ${node.path}`}
                  onClick={() => onChoose(index)}
                >
                  <span className="latex-outline-rail-number">{number}</span>
                  <span className="latex-outline-rail-title">{node.title}</span>
                  {page !== null && (
                    <span className="latex-outline-rail-page" aria-label={t`Page ${page}`}>{t`p.${page}`}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
