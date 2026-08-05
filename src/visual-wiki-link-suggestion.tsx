/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/extensions/wiki-link-suggestion.ts,
 * packages/app/src/editor/wiki-link-suggestion/WikiLinkSuggestionMenu.tsx.
 * Modified 2026-08-04 for Research Writer's workspace index, design tokens, and dependencies.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { Extension, type AnyExtension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { FilePlus2, FileText } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";

const MAX_ITEMS = 8;
const suggestionKey = new PluginKey("visualWikiLinkSuggestion");

type WikiLinkItem =
  | { kind: "page"; docName: string; title: string }
  | { kind: "create"; docName: string; actionLabel: string }
  | { kind: "anchor"; docName: string; level: number; text: string; slug: string };

type ParsedQuery =
  | { mode: "page"; pageTarget: ""; anchorQuery: "" }
  | { mode: "anchor"; pageTarget: string; anchorQuery: string };

function parseQuery(query: string): ParsedQuery {
  const hash = query.indexOf("#");
  return hash >= 0
    ? { mode: "anchor", pageTarget: query.slice(0, hash), anchorQuery: query.slice(hash + 1) }
    : { mode: "page", pageTarget: "", anchorQuery: "" };
}

type MenuProps = {
  items: WikiLinkItem[];
  query: string;
  selectedIndex: number;
  idBase: string;
  onSelect: (item: WikiLinkItem) => void;
  onHoverIndex: (index: number) => void;
};

