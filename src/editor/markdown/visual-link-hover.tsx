/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/link-preview/external-link-preview.ts,
 * packages/app/src/editor/link-preview/use-external-link-preview.ts,
 * packages/app/src/editor/link-preview/ExternalLinkPreviewCard.tsx.
 * Modified 2026-08-04 for Research Writer's Tauri link-preview command,
 * vendored schema, and TipTap delegated hover popup.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type LinkPreviewMetadata,
  LinkPreviewResponseSchema,
} from "../../open-knowledge-core/schemas/api/link-preview.ts";
import { element, listen } from "../dom-utils";
import { openVisualLinkInsert } from "./visual-slash-items";

// Match OpenKnowledge InteractionLayer's hover timings.
const DWELL_MS = 300;
const LEAVE_GRACE_MS = 150;

/** Success-cache bound; exported so the eviction test stays in sync. */
export const SUCCESS_CACHE_MAX_ENTRIES = 128;

const successCache = new Map<string, LinkPreviewMetadata>();
const inflight = new Map<string, Promise<LinkPreviewMetadata | null>>();

/**
 * Load preview metadata for an external URL, or `null` on any failure, guard
 * rejection, or abort. Successful results are cached (LRU) and requests coalesce.
 */
export function loadLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreviewMetadata | null> {
  const cached = successCache.get(url);
  if (cached) {
    successCache.delete(url);
    successCache.set(url, cached);
    return Promise.resolve(cached);
  }
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result: unknown = await invoke("link_preview", { url });
      // Tauri invoke cannot cancel the command, but an obsolete hover must not
      // use or cache metadata that arrives after its caller aborts.
      const parsed = LinkPreviewResponseSchema.safeParse(result);
      if (signal?.aborted || !parsed.success || !parsed.data.ok) return null;
      successCache.set(url, parsed.data.metadata);
      if (successCache.size > SUCCESS_CACHE_MAX_ENTRIES) successCache.delete(successCache.keys().next().value!);
      return parsed.data.metadata;
    } catch (error) {
      // Command errors are recoverable: nothing is cached, so a later hover
      // retries instead of making a transient failure sticky.
      console.warn("[link-preview] external preview command failed:", error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

/** Reset module state so isolated tests never inherit another test's cache. */
export function clearLinkPreviewCaches() {
  successCache.clear();
  inflight.clear();
}

function useExternalLinkPreview(url: string) {
  const enabled = /^https?:\/\//i.test(url);
  // Bind metadata to its URL because the hover panel can be reused for another
  // link before the previous asynchronous command resolves.
  const [entry, setEntry] = useState<{ url: string; metadata: LinkPreviewMetadata } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadLinkPreview(url, controller.signal).then((metadata) => {
      if (!controller.signal.aborted && metadata) setEntry({ url, metadata });
    });
    return () => controller.abort();
  }, [url, enabled]);
  return enabled && entry?.url === url ? entry.metadata : null;
}

export function ExternalLinkPreviewCard({ metadata }: { metadata: LinkPreviewMetadata }) {
  const faviconSrc = metadata.faviconDataUri?.startsWith("data:image/") ? metadata.faviconDataUri : null;
  return (
    <div className="mt-2.5 border-t border-border/70 pt-2.5">
      <div className="flex items-center gap-1.5">
        {faviconSrc && <img src={faviconSrc} alt="" aria-hidden="true" width={16} height={16} className="size-4 shrink-0 rounded-sm" />}
        <span className="truncate text-xs font-medium text-muted-foreground">{metadata.domain}</span>
      </div>
      {metadata.title && <div className="mt-1 line-clamp-2 text-sm font-medium text-foreground">{metadata.title}</div>}
      {metadata.description && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{metadata.description}</p>}
    </div>
  );
}

