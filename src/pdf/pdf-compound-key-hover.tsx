/**
 * Resting the pointer on a compound number in the compiled PDF shows its
 * chemnum key, for writing `\cmpd{key}` in the text. The number is traced back
 * by reverse SyncTeX to its source line, which names the key.
 *
 * A number is a compound's only when the last build's `.aux` gave a compound
 * that number: a project without chemnum records listens to nothing, and the
 * citation numbers, references and years of a line with a compound show none.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useLingui } from "@lingui/react/macro";
import type { SyncTexTarget } from "../app-types";
import type { CompiledBuild } from "../editor/latex/compiled-labels";
import { compiledCompoundNumbers } from "../editor/latex/compound-project";
import { LeavesOnClose } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { useLatestRef } from "../hooks/use-latest-ref";
import { notifyCopied } from "../telemetry/app-notify";
import { compoundCommand, compoundKeysOnLine, compoundMarksOnLine, keysNumbered, printedNumber, withoutCounterPrefix, type CompoundNumbers } from "../editor/latex/compound-keys";
import { addListeners } from "./pdf-viewer-utils";

const REST_MS = 250;
const CLOSE_MS = 300;
/** Long enough for a double-click on the number to be seen before a single click copies. */
const SINGLE_CLICK_MS = 260;
/** How far a press may travel and still be a click, not a text selection. */
const CLICK_SLOP_PX = 4;
/** Around the number and its card: the path between them, which keeps the card open. */
const BRIDGE_PADDING_PX = 16;
const GLYPH_SPANS = ".textLayer span:not(.markedContent):not(.endOfContent)";
/** A link's own hover card and click (a citation, a reference) are its, not a compound's. */
const onLink = (target: EventTarget | null) => target instanceof Element && target.closest("a") !== null;

type Hit = { span: HTMLElement; keys: string[]; marks: string[] };

/** The text-layer span under the point, on `page`. */
function spanAt(page: HTMLElement, x: number, y: number): HTMLElement | undefined {
  return [...page.querySelectorAll<HTMLElement>(GLYPH_SPANS)].find((span) => {
    const box = span.getBoundingClientRect();
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });
}

/** The compound keys on the source line that produced the point, in PDF.js's page units. */
async function keysAt(page: HTMLElement, x: number, y: number): Promise<{ keys: string[]; marks: string[] }> {
  const scale = Number.parseFloat(getComputedStyle(page).getPropertyValue("--scale-factor"));
  if (!(scale > 0)) return { keys: [], marks: [] };
  const bounds = page.getBoundingClientRect();
  const target = await invoke<SyncTexTarget>("synctex_edit", {
    page: Number.parseInt(page.dataset.pageNumber ?? "", 10),
    x: Number(((x - bounds.left) / scale).toFixed(3)),
    y: Number(((y - bounds.top) / scale).toFixed(3)),
  });
  // Read from disk, not the open editor: the PDF was built from the saved file.
  const source = await invoke<string>("read_project_file", { path: target.path });
  const line = source.split(/\r?\n/)[target.line - 1] ?? "";
  return { keys: compoundKeysOnLine(line), marks: compoundMarksOnLine(line) };
}

/** Whether the point is on the number, on its card, or between them. */
function inBridge(span: Element, card: Element | null, x: number, y: number): boolean {
  const a = span.getBoundingClientRect();
  const b = card?.getBoundingClientRect() ?? a;
  return x >= Math.min(a.left, b.left) - BRIDGE_PADDING_PX && x <= Math.max(a.right, b.right) + BRIDGE_PADDING_PX
    && y >= Math.min(a.top, b.top) - BRIDGE_PADDING_PX && y <= Math.max(a.bottom, b.bottom) + BRIDGE_PADDING_PX;
}

