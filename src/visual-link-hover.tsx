/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/link-preview/use-external-link-preview.ts,
 * packages/app/src/editor/link-preview/ExternalLinkPreviewCard.tsx.
 * Modified 2026-08-04 for Research Writer's TipTap delegated hover popup.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Pencil } from "lucide-react";
import { ExternalLinkPreviewCard, useExternalLinkPreview } from "./visual-link-preview-card.tsx";

// Match OpenKnowledge InteractionLayer's hover timings.
const DWELL_MS = 300;
const LEAVE_GRACE_MS = 150;
const VISUAL_LINK_INSERT_EVENT = "research-writer:visual-link-insert";

function LinkPreviewPanel({ url, onEdit }: { url: string; onEdit: () => void }) {
  const metadata = useExternalLinkPreview({ url, enabled: /^https?:\/\//i.test(url) });
  return (
    <div className="visual-link-hover-panel rounded-md border border-border bg-popover p-2 text-foreground shadow-md">
      <div className="visual-link-hover-header">
        <div className="truncate font-mono text-xs text-muted-foreground">{url}</div>
        <button type="button" aria-label="Edit link" onClick={onEdit}>
          <Pencil aria-hidden="true" />
        </button>
      </div>
      {metadata ? <ExternalLinkPreviewCard metadata={metadata} /> : null}
    </div>
  );
}

function linkAnchor(target: EventTarget | null, root: HTMLElement): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor || !root.contains(anchor)) return null;
  // Wiki-link chips and tag atoms render as anchors but are not link
  // marks — the hover card's Edit action opens the LINK popover, which
  // makes no sense for either (a tag's href is `#tag/{value}` chrome).
  if (anchor.matches(".wiki-link, [data-wiki-link], [data-tag]") || anchor.closest("[data-wiki-link]")) return null;
  return anchor;
}

export const VisualLinkHover = Extension.create({
  name: "visualLinkHover",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey("visualLinkHover"),
      view(view) {
        let dwellTimer: ReturnType<typeof setTimeout> | null = null;
        let leaveTimer: ReturnType<typeof setTimeout> | null = null;
        let anchor: HTMLAnchorElement | null = null;
        let popup: HTMLDivElement | null = null;
        let renderer: ReactRenderer | null = null;
        let stopPositioning: (() => void) | null = null;

        const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
          if (timer) clearTimeout(timer);
        };
        const close = () => {
          clearTimer(dwellTimer);
          clearTimer(leaveTimer);
          dwellTimer = leaveTimer = null;
          stopPositioning?.();
          stopPositioning = null;
          renderer?.destroy();
          renderer = null;
          popup?.remove();
          popup = null;
          anchor = null;
        };
        const scheduleClose = () => {
          clearTimer(leaveTimer);
          leaveTimer = setTimeout(close, LEAVE_GRACE_MS);
        };
        const open = (target: HTMLAnchorElement) => {
          if (anchor !== target || document.querySelector(".visual-slash-menu-popup")) return;
          const url = target.getAttribute("href");
          if (!url) return;
          popup = document.createElement("div");
          popup.className = "visual-link-preview-popup";
          popup.setAttribute("data-ok-vendor", "");
          popup.style.visibility = "hidden";
          popup.addEventListener("mouseenter", () => clearTimer(leaveTimer));
          popup.addEventListener("mouseleave", scheduleClose);
          popup.addEventListener("mousedown", (event) => event.preventDefault());
          document.body.appendChild(popup);
          const edit = () => {
            const from = view.posAtDOM(target, 0);
            const to = view.posAtDOM(target, target.childNodes.length);
            if (to <= from) return;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
            window.dispatchEvent(new CustomEvent(VISUAL_LINK_INSERT_EVENT, { detail: { editor } }));
          };
          renderer = new ReactRenderer(LinkPreviewPanel, { editor, props: { url, onEdit: edit } });
          popup.appendChild(renderer.element);
          const position = () => computePosition(target, popup!, {
            placement: "top-start", strategy: "fixed", middleware: [offset(6), flip(), shift({ padding: 8 })],
          }).then(({ x, y }) => {
            if (!popup) return;
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
            popup.style.visibility = "visible";
          });
          stopPositioning = autoUpdate(target, popup, position);
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
        const blur = () => close();
        const scroll = () => close();
        const click = () => close();
        view.dom.addEventListener("mouseover", mouseover);
        view.dom.addEventListener("mouseout", mouseout);
        view.dom.addEventListener("blur", blur, true);
        document.addEventListener("scroll", scroll, true);
        document.addEventListener("click", click);
        return { destroy() {
          close();
          view.dom.removeEventListener("mouseover", mouseover);
          view.dom.removeEventListener("mouseout", mouseout);
          view.dom.removeEventListener("blur", blur, true);
          document.removeEventListener("scroll", scroll, true);
          document.removeEventListener("click", click);
        } };
      },
    })];
  },
});
