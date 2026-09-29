/**
 * The rendered diagram of a Mermaid code block (spec R-BLK-5): Mermaid (MIT)
 * loads on first use, the diagram follows the app theme, and a pan-and-zoom
 * viewport (@panzoom/panzoom, MIT) has labelled controls. Pans move 48 px,
 * eased over 200 ms unless the reader prefers reduced motion.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { useReducedMotion } from "motion/react";
import type { PanzoomObject } from "@panzoom/panzoom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

const PAN_STEP = 48;

type Mermaid = typeof import("mermaid").default;
let mermaidModule: Promise<Mermaid> | null = null;
const loadMermaid = () => {
  mermaidModule ??= import("mermaid").then((module) => module.default);
  return mermaidModule;
};

/** The app theme, read from the root element and followed as it changes. */
function useAppTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

let renderSequence = 0;

export function MermaidDiagram({ chart }: { chart: string }) {
  const { t } = useLingui();
  const reducedMotion = useReducedMotion();
  const theme = useAppTheme();
  const baseId = useId().replace(/[^\w-]/g, "");
  const canvas = useRef<HTMLDivElement>(null);
  const panzoom = useRef<PanzoomObject | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadMermaid().then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
          // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS font stack
          fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
        });
        renderSequence += 1;
        // eslint-disable-next-line lingui/no-unlocalized-strings -- an element id
        const { svg: rendered } = await mermaid.render(`${baseId}-mermaid-${renderSequence}`, chart);
        if (cancelled) return;
        setSvg(rendered);
        setError(null);
      }).catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, svg == null ? 0 : 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The previous diagram stays up while the next one renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, chart, theme]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || svg == null) return;
    let disposed = false;
    void import("@panzoom/panzoom").then(({ default: Panzoom }) => {
      if (disposed) return;
      panzoom.current?.destroy();
      panzoom.current = Panzoom(element, { maxScale: 6, minScale: 0.25, step: 0.25, cursor: "grab" });
    });
    return () => {
      disposed = true;
      panzoom.current?.destroy();
      panzoom.current = null;
    };
  }, [svg]);

  const pan = (x: number, y: number) => panzoom.current?.pan(x, y, {
    animate: !reducedMotion, duration: 200, easing: "ease-out", relative: true,
  });

  return (
    <div className="lx-md-mermaid" role="group" aria-label={t`Mermaid preview`}>
      {error
        ? <div className="lx-md-mermaid-error" role="status">{error}</div>
        : svg == null
          ? <div className="lx-md-mermaid-loading" aria-hidden="true" />
          // Mermaid's own sanitizer ran on this SVG (securityLevel: strict).
          : <div className="lx-md-mermaid-viewport"><div ref={canvas} className="lx-md-mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} /></div>}
      {svg != null && !error && (
        <div className="lx-md-mermaid-controls" contentEditable={false}>
          <button type="button" data-area="up" aria-label={t`Pan up`} onClick={() => pan(0, PAN_STEP)}><ArrowUp aria-hidden="true" /></button>
          <button type="button" data-area="zoom-in" aria-label={t`Zoom in`} onClick={() => panzoom.current?.zoomIn({ animate: !reducedMotion })}><ZoomIn aria-hidden="true" /></button>
          <button type="button" data-area="left" aria-label={t`Pan left`} onClick={() => pan(PAN_STEP, 0)}><ArrowLeft aria-hidden="true" /></button>
          <button type="button" data-area="reset" aria-label={t`Reset view`} onClick={() => panzoom.current?.reset({ animate: !reducedMotion })}><RotateCcw aria-hidden="true" /></button>
          <button type="button" data-area="right" aria-label={t`Pan right`} onClick={() => pan(-PAN_STEP, 0)}><ArrowRight aria-hidden="true" /></button>
          <button type="button" data-area="down" aria-label={t`Pan down`} onClick={() => pan(0, -PAN_STEP)}><ArrowDown aria-hidden="true" /></button>
          <button type="button" data-area="zoom-out" aria-label={t`Zoom out`} onClick={() => panzoom.current?.zoomOut({ animate: !reducedMotion })}><ZoomOut aria-hidden="true" /></button>
        </div>
      )}
    </div>
  );
}