export function VisualWikiLinkMenu({ items, query, selectedIndex, idBase, onSelect, onHoverIndex }: MenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const parsed = parseQuery(query);
  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!items.length) {
    return (
      <div className="w-80 max-w-[min(28rem,90vw)] rounded-lg border bg-popover p-2 text-sm text-muted-foreground shadow-md" role="status" aria-live="polite" onMouseDown={(event) => event.preventDefault()}>
        {parsed.mode === "anchor" ? `No headings in ${parsed.pageTarget}` : "No pages found"}
      </div>
    );
  }
  const selected = items[selectedIndex];
  return (
    <div ref={containerRef} id={idBase} role="listbox" aria-label={parsed.mode === "anchor" ? "Heading suggestions" : "Wiki link suggestions"} aria-activedescendant={`${idBase}-option-${selectedIndex}`} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} className="w-80 max-w-[min(28rem,90vw)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-md" style={{ maxHeight: "var(--visual-menu-height, 40vh)" }}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {selected?.kind === "anchor" ? `Heading H${selected.level}: ${selected.text}` : selected?.kind === "create" ? selected.actionLabel : selected?.title}
      </span>
      {parsed.mode === "anchor" && <div className="px-2 py-1 text-[length:var(--type-micro-size)] font-medium uppercase tracking-wide text-muted-foreground">{parsed.pageTarget}</div>}
      {items.map((item, index) => {
        const active = index === selectedIndex;
        return (
          <button key={item.kind === "anchor" ? `${item.docName}#${item.slug}` : `${item.kind}:${item.docName}`} id={`${idBase}-option-${index}`} data-index={index} type="button" role="option" aria-selected={active} onMouseEnter={() => onHoverIndex(index)} onMouseDown={(event) => { event.preventDefault(); onSelect(item); }} className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${active ? "bg-accent text-accent-foreground" : ""}`} style={item.kind === "anchor" ? { paddingLeft: `${(item.level - 1) * 10 + 8}px` } : undefined}>
            {item.kind === "anchor" ? (
              <><span className="w-6 shrink-0 font-mono text-[length:var(--type-micro-size)] text-muted-foreground">H{item.level}</span><span className="truncate font-medium">{item.text}</span></>
            ) : (
              <>{item.kind === "create" ? <FilePlus2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}<span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-medium">{item.kind === "create" ? item.actionLabel : item.title}</span>{item.kind === "page" && item.title !== item.docName && <span className="line-clamp-2 break-all text-xs text-muted-foreground">{item.docName}</span>}</span></>
            )}
          </button>
        );
      })}
      {items.length >= MAX_ITEMS && <div className="mt-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">Showing top {items.length} — keep typing to narrow</div>}
    </div>
  );
}

export function visualWikiLinkSuggestion(getIndex: () => MarkdownWorkspaceIndex | null): AnyExtension {
  return Extension.create({
    name: "visualWikiLinkSuggestion",
    addProseMirrorPlugins() {
      return [Suggestion<WikiLinkItem>({
        editor: this.editor,
        pluginKey: suggestionKey,
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => {
          const index = getIndex();
          if (!index) return [];
          const parsed = parseQuery(query);
          if (parsed.mode === "anchor") {
            const doc = index.getDoc(parsed.pageTarget);
            if (!doc) return [];
            const needle = parsed.anchorQuery.toLowerCase();
            return index.headingsFor(doc.docName).filter((heading) => heading.text.toLowerCase().includes(needle)).slice(0, MAX_ITEMS).map((heading) => ({ kind: "anchor" as const, docName: doc.docName, ...heading }));
          }
          const trimmed = query.trim();
          const pages: WikiLinkItem[] = index.searchPages(query, MAX_ITEMS).map(({ docName, title }) => ({ kind: "page", docName, title }));
          if (trimmed && !pages.some((item) => item.kind === "page" && (item.docName.toLowerCase() === trimmed.toLowerCase() || item.title.toLowerCase() === trimmed.toLowerCase()))) pages.push({ kind: "create", docName: trimmed, actionLabel: `Create "${trimmed}"` });
          return pages;
        },
        command: ({ editor, range, props: item }) => {
          const attrs = item.kind === "anchor"
            ? { target: item.docName, alias: null, anchor: item.slug, resolved: true }
            : { target: item.docName, alias: null, anchor: null, resolved: item.kind === "page" };
          editor.chain().focus().deleteRange(range).insertContent([{ type: "wikiLink", attrs }, { type: "text", text: " " }]).run();
        },
        render: () => {
          const menuId = `visual-wiki-link-${Math.random().toString(36).slice(2)}`;
          let renderer: ReactRenderer | null = null;
          let currentProps: SuggestionProps<WikiLinkItem> | null = null;
          let selectedIndex = 0;
          let stopPositioning: (() => void) | null = null;
          let popup: HTMLDivElement | null = null;
          const rerender = () => renderer?.updateProps({ items: currentProps?.items ?? [], query: currentProps?.query ?? "", selectedIndex, idBase: menuId, onSelect: currentProps?.command, onHoverIndex: (index: number) => { selectedIndex = index; rerender(); } });
          const position = () => {
            if (!popup?.isConnected || !currentProps) return;
            const virtualElement = { getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(), contextElement: currentProps.editor.view.dom };
            void computePosition(virtualElement, popup, { strategy: "fixed", placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 }), size({ apply({ availableHeight }) { popup?.style.setProperty("--visual-menu-height", `${Math.min(availableHeight, window.innerHeight * 0.5)}px`); } })] }).then(({ x, y }) => { if (!popup?.isConnected) return; popup.style.left = `${x}px`; popup.style.top = `${y}px`; popup.style.visibility = "visible"; });
          };
          return {
            onStart(props: SuggestionProps<WikiLinkItem>) {
              currentProps = props; selectedIndex = 0;
              const dom = props.editor.view.dom; dom.setAttribute("role", "combobox"); dom.setAttribute("aria-expanded", "true"); dom.setAttribute("aria-haspopup", "listbox"); dom.setAttribute("aria-controls", menuId); if (props.items.length) dom.setAttribute("aria-activedescendant", `${menuId}-option-0`);
              popup = document.createElement("div"); popup.className = "visual-wiki-link-popup"; popup.style.visibility = "hidden"; document.body.appendChild(popup);
              renderer = new ReactRenderer(VisualWikiLinkMenu, { editor: props.editor, props: { items: props.items, query: props.query, selectedIndex, idBase: menuId, onSelect: props.command, onHoverIndex: (index: number) => { selectedIndex = index; rerender(); } } }); popup.appendChild(renderer.element);
              const virtualElement = { getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(), contextElement: dom }; stopPositioning = autoUpdate(virtualElement, popup, position); position();
            },
            onUpdate(props: SuggestionProps<WikiLinkItem>) { currentProps = props; selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1)); if (props.items.length) props.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`); else props.editor.view.dom.removeAttribute("aria-activedescendant"); rerender(); position(); },
            onKeyDown({ event }: SuggestionKeyDownProps) { const items = currentProps?.items ?? []; if (event.key === "Escape" || !items.length) return false; if (event.key === "ArrowDown") selectedIndex = (selectedIndex + 1) % items.length; else if (event.key === "ArrowUp") selectedIndex = (selectedIndex - 1 + items.length) % items.length; else if (event.key === "Enter" || event.key === "Tab") currentProps?.command(items[selectedIndex]); else return false; currentProps?.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`); rerender(); return true; },
            onExit() { const dom = currentProps?.editor.view.dom; dom?.setAttribute("role", "textbox"); dom?.removeAttribute("aria-expanded"); dom?.removeAttribute("aria-haspopup"); dom?.removeAttribute("aria-controls"); dom?.removeAttribute("aria-activedescendant"); stopPositioning?.(); stopPositioning = null; renderer?.destroy(); renderer = null; popup?.remove(); popup = null; currentProps = null; },
          };
        },
      })];
    },
  });
}