function LinkPreviewPanel({ url, onEdit }: { url: string; onEdit: () => void }) {
  const { t } = useLingui();
  const metadata = useExternalLinkPreview(url);
  return (
    <div className="visual-link-hover-panel rounded-md border border-border bg-popover p-2 text-foreground shadow-md">
      <div className="visual-link-hover-header">
        <div className="truncate font-mono text-xs text-muted-foreground">{url}</div>
        <button type="button" aria-label={t`Edit link`} onClick={onEdit}><Pencil aria-hidden="true" /></button>
      </div>
      {metadata && <ExternalLinkPreviewCard metadata={metadata} />}
    </div>
  );
}

function linkAnchor(target: EventTarget | null, root: HTMLElement): HTMLAnchorElement | null {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  // Wiki-link chips render as anchors but are not link marks — the hover
  // card's Edit action opens the link popover, which makes no sense for them.
  if (!anchor || !root.contains(anchor) || anchor.matches(".wiki-link, [data-wiki-link]") || anchor.closest("[data-wiki-link]")) return null;
  return anchor;
}

export const VisualLinkHover = Extension.create({
  name: "visualLinkHover",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey("visualLinkHover"),
      view(view) {
        let dwellTimer: ReturnType<typeof setTimeout> | undefined;
        let leaveTimer: ReturnType<typeof setTimeout> | undefined;
        let anchor: HTMLAnchorElement | null = null;
        let popup: HTMLDivElement | null = null;
        let renderer: ReactRenderer | null = null;
        let stopPositioning: (() => void) | null = null;

        const close = () => {
          clearTimeout(dwellTimer);
          clearTimeout(leaveTimer);
          stopPositioning?.();
          renderer?.destroy();
          popup?.remove();
          stopPositioning = renderer = popup = anchor = null;
        };
        const scheduleClose = () => {
          clearTimeout(leaveTimer);
          leaveTimer = setTimeout(close, LEAVE_GRACE_MS);
        };
        const edit = (target: HTMLAnchorElement) => {
          const from = view.posAtDOM(target, 0);
          const to = view.posAtDOM(target, target.childNodes.length);
          if (to <= from) return;
          const selection = view.state.doc.nodeAt(from)?.type.name === "paperCitation"
            ? NodeSelection.create(view.state.doc, from)
            : TextSelection.create(view.state.doc, from, to);
          view.dispatch(view.state.tr.setSelection(selection));
          openVisualLinkInsert(editor);
        };
        const open = (target: HTMLAnchorElement) => {
          const url = target.getAttribute("href");
          if (anchor !== target || !url || document.querySelector(".visual-slash-menu-popup")) return;
          const panel = element("div", "visual-link-preview-popup");
          popup = panel;
          panel.setAttribute("data-ok-vendor", "");
          panel.style.visibility = "hidden";
          panel.addEventListener("mouseenter", () => clearTimeout(leaveTimer));
          panel.addEventListener("mouseleave", scheduleClose);
          panel.addEventListener("mousedown", (event) => event.preventDefault());
          document.body.appendChild(panel);
          renderer = new ReactRenderer(LinkPreviewPanel, { editor, props: { url, onEdit: () => edit(target) } });
          panel.appendChild(renderer.element);
          const position = () => computePosition(target, panel, {
            placement: "top-start", strategy: "fixed", middleware: [offset(6), flip(), shift({ padding: 8 })],
          }).then(({ x, y }) => {
            Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
          });
          stopPositioning = autoUpdate(target, panel, position);
          void position();
        };
        const mouseover = (event: MouseEvent) => {
          const target = linkAnchor(event.target, view.dom);
          if (!target || target === anchor) return;
          close();
          anchor = target;
          dwellTimer = setTimeout(() => open(target), DWELL_MS);
        };
        const mouseout = (event: MouseEvent) => {
          if (!anchor || !anchor.contains(event.target as Node)) return;
          const next = event.relatedTarget;
          if (next instanceof Node && (anchor.contains(next) || popup?.contains(next))) return;
          scheduleClose();
        };
        const stops = [
          listen(view.dom, [["mouseover", mouseover], ["mouseout", mouseout], ["blur", close, true]]),
          listen(document, [["scroll", close, true], ["click", close]]),
        ];
        return {
          destroy() {
            close();
            stops.forEach((stop) => stop());
          },
        };
      },
    })];
  },
});
