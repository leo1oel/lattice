/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/extensions/wiki-link-suggestion.ts,
 * packages/app/src/editor/wiki-link-suggestion/WikiLinkSuggestionMenu.tsx.
 * Modified 2026-08-04 for Research Writer's workspace index, design tokens, and dependencies.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Extension, type AnyExtension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { FilePlus2, FileText } from "lucide-react";
import { i18n } from "../../i18n";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import {
  keepEditorFocus,
  listboxProps,
  optionProps,
  suggestionPopupRenderer,
  useSelectedOptionScroll,
  type SuggestionMenuProps,
} from "./suggestion-popup";

const MAX_ITEMS = 8;
const suggestionKey = new PluginKey("visualWikiLinkSuggestion");

type WikiLinkItem =
  | { kind: "page"; docName: string; title: string }
  | { kind: "create"; docName: string }
  | { kind: "anchor"; docName: string; level: number; text: string; slug: string };

/** `Page#heading` queries list that page's headings; anything else lists pages. */
function anchorQuery(query: string): { page: string; heading: string } | null {
  const hash = query.indexOf("#");
  return hash >= 0 ? { page: query.slice(0, hash), heading: query.slice(hash + 1) } : null;
}

function itemLabel(item: WikiLinkItem | undefined): string | undefined {
  if (item?.kind === "anchor") {
    const { level, text } = item;
    return i18n._(msg`Heading H${level}: ${text}`);
  }
  if (item?.kind !== "create") return item?.title;
  const name = item.docName;
  return i18n._(msg`Create "${name}"`);
}

function VisualWikiLinkMenu(props: SuggestionMenuProps<WikiLinkItem>) {
  const { items, query, selectedIndex } = props;
  const { t } = useLingui();
  const containerRef = useSelectedOptionScroll(selectedIndex);
  const anchor = anchorQuery(query);
  const anchorPage = anchor?.page;
  const count = items.length;

  if (!items.length) {
    return (
      <div className="w-80 max-w-[min(28rem,90vw)] rounded-lg border bg-popover p-2 text-sm text-muted-foreground shadow-md" role="status" aria-live="polite" onMouseDown={keepEditorFocus}>
        {anchor ? t`No headings in ${anchorPage}` : t`No pages found`}
      </div>
    );
  }
  return (
    <div ref={containerRef} {...listboxProps(props, anchor ? t`Heading suggestions` : t`Wiki link suggestions`)} onMouseDown={keepEditorFocus} className="fluid-hover-surface popup-motion w-80 max-w-[min(28rem,90vw)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
      <FluidHoverSurface />
      <span className="sr-only" aria-live="polite" aria-atomic="true">{itemLabel(items[selectedIndex])}</span>
      {anchor && <div className="px-2 py-1 text-[length:var(--type-micro-size)] font-medium uppercase tracking-wide text-muted-foreground">{anchor.page}</div>}
      {items.map((item, index) => {
        const Icon = item.kind === "create" ? FilePlus2 : FileText;
        return (
          <button key={item.kind === "anchor" ? `${item.docName}#${item.slug}` : `${item.kind}:${item.docName}`} {...optionProps(props, item, index)} className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${index === selectedIndex ? "bg-accent text-accent-foreground" : ""}`} style={item.kind === "anchor" ? { paddingLeft: `${(item.level - 1) * 10 + 8}px` } : undefined}>
            {item.kind === "anchor" ? (
              // eslint-disable-next-line lingui/no-unlocalized-strings -- heading level tag (H1–H6)
              <><span className="w-6 shrink-0 font-mono text-[length:var(--type-micro-size)] text-muted-foreground">H{item.level}</span><span className="truncate font-medium">{item.text}</span></>
            ) : (
              <><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-medium">{itemLabel(item)}</span>{item.kind === "page" && item.title !== item.docName && <span className="line-clamp-2 break-all text-xs text-muted-foreground">{item.docName}</span>}</span></>
            )}
          </button>
        );
      })}
      {items.length >= MAX_ITEMS && <div className="mt-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground"><Trans>Showing top {count} — keep typing to narrow</Trans></div>}
    </div>
  );
}

function wikiLinkItems(index: MarkdownWorkspaceIndex, query: string): WikiLinkItem[] {
  const anchor = anchorQuery(query);
  if (anchor) {
    const doc = index.getDoc(anchor.page);
    const needle = anchor.heading.toLowerCase();
    return !doc ? [] : doc.headings
      .filter((heading) => heading.text.toLowerCase().includes(needle))
      .slice(0, MAX_ITEMS)
      .map((heading) => ({ kind: "anchor" as const, docName: doc.docName, ...heading }));
  }
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const pages: WikiLinkItem[] = index.searchPages(query, MAX_ITEMS).map(({ docName, title }) => ({ kind: "page", docName, title }));
  const exists = pages.some((item) => item.kind === "page" && (item.docName.toLowerCase() === needle || item.title.toLowerCase() === needle));
  return trimmed && !exists ? [...pages, { kind: "create", docName: trimmed }] : pages;
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
          return index ? wikiLinkItems(index, query) : [];
        },
        command: ({ editor, range, props: item }) => {
          const attrs = {
            target: item.docName,
            alias: null,
            anchor: item.kind === "anchor" ? item.slug : null,
            resolved: item.kind !== "create",
          };
          editor.chain().focus().deleteRange(range).insertContent([{ type: "wikiLink", attrs }, { type: "text", text: " " }]).run();
        },
        render: suggestionPopupRenderer("visual-wiki-link", "visual-wiki-link-popup", VisualWikiLinkMenu),
      })];
    },
  });
}
