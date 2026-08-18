/*
 * Popup plumbing (ReactRenderer + floating-ui positioning, combobox ARIA
 * wiring) adapted from visual-wiki-link-suggestion.tsx, itself adapted from
 * inkeep/open-knowledge at commit 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { Extension, type AnyExtension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { BookOpen } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PaperSummary } from "../../app-types";
import { paperLinkHref } from "../../papers/paper-link";

const MAX_ITEMS = 8;
const suggestionKey = new PluginKey("visualPaperCitationSuggestion");

/** Every whitespace-separated token must match title, citation key, or id. */
export function matchPapers(papers: readonly PaperSummary[], query: string): PaperSummary[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return papers
    .filter((paper) => (paper.hasFullText || paper.hasBlog) && paper.arxivId)
    .filter((paper) => {
      const haystack = `${paper.title} ${paper.citationKey ?? ""} ${paper.arxivId}`.toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    })
    .slice(0, MAX_ITEMS);
}

function paperSubtitle(paper: PaperSummary): string {
  return [paper.citationKey, paper.arxivId ? `arXiv ${paper.arxivId}` : null]
    .filter(Boolean)
    .join(" · ");
}

type MenuProps = {
  items: PaperSummary[];
  selectedIndex: number;
  idBase: string;
  onSelect: (item: PaperSummary) => void;
  onHoverIndex: (index: number) => void;
};

function VisualPaperCitationMenu({ items, selectedIndex, idBase, onSelect, onHoverIndex }: MenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!items.length) {
    return (
      <div className="w-80 max-w-[min(28rem,90vw)] rounded-lg border bg-popover p-2 text-sm text-muted-foreground shadow-md" role="status" aria-live="polite" onMouseDown={(event) => event.preventDefault()}>
        No matching papers — import them in the Papers panel first
      </div>
    );
  }
  return (
    <div ref={containerRef} id={idBase} role="listbox" aria-label="Paper citation suggestions" aria-activedescendant={`${idBase}-option-${selectedIndex}`} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} className="w-80 max-w-[min(28rem,90vw)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-md" style={{ maxHeight: "var(--visual-menu-height, 40vh)" }}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{items[selectedIndex]?.title}</span>
      {items.map((item, index) => {
        const active = index === selectedIndex;
        const subtitle = paperSubtitle(item);
        return (
          <button key={item.arxivId} id={`${idBase}-option-${index}`} data-index={index} type="button" role="option" aria-selected={active} onMouseEnter={() => onHoverIndex(index)} onMouseDown={(event) => { event.preventDefault(); onSelect(item); }} className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-accent text-accent-foreground" : ""}`}>
            <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.title}</span>
              {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
            </span>
          </button>
        );
      })}
      {items.length >= MAX_ITEMS && <div className="mt-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">Showing top {items.length} — keep typing to narrow</div>}
    </div>
  );
}

/**
 * `@` typeahead over the downloaded paper library. Selecting a paper inserts
 * a plain markdown link to its cached markdown — the same
 * `.research/papers/<id>/…` path shape the agent library announces — which
 * the host routes to the Papers reading view on click.
 */
export function visualPaperCitationSuggestion(options: {
  getPapers: () => readonly PaperSummary[];
  getActivePath: () => string;
}): AnyExtension {
  return Extension.create({
    name: "visualPaperCitationSuggestion",
    addProseMirrorPlugins() {
      return [Suggestion<PaperSummary>({
        editor: this.editor,
        pluginKey: suggestionKey,
        char: "@",
        allowSpaces: true,
        items: ({ query }) => matchPapers(options.getPapers(), query),
        command: ({ editor, range, props: paper }) => {
          editor.chain().focus().deleteRange(range).insertContent([
            {
              type: "text",
              text: paper.title,
              marks: [{ type: "link", attrs: { href: paperLinkHref(options.getActivePath(), paper) } }],
            },
            { type: "text", text: " " },
          ]).run();
        },
        render: () => {
          const menuId = `visual-paper-citation-${Math.random().toString(36).slice(2)}`;
          let renderer: ReactRenderer | null = null;
          let currentProps: SuggestionProps<PaperSummary> | null = null;
          let selectedIndex = 0;
          let stopPositioning: (() => void) | null = null;
          let popup: HTMLDivElement | null = null;
          const rerender = () => renderer?.updateProps({ items: currentProps?.items ?? [], selectedIndex, idBase: menuId, onSelect: currentProps?.command, onHoverIndex: (index: number) => { selectedIndex = index; rerender(); } });
          const position = () => {
            if (!popup?.isConnected || !currentProps) return;
            const virtualElement = { getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(), contextElement: currentProps.editor.view.dom };
            void computePosition(virtualElement, popup, { strategy: "fixed", placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 }), size({ apply({ availableHeight }) { popup?.style.setProperty("--visual-menu-height", `${Math.min(availableHeight, window.innerHeight * 0.5)}px`); } })] }).then(({ x, y }) => { if (!popup?.isConnected) return; popup.style.left = `${x}px`; popup.style.top = `${y}px`; popup.style.visibility = "visible"; });
          };
          return {
            onStart(props: SuggestionProps<PaperSummary>) {
              currentProps = props; selectedIndex = 0;
              const dom = props.editor.view.dom; dom.setAttribute("role", "combobox"); dom.setAttribute("aria-expanded", "true"); dom.setAttribute("aria-haspopup", "listbox"); dom.setAttribute("aria-controls", menuId); if (props.items.length) dom.setAttribute("aria-activedescendant", `${menuId}-option-0`);
              popup = document.createElement("div"); popup.className = "visual-paper-citation-popup"; popup.style.visibility = "hidden"; document.body.appendChild(popup);
              renderer = new ReactRenderer(VisualPaperCitationMenu, { editor: props.editor, props: { items: props.items, selectedIndex, idBase: menuId, onSelect: props.command, onHoverIndex: (index: number) => { selectedIndex = index; rerender(); } } }); popup.appendChild(renderer.element);
              const virtualElement = { getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(), contextElement: dom }; stopPositioning = autoUpdate(virtualElement, popup, position); position();
            },
            onUpdate(props: SuggestionProps<PaperSummary>) { currentProps = props; selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1)); if (props.items.length) props.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`); else props.editor.view.dom.removeAttribute("aria-activedescendant"); rerender(); position(); },
            onKeyDown({ event }: SuggestionKeyDownProps) { const items = currentProps?.items ?? []; if (event.key === "Escape" || !items.length) return false; if (event.key === "ArrowDown") selectedIndex = (selectedIndex + 1) % items.length; else if (event.key === "ArrowUp") selectedIndex = (selectedIndex - 1 + items.length) % items.length; else if (event.key === "Enter" || event.key === "Tab") currentProps?.command(items[selectedIndex]); else return false; currentProps?.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`); rerender(); return true; },
            onExit() { const dom = currentProps?.editor.view.dom; dom?.setAttribute("role", "textbox"); dom?.removeAttribute("aria-expanded"); dom?.removeAttribute("aria-haspopup"); dom?.removeAttribute("aria-controls"); dom?.removeAttribute("aria-activedescendant"); stopPositioning?.(); stopPositioning = null; renderer?.destroy(); renderer = null; popup?.remove(); popup = null; currentProps = null; },
          };
        },
      })];
    },
  });
}
