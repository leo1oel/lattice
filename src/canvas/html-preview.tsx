import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { clamp } from "../settings/app-settings";
import { calculateVerticalScrollGeometry, EXTERNAL_SCROLLBAR_TRACK_INSET } from "../components/ui/external-scrollbar-geometry";
import { normalizeDocRelativeAssetUrl } from "../open-knowledge-core/markdown/resolve-image-url";
import type { HtmlFileViewState } from "../app-types";
import { scrollRange } from "./markdown-preview-sync";
import { useZoomScale } from "./use-zoom-scale";
import { ZoomControls } from "./zoom-controls";

const HTML_PREVIEW_OPEN_EXTERNAL = "lattice:html-preview-open-external";
const HTML_PREVIEW_SCROLL = "lattice:html-preview-scroll";
const HTML_PREVIEW_SET_SCROLL_TOP = "lattice:html-preview-set-scroll-top";
const HTML_PREVIEW_SET_ZOOM = "lattice:html-preview-set-zoom";
const HTML_PREVIEW_MIN_SCALE = 0.5;
const HTML_PREVIEW_MAX_SCALE = 2;

const HTML_PREVIEW_SCROLLBAR_STYLES = `
@media (pointer: fine) {
  html, body { scrollbar-width: none; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
}`;

function htmlPreviewProjectPath(target: string, documentPath: string): string | null {
  const rawPath = target.trim().split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const normalized = normalizeDocRelativeAssetUrl(decoded, documentPath);
  return normalized.startsWith("/") && normalized.length > 1 ? normalized.slice(1) : null;
}