export function PdfCompoundKeyHover({ host, projectRoot, build }: {
  host: HTMLElement;
  projectRoot: string;
  /** The build the PDF shows, whose `.aux` numbers its compounds; none before a build. */
  build: CompiledBuild | undefined;
}) {
  const { t } = useLingui();
  const [hit, setHit] = useReducer((_: Hit | null, next: Hit | null) => next, null);
  const [numbers, setNumbers] = useReducer(
    (_: CompoundNumbers | null, next: CompoundNumbers | null) => next, null,
  );
  const shown = useRef<Hit | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next: Hit | null) => {
    shown.current = next;
    setHit(next);
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => show(null), CLOSE_MS);
  }, [cancelClose, show]);

  const copy = (key: string, isMark: boolean) => {
    show(null);
    void navigator.clipboard.writeText(compoundCommand(key, isMark)).then(() => notifyCopied(t`LaTeX command copied`));
  };
  const copyLatest = useLatestRef(copy);

  useEffect(() => {
    let disposed = false;
    const read = build ? compiledCompoundNumbers(projectRoot, build) : Promise.resolve(new Map<string, string>());
    void read.then(
      (found) => { if (!disposed) setNumbers(found.size ? found : null); },
      () => { if (!disposed) setNumbers(null); },
    );
    return () => { disposed = true; };
  }, [projectRoot, build]);

  useEffect(() => {
    if (!numbers) return;
    const printed = new Set(numbers.values());
    let restTimer: ReturnType<typeof setTimeout> | undefined;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let pressedAt: { x: number; y: number } | null = null;
    const latest = { request: 0 };
    const look = async (target: EventTarget | null, x: number, y: number) => {
      const current = latest.request + 1;
      latest.request = current;
      const open = shown.current;
      if (open && inBridge(open.span, cardRef.current, x, y)) { cancelClose(); return; }
      const page = target instanceof Element && !onLink(target) ? target.closest<HTMLElement>("[data-page-number]") : null;
      const span = page ? spanAt(page, x, y) : undefined;
      const text = span?.textContent ?? "";
      if (!page || !span || !(printed.has(printedNumber(text)) || printed.has(withoutCounterPrefix(text, numbers)))) { closeSoon(); return; }
      cancelClose();
      // No SyncTeX data, or a file it cannot read, simply has no key to show.
      const { keys: found, marks } = await keysAt(page, x, y).catch(() => ({ keys: [] as string[], marks: [] as string[] }));
      const keys = keysNumbered(text, found, numbers);
      if (current !== latest.request) return;
      if (keys.length) show({ span, keys, marks });
      else closeSoon();
    };
    const move = (event: PointerEvent) => {
      clearTimeout(restTimer);
      const { target, clientX, clientY } = event;
      restTimer = setTimeout(() => void look(target, clientX, clientY), REST_MS);
    };
    const stop = () => { clearTimeout(restTimer); latest.request += 1; };
    const leave = () => { stop(); closeSoon(); };
    const dismiss = () => { stop(); clearTimeout(clickTimer); cancelClose(); show(null); };
    const press = (event: PointerEvent) => { pressedAt = { x: event.clientX, y: event.clientY }; };
    // A plain click on the number copies its key, once it is clear no double-click follows.
    const click = (event: MouseEvent) => {
      clearTimeout(clickTimer);
      const open = shown.current;
      const still = pressedAt !== null && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) <= CLICK_SLOP_PX;
      const box = open?.span.getBoundingClientRect();
      const onNumber = box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (event.detail === 1 && !event.metaKey && !event.ctrlKey && still && onNumber && !onLink(event.target) && open?.keys.length === 1) {
        const [key] = open.keys;
        clickTimer = setTimeout(() => copyLatest.current(key, open.marks.includes(key)), SINGLE_CLICK_MS);
        return;
      }
      dismiss();
    };
    const removeListeners = [
      addListeners(host, { pointermove: move, pointerleave: leave, pointerdown: press, click }),
      addListeners(host, { scroll: dismiss }, { capture: true }),
      addListeners(host, { wheel: dismiss }, { passive: true }),
      addListeners(document, { keydown: (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); } }),
    ];
    return () => {
      stop();
      clearTimeout(clickTimer);
      cancelClose();
      for (const remove of removeListeners) remove();
    };
  }, [host, numbers, cancelClose, closeSoon, show, copyLatest]);

  useEffect(() => {
    const card = cardRef.current;
    if (!hit || !card) return;
    let disposed = false;
    const stop = autoUpdate(hit.span, card, () => {
      if (!hit.span.isConnected) { show(null); return; }
      void computePosition(hit.span, card, {
        strategy: "fixed", placement: "top",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y, placement }) => {
        if (disposed) return;
        card.dataset.side = placement.split("-")[0];
        Object.assign(card.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    });
    return () => { disposed = true; stop(); };
  }, [hit, show]);

  if (!hit) return null;
  return <LeavesOnClose surface={cardRef}>{createPortal(<div
    ref={cardRef}
    className={`citation-hover-card pdf-citation-hover ${popupMotionClassName}`}
    role="group"
    aria-label={t`Compound key`}
    style={{ position: "fixed", visibility: "hidden", zIndex: 1000 }}
    onPointerEnter={cancelClose}
    onPointerMove={cancelClose}
    onPointerLeave={closeSoon}
  >
    {hit.keys.map((key) => (
      <button
        key={key}
        type="button"
        className="citation-card-key"
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", fontSize: "var(--type-title-size)" }}
        onClick={() => copy(key, hit.marks.includes(key))}
      >{compoundCommand(key, hit.marks.includes(key))}</button>
    ))}
    <span className="citation-card-authors">{t`Click to copy the LaTeX command`}</span>
  </div>, document.body)}</LeavesOnClose>;
}
