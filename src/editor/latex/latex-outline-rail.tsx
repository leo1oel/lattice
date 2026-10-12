import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
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

type RailEntry = { node: OutlineNode; number: string | undefined; depth: number };

/**
 * The section `line` of `path` reads in: the last of the file's own headings
 * at or above it. Above the file's first heading, the one that precedes the
 * file in reading order (its `\input` sits in that section), or for the
 * preamble of the first file, its first heading, as the Markdown rail does.
 * Null for a file with no headings of its own: where it is included is not
 * in the outline.
 */
function sectionAt(entries: RailEntry[], path: string, line: number): string | null {
  let previous: string | null = null;
  let current: string | null = null;
  for (const { node } of entries) {
    if (node.path !== path) {
      if (current === null) previous = node.id;
      continue;
    }
    if (node.line > line) return current ?? previous ?? node.id;
    current = node.id;
  }
  return current;
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
 * cannot center it. The rail reads only the viewport and the outline the
 * structure hook already keeps, so a long document costs it one line lookup
 * per scrolled frame.
 */
export function LatexOutlineRail({ view, path, nodes, documentName, pdfUrl, onSelect }: {
  view: EditorView | null;
  /** The file in the editor. */
  path: string;
  nodes: OutlineNode[];
  /** What the outline is of, for its header. */
  documentName: string;
  /** The compiled PDF the pages are read from; null when there is none. */
  pdfUrl: string | null;
  onSelect: (path: string, line: number) => void;
}) {
  const { t } = useLingui();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const focusOnOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [readingLine, setReadingLine] = useState(1);
  const [fits, setFits] = useState(true);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [pages, setPages] = useState<{ key: string; pages: Array<number | null> } | null>(null);

  const entries = useMemo((): RailEntry[] => {
    const sections = flattenOutline(nodes).filter((node) => node.kind !== "input");
    if (!sections.length) return [];
    const numbers = outlineNumbers(nodes);
    const base = Math.min(...sections.map((node) => node.level));
    return sections.map((node) => ({ node, number: numbers.get(node.id), depth: Math.min(2, node.level - base) }));
  }, [nodes]);
  const marks = useMemo(() => {
    if (entries.length <= MAX_MARKS) return entries;
    const upper = entries.filter((entry) => entry.depth <= 1);
    return upper.length <= MAX_MARKS ? upper : entries.filter((entry) => entry.depth === 0);
  }, [entries]);
  const marked = useMemo(() => new Set(marks), [marks]);

  const pinned = pinnedId !== null && entries.some((entry) => entry.node.id === pinnedId) ? pinnedId : null;
  const currentId = pinned ?? sectionAt(entries, path, readingLine);
  // A subsection the rail leaves out lights the mark of the section holding it.
  let markCurrentId: string | null = null;
  for (const entry of entries) {
    if (marked.has(entry)) markCurrentId = entry.node.id;
    if (entry.node.id === currentId) break;
  }
  if (currentId === null) markCurrentId = null;

  // Where reading is, and whether the editor has room for the rail.
  useEffect(() => {
    if (!view) return;
    const scroller = view.scrollDOM;
    const update = () => {
      if (!view.dom.isConnected) return;
      setFits(scroller.clientWidth === 0 || scroller.clientWidth >= MIN_RAIL_EDITOR_WIDTH);
      const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2 - view.documentTop;
      const block = view.lineBlockAtHeight(Math.max(0, middle));
      setReadingLine(view.state.doc.lineAt(block.from).number);
    };
    const [schedule, cancel] = frameCoalescer(update);
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancel();
      resize.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [view, path]);

  // A jump's section stays current until the writer moves on by hand.
  useEffect(() => {
    const pane = rootRef.current?.parentElement;
    if (!pinned || !pane) return;
    const release = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setPinnedId(null);
    };
    const types = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const type of types) pane.addEventListener(type, release, { capture: true, passive: true });
    return () => {
      for (const type of types) pane.removeEventListener(type, release, true);
    };
  }, [pinned]);

  // The pages come from the compiled PDF's SyncTeX map, once per build and
  // outline, and only once someone opens the outline to read them.
  const pageKey = useMemo(() => pdfUrl && entries.length
    ? `${pdfUrl}\n${entries.map(({ node }) => `${node.path}:${node.line}`).join("\n")}`
    : "", [entries, pdfUrl]);
  const pagesCurrent = pages !== null && pages.key === pageKey;
  useEffect(() => {
    if (!open || !pageKey || pagesCurrent) return;
    let cancelled = false;
    const headings = entries.map(({ node }) => ({ path: node.path, line: node.line }));
    void invoke<Array<number | null>>("synctex_heading_pages", { headings })
      .then((answer) => Array.isArray(answer) ? answer : [], () => [])
      .then((answer) => {
        if (!cancelled) setPages({ key: pageKey, pages: answer });
      });
    return () => {
      cancelled = true;
    };
  }, [entries, open, pageKey, pagesCurrent]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  // Opened from the keyboard, the outline takes focus on the current row.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const current = panel?.querySelector<HTMLElement>(".latex-outline-rail-row.active");
    // The list scrolls itself, never the editor pane around it (as scrollIntoView would).
    const list = panel?.querySelector<HTMLElement>(".latex-outline-rail-scroll");
    if (current && list) list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
    if (!focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    (current ?? panel?.querySelector<HTMLElement>(".latex-outline-rail-row"))?.focus();
  }, [open]);

  if (marks.length < 2 || !fits) return null;

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
    if (refocus) triggerRef.current?.focus();
  };
  const openFromKeyboard = () => {
    focusOnOpenRef.current = true;
    if (open) {
      // Already open under the pointer: move into it.
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>(".latex-outline-rail-row.active") ?? panel?.querySelector<HTMLElement>(".latex-outline-rail-row"))?.focus();
      focusOnOpenRef.current = false;
      return;
    }
    setOpen(true);
  };
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>(".latex-outline-rail-row") ?? [])];
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

  const pageOf = (index: number) => pagesCurrent ? pages.pages[index] ?? null : null;

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
        if (panelRef.current?.contains(document.activeElement)) return;
        settle(false, CLOSE_DELAY_MS);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) close(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="latex-outline-rail-marks"
        aria-label={t`Outline`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
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
        {marks.map(({ node, depth }) => (
          <span
            key={node.id}
            className="latex-outline-rail-mark"
            data-depth={depth}
            data-current={node.id === markCurrentId ? "" : undefined}
          />
        ))}
      </button>
      {open && (
        <nav ref={panelRef} id={panelId} className="latex-outline-rail-panel" aria-label={t`Outline`} onKeyDown={moveFocus}>
          <div className="latex-outline-rail-header">
            <span>{t`Outline`}</span>
            <span className="latex-outline-rail-document" title={documentName}>{documentName}</span>
          </div>
          <div className="latex-outline-rail-scroll fluid-hover-surface">
            <FluidHoverSurface selector=".latex-outline-rail-row" follow=":focus" preserveSelection />
            <ul className="latex-outline-rail-list">
              {entries.map(({ node, number, depth }, index) => {
                const current = node.id === currentId;
                const page = pageOf(index);
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      className={`latex-outline-rail-row${current ? " active" : ""}`}
                      data-depth={depth}
                      aria-current={current ? "location" : undefined}
                      title={node.path === path ? node.title : `${node.title} · ${node.path}`}
                      onClick={() => {
                        setPinnedId(node.id);
                        close(false);
                        onSelect(node.path, node.line);
                      }}
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
      )}
    </div>
  );
}