function htmlSourceFromDataUrl(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const metadata = dataUrl.slice(0, comma).split(";");
  if (metadata.shift()?.toLocaleLowerCase() !== "data:text/html") return null;
  const payload = dataUrl.slice(comma + 1);
  try {
    if (!metadata.some((part) => part.toLocaleLowerCase() === "base64")) return decodeURIComponent(payload);
    const binary = atob(payload);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Project images, and project HTML the document embeds in iframes, that the preview must inline. */
function referencedProjectResources(source: string, path: string): Set<string> {
  const document = new DOMParser().parseFromString(source, "text/html");
  const projectPaths = new Set<string>();
  for (const element of document.querySelectorAll("img[src], iframe[src]")) {
    const projectPath = htmlPreviewProjectPath(element.getAttribute("src") ?? "", path);
    const inlined = element.localName === "img" || projectPath?.toLocaleLowerCase().endsWith(".html");
    if (projectPath && inlined) projectPaths.add(projectPath);
  }
  return projectPaths;
}

/**
 * The sandboxed srcdoc for an authored HTML file: project resources inlined,
 * relative links disabled, and bridge scripts for scrolling and zoom, since the
 * opaque-origin frame is otherwise unreachable from the host.
 */
function buildPreviewDocument(source: string, path: string, resources: Map<string, string>, relativeLinkTitle: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  const resourceAt = (src: string) => {
    const projectPath = htmlPreviewProjectPath(src, path);
    return projectPath ? resources.get(projectPath) : undefined;
  };
  const inject = (parent: HTMLElement, tag: "style" | "script", name: string, text: string) => {
    const element = document.createElement(tag);
    element.dataset.latticePreview = name;
    element.textContent = text;
    parent.append(element);
  };
  for (const image of document.querySelectorAll<HTMLImageElement>("img[src]")) {
    const dataUrl = resourceAt(image.getAttribute("src") ?? "");
    if (dataUrl) image.setAttribute("src", dataUrl);
  }
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[src]")) {
    const frameSource = frame.getAttribute("src") ?? "";
    const dataUrl = resourceAt(frameSource);
    const embeddedHtml = htmlSourceFromDataUrl(frameSource) ?? (dataUrl ? htmlSourceFromDataUrl(dataUrl) : null);
    if (embeddedHtml == null) continue;
    frame.removeAttribute("src");
    frame.srcdoc = embeddedHtml;
    // The outer preview is already opaque-origin sandboxed. Reassert the
    // boundary on authored child frames so they cannot opt themselves into
    // same-origin access while retaining interactive Plotly scripts.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const base of document.querySelectorAll("base")) base.remove();
  const isolatedBase = document.createElement("base");
  isolatedBase.href = "about:blank";
  document.head.prepend(isolatedBase);
  inject(document.head, "style", "scrollbar", HTML_PREVIEW_SCROLLBAR_STYLES);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(href)) continue;
    link.removeAttribute("href");
    if (!link.title) link.title = relativeLinkTitle;
  }
  inject(document.body, "script", "fragment-navigation", `document.addEventListener("click",(event)=>{const link=event.target instanceof Element?event.target.closest("a[href]"):null;if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const href=link.getAttribute("href");if(!href)return;if(/^(?:https?:|mailto:)/i.test(href)){event.preventDefault();parent.postMessage({type:${JSON.stringify(HTML_PREVIEW_OPEN_EXTERNAL)},href},"*");return}if(href==="#"||!href.startsWith("#"))return;let id;try{id=decodeURIComponent(href.slice(1))}catch{return}const target=document.getElementById(id);if(!target)return;event.preventDefault();target.scrollIntoView()});`);
  inject(document.body, "script", "scrollbar-bridge", `(()=>{const type=${JSON.stringify(HTML_PREVIEW_SCROLL)};const scrollType=${JSON.stringify(HTML_PREVIEW_SET_SCROLL_TOP)};const zoomType=${JSON.stringify(HTML_PREVIEW_SET_ZOOM)};let frame=0;const send=()=>{frame=0;const root=document.scrollingElement||document.documentElement;parent.postMessage({type,clientHeight:root.clientHeight,scrollHeight:root.scrollHeight,scrollTop:root.scrollTop},"*")};const schedule=()=>{if(!frame)frame=requestAnimationFrame(send)};window.addEventListener("scroll",schedule,{passive:true});window.addEventListener("resize",schedule,{passive:true});window.addEventListener("message",(event)=>{if(event.source!==parent||!event.data)return;const root=document.scrollingElement||document.documentElement;if(event.data.type===scrollType&&typeof event.data.scrollTop==="number")root.scrollTop=event.data.scrollTop;else if(event.data.type===zoomType&&typeof event.data.scale==="number"&&event.data.scale>0)document.documentElement.style.zoom=String(event.data.scale);else return;schedule()});new ResizeObserver(schedule).observe(document.documentElement);new ResizeObserver(schedule).observe(document.body);new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true});schedule()})();`);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

type ScrollMetrics = { clientHeight: number; scrollHeight: number; scrollTop: number };

function isScrollReport(data: object): data is ScrollMetrics {
  const { clientHeight, scrollHeight, scrollTop } = data as Partial<Record<keyof ScrollMetrics, unknown>>;
  return typeof clientHeight === "number" && typeof scrollHeight === "number" && typeof scrollTop === "number";
}

/** A sandboxed live preview of a project HTML file, with Lattice's own zoom and scrollbar. */
export function HtmlPreview({ path, source, assetRevision = 0, sourceEditorView, initialViewState, onViewState, onLoadAsset }: {
  path: string;
  source: string;
  assetRevision?: number;
  sourceEditorView?: EditorView | null;
  initialViewState?: HtmlFileViewState;
  onViewState?: (state: HtmlFileViewState) => void;
  onLoadAsset?: (path: string) => Promise<string | null>;
}) {
  const { t } = useLingui();
  const [previewSource, setPreviewSource] = useState(source);
  const [loadedProjectResources, setLoadedProjectResources] = useState<Map<string, string>>(() => new Map());
  const [scrollMetrics, setScrollMetrics] = useState({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
  const scrollMetricsRef = useRef(scrollMetrics);
  const [scrollbarHovering, setScrollbarHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [scale, updateScale] = useZoomScale(initialViewState?.scale ?? 1, HTML_PREVIEW_MIN_SCALE, HTML_PREVIEW_MAX_SCALE);
  const scaleRef = useRef(scale);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onViewStateRef = useRef(onViewState);
  const initialScrollTop = initialViewState?.scrollTop ?? 0;
  // Republishing srcDoc reloads the frame at the top; carry the reading position across.
  const restoreScrollTopRef = useRef(initialScrollTop);
  const scrollRangeRef = useRef(initialViewState?.scrollRange ?? 0);
  const awaitingInitialRestoreRef = useRef(initialScrollTop > 0);
  const dragRef = useRef<{ pointerId: number; scrollPerPixel: number; startClientY: number; startScrollTop: number } | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const scrollGeometry = useMemo(() => calculateVerticalScrollGeometry(scrollMetrics), [scrollMetrics]);

  useLayoutEffect(() => {
    scrollMetricsRef.current = scrollMetrics;
    scaleRef.current = scale;
    onViewStateRef.current = onViewState;
  }, [onViewState, scale, scrollMetrics]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewSource(source), 180);
    return () => window.clearTimeout(timer);
  }, [source]);

  useEffect(() => {
    if (!onLoadAsset) return;
    const projectPaths = referencedProjectResources(previewSource, path);
    if (!projectPaths.size) return;
    let cancelled = false;
    for (const projectPath of projectPaths) {
      void onLoadAsset(projectPath).then((dataUrl) => {
        if (cancelled || !dataUrl) return;
        setLoadedProjectResources((current) => current.get(projectPath) === dataUrl ? current : new Map(current).set(projectPath, dataUrl));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [assetRevision, onLoadAsset, path, previewSource]);

  useEffect(() => {
    let scrollingTimer: ReturnType<typeof setTimeout> | undefined;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === HTML_PREVIEW_SCROLL && isScrollReport(data)) {
        setScrollMetrics({ clientHeight: data.clientHeight, scrollHeight: data.scrollHeight, scrollTop: data.scrollTop });
        // A reloaded frame reports 0 before the restore lands; keep the last
        // real position so the restore has something to aim at.
        if (data.scrollTop > 0 || data.scrollHeight <= data.clientHeight) awaitingInitialRestoreRef.current = false;
        if (!awaitingInitialRestoreRef.current) {
          restoreScrollTopRef.current = data.scrollTop;
          scrollRangeRef.current = scrollRange(data);
          onViewStateRef.current?.({ scale: scaleRef.current, scrollTop: data.scrollTop, scrollRange: scrollRangeRef.current });
        }
        setScrolling(true);
        clearTimeout(scrollingTimer);
        scrollingTimer = setTimeout(() => setScrolling(false), 500);
        return;
      }
      if (data.type !== HTML_PREVIEW_OPEN_EXTERNAL || !("href" in data) || typeof data.href !== "string") return;
      let url: URL;
      try {
        url = new URL(data.href);
      } catch {
        return;
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
      void openUrl(url).catch(() => undefined);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      clearTimeout(scrollingTimer);
      const range = scrollRange(scrollMetricsRef.current);
      onViewStateRef.current?.({ scale: scaleRef.current, scrollTop: restoreScrollTopRef.current, scrollRange: range });
    };
  }, []);

  const html = useMemo(
    () => buildPreviewDocument(previewSource, path, loadedProjectResources, t`Relative project links are unavailable in this preview`),
    [loadedProjectResources, path, previewSource, t],
  );

  const postToFrame = useCallback((message: object) => frameRef.current?.contentWindow?.postMessage(message, "*"), []);
  const setScrollTop = useCallback((scrollTop: number) => postToFrame({ type: HTML_PREVIEW_SET_SCROLL_TOP, scrollTop }), [postToFrame]);

  useEffect(() => {
    if (!sourceEditorView) return;
    const scroller = sourceEditorView.scrollDOM;
    let frame = 0;
    const followSource = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const sourceRange = scrollRange(scroller);
        const previewRange = scrollRange(scrollMetricsRef.current);
        if (sourceRange <= 0 || previewRange <= 0) return;
        setScrollTop(previewRange * clamp(scroller.scrollTop / sourceRange, 0, 1));
      });
    };
    scroller.addEventListener("scroll", followSource, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", followSource);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [setScrollTop, sourceEditorView]);

  useEffect(() => {
    postToFrame({ type: HTML_PREVIEW_SET_ZOOM, scale });
    onViewStateRef.current?.({ scale, scrollTop: restoreScrollTopRef.current, scrollRange: scrollRangeRef.current });
  }, [postToFrame, scale]);

  // The track insets both ends, and the thumb travels what remains of it.
  const thumbTravel = Math.max(0, Math.max(0, scrollGeometry.height - EXTERNAL_SCROLLBAR_TRACK_INSET * 2) - scrollGeometry.thumbHeight);
  const endScrollbarDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setScrolling(false);
  };

  useNonPassiveWheel(scrollbarRef, (event) => {
    if (!scrollGeometry.overflow) return;
    event.preventDefault();
    setScrollTop(scrollGeometry.scrollTop + event.deltaY);
  });

  return (
    <div className="html-preview" data-tour="document-preview">
      <iframe
        ref={frameRef}
        className="html-preview-frame"
        title={t({ message: `HTML preview for ${{ path }}` })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={html}
        onLoad={() => {
          postToFrame({ type: HTML_PREVIEW_SET_ZOOM, scale: scaleRef.current });
          if (restoreScrollTopRef.current > 0) setScrollTop(restoreScrollTopRef.current);
        }}
      />
      <ZoomControls
        className="asset-preview-zoom-controls html-preview-zoom-controls"
        groupLabel={t`HTML zoom controls`}
        scale={scale}
        min={HTML_PREVIEW_MIN_SCALE}
        max={HTML_PREVIEW_MAX_SCALE}
        onScale={updateScale}
        inputLabel={t`HTML zoom percentage`}
      />
      <div
        ref={scrollbarRef}
        aria-hidden="true"
        className="lattice-scrollbar html-preview-scrollbar"
        data-hovering={scrollbarHovering ? "" : undefined}
        data-orientation="vertical"
        data-overflow-y-end={scrollGeometry.overflow && scrollGeometry.scrollTop < scrollGeometry.maxScrollTop ? "" : undefined}
        data-overflow-y-start={scrollGeometry.overflow && scrollGeometry.scrollTop > 0 ? "" : undefined}
        data-scrolling={scrolling ? "" : undefined}
        onPointerCancel={endScrollbarDrag}
        onPointerDown={(event) => {
          if (!scrollGeometry.overflow) return;
          event.preventDefault();
          const isThumb = event.target instanceof HTMLElement && event.target.dataset.slot === "scroll-area-thumb";
          if (!isThumb && thumbTravel > 0) {
            const rect = event.currentTarget.getBoundingClientRect();
            const thumbOffset = clamp(event.clientY - rect.top - EXTERNAL_SCROLLBAR_TRACK_INSET - scrollGeometry.thumbHeight / 2, 0, thumbTravel);
            setScrollTop(scrollGeometry.maxScrollTop * (thumbOffset / thumbTravel));
          }
          dragRef.current = {
            pointerId: event.pointerId,
            scrollPerPixel: thumbTravel > 0 ? scrollGeometry.maxScrollTop / thumbTravel : 0,
            startClientY: event.clientY,
            startScrollTop: scrollGeometry.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setScrolling(true);
        }}
        onPointerEnter={() => setScrollbarHovering(true)}
        onPointerLeave={() => {
          setScrollbarHovering(false);
          if (!dragRef.current) setScrolling(false);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setScrollTop(drag.startScrollTop + (event.clientY - drag.startClientY) * drag.scrollPerPixel);
        }}
        onPointerUp={endScrollbarDrag}
        style={{ height: scrollGeometry.height }}
      >
        <div
          className="lattice-scrollbar-thumb"
          data-slot="scroll-area-thumb"
          style={{ height: scrollGeometry.thumbHeight, transform: `translate3d(-2px, ${scrollGeometry.thumbOffset}px, 0)` }}
        />
      </div>
    </div>
  );
}
