/*
 * Adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original files: packages/app/src/editor/extensions/tag-suggestion.ts,
 * packages/app/src/editor/tag-suggestion/TagSuggestionMenu.tsx.
 * Modified 2026-08-04 for Research Writer's workspace index (synchronous,
 * no `/api/tags` fetch), popup/aria conventions from
 * visual-wiki-link-suggestion.tsx, and English-only strings.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { Hash } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MarkdownWorkspaceIndex, TagSummaryEntry } from "./markdown-workspace-index";
import { INLINE_TAG_VALUE_RE } from "./open-knowledge-core/markdown/tag-promotion.ts";
import { suggestionAllow } from "@ok-app/editor/extensions/suggestion-allow";

const MAX_ITEMS = 8;

/** Shared with the tag extension's Backspace/Delete handlers, which must not fire while the typeahead is open. */
export const tagSuggestionKey = new PluginKey("visualTagSuggestion");

export type TagSuggestionItem =
  | { kind: "tag"; value: string; count: number; isLeaf: boolean }
  | { kind: "create"; value: string };

/**
 * Custom `findSuggestionMatch` for `@tiptap/suggestion`. Triggers on
 * `#` at start-of-block or after whitespace, with optional valid
 * tag-name body. Returns null otherwise — including for `# ` (heading
 * shortcut) and `abc#foo` (mid-word). Mirrors the inline boundary rule
 * in core's `tag-promotion.ts`.
 *
 * Pure function — exported for unit testing the boundary semantics
 * without a live editor.
 */
export function tagMatcher(config: {
  $position: ResolvedPos;
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const { $position } = config;
  const textBefore = $position.parent.textBetween(0, $position.parentOffset, undefined, "\uFFFC");

  // Match `(boundary)#(body)` at end-of-input. Boundary is start-of-text
  // OR a whitespace / atom-leaf (`\uFFFC` is the object-replacement char
  // `textBetween` substitutes for inline atoms). Body is empty (just
  // typed `#`) OR a valid tag-name continuation.
  //
  // The trailing space disqualifier is implicit: a space after `#`
  // wouldn't be captured by `[\w/-]*` and would push `$` past the body
  // group, failing the match. That's the heading-shortcut guard.
  const match = textBefore.match(/(^|[\s\uFFFC])#([a-zA-Z][\w/-]*)?$/);
  if (!match) return null;

  const query = match[2] ?? "";
  const blockStart = $position.start();
  // Position of the `#`. The boundary char (whitespace or atom) is at
  // index `match.index`; the `#` is one char after when boundary is a
  // real char, OR at index 0 when boundary is start-of-text (match[1]
  // is empty).
  const boundaryLen = match[1].length;
  const hashOffset = (match.index ?? 0) + boundaryLen;
  const triggerPos = blockStart + hashOffset;

  return {
    range: { from: triggerPos, to: $position.pos },
    query,
    text: `#${query}`,
  };
}

/**
 * Filter: case-insensitive substring match against the trimmed query
 * (empty query returns every tag). Tags themselves stay case-sensitive.
 *
 * Sort (descending priority):
 *   1. Tags whose name STARTS WITH the query come before substring-
 *      only matches.
 *   2. Within each tier, higher `count` wins.
 *   3. Tiebreak by alphabetical name.
 *
 * Returns a NEW sorted array — input is never mutated.
 */
export function rankTagsByQuery(
  tags: readonly TagSummaryEntry[],
  query: string,
): TagSummaryEntry[] {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const filtered =
    trimmed === "" ? tags.slice() : tags.filter((t) => t.name.toLowerCase().includes(lower));
  filtered.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

/**
 * Rank tags via `rankTagsByQuery`, cap at MAX_ITEMS for the floating
 * popover's limited vertical space, and append a "create new tag"
 * affordance (below the existing-tag matches) when the query is a
 * valid tag name not yet in the index.
 *
 * The "create" check uses the FULL tag list (case-sensitive equality)
 * — `Project` and `project` are distinct in the index, so offering
 * "Create #Project" when `project` exists is correct.
 */
export function buildTagSuggestionItems(
  tags: readonly TagSummaryEntry[],
  query: string,
): TagSuggestionItem[] {
  const ranked = rankTagsByQuery(tags, query);
  const items: TagSuggestionItem[] = ranked.slice(0, MAX_ITEMS).map((t) => ({
    kind: "tag",
    value: t.name,
    count: t.count,
    isLeaf: t.isLeaf,
  }));

  const trimmed = query.trim();
  if (trimmed && INLINE_TAG_VALUE_RE.test(trimmed) && !tags.some((t) => t.name === trimmed)) {
    items.push({ kind: "create", value: trimmed });
  }

  return items;
}

type MenuProps = {
  items: TagSuggestionItem[];
  query: string;
  selectedIndex: number;
  idBase: string;
  onSelect: (item: TagSuggestionItem) => void;
  onHoverIndex: (index: number) => void;
};

export function VisualTagSuggestionMenu({
  items,
  query,
  selectedIndex,
  idBase,
  onSelect,
  onHoverIndex,
}: MenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!items.length) {
    const trimmed = query.trim();
    return (
      <div className="visual-tag-menu" role="status" aria-live="polite" onMouseDown={(event) => event.preventDefault()}>
        <div className="visual-tag-menu-empty">
          {trimmed
            ? `No tags match "${trimmed}". Continue typing to create one.`
            : "No tags yet. Continue typing to create one."}
        </div>
      </div>
    );
  }
  const selected = items[selectedIndex];
  return (
    <div ref={containerRef} id={idBase} role="listbox" aria-label="Tag suggestions" aria-activedescendant={`${idBase}-option-${selectedIndex}`} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} className="visual-tag-menu">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {selected?.kind === "create"
          ? `Create new tag #${selected.value}`
          : selected
            ? `Tag #${selected.value}, ${selected.count} ${selected.count === 1 ? "use" : "uses"}`
            : ""}
      </span>
      {items.map((item, index) => {
        const active = index === selectedIndex;
        const isCreate = item.kind === "create";
        return (
          <button key={isCreate ? `create:${item.value}` : `tag:${item.value}`} id={`${idBase}-option-${index}`} data-index={index} type="button" role="option" aria-selected={active} className="visual-tag-menu-item" onMouseDown={(event) => { event.preventDefault(); onSelect(item); }} onPointerMove={() => onHoverIndex(index)}>
            <span className="visual-tag-menu-hash" aria-hidden="true"><Hash /></span>
            <span className="visual-tag-menu-name">{item.value}</span>
            {isCreate ? (
              <span className="visual-tag-menu-badge">New</span>
            ) : (
              <span className="visual-tag-menu-count">{item.count}</span>
            )}
          </button>
        );
      })}
      {items.length >= MAX_ITEMS && <div className="visual-tag-menu-footer">Showing top {items.length} — keep typing to narrow</div>}
    </div>
  );
}

/**
 * Build the `#` typeahead plugin for the tag extension. Sister to
 * `visualWikiLinkSuggestion` — same lifecycle, same popup positioning,
 * same aria wiring on the editor DOM. Items are read synchronously
 * from the workspace index (no network fetch), so there is no loading
 * state; each `#` session re-reads `tagSummaries()` per keystroke.
 */
export function configureVisualTagSuggestion(
  editor: Editor,
  getIndex: () => MarkdownWorkspaceIndex | null,
) {
  return Suggestion<TagSuggestionItem>({
    editor,
    pluginKey: tagSuggestionKey,
    char: "#",
    // null lets the custom matcher decide. The default `[' ']`
    // allowedPrefixes wouldn't trigger at start-of-paragraph; our
    // matcher handles that case explicitly.
    allowedPrefixes: null,
    findSuggestionMatch: tagMatcher,
    // Source-mode and literal-text refusals, shared with the slash
    // picker. See suggestion-allow.ts.
    allow: suggestionAllow,

    items: ({ query }) => {
      const index = getIndex();
      return buildTagSuggestionItems(index?.tagSummaries() ?? [], query);
    },

    command: ({ editor, range, props: item }) => {
      try {
        const value = item.value;
        if (!value || !INLINE_TAG_VALUE_RE.test(value)) return;
        // Replace `#query` (the trigger range) with the `tag` atom.
        // Append a trailing space so the cursor moves cleanly past
        // the atom — mirrors slash-command insertion ergonomics.
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({ type: "tag", attrs: { value } })
          .insertContent(" ")
          .run();
      } catch (err) {
        console.error("[tag-suggestion] command failed", { item, range }, err);
      }
    },

    render: () => {
      const menuId = `visual-tag-${Math.random().toString(36).slice(2)}`;
      let renderer: ReactRenderer | null = null;
      let currentProps: SuggestionProps<TagSuggestionItem> | null = null;
      let selectedIndex = 0;
      let stopPositioning: (() => void) | null = null;
      let popup: HTMLDivElement | null = null;
      const rerender = () =>
        renderer?.updateProps({
          items: currentProps?.items ?? [],
          query: currentProps?.query ?? "",
          selectedIndex,
          idBase: menuId,
          onSelect: currentProps?.command,
          onHoverIndex: (index: number) => {
            selectedIndex = index;
            rerender();
          },
        });
      const position = () => {
        if (!popup?.isConnected || !currentProps) return;
        const virtualElement = {
          getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(),
          contextElement: currentProps.editor.view.dom,
        };
        void computePosition(virtualElement, popup, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [
            offset(6),
            flip(),
            shift({ padding: 8 }),
            size({
              apply({ availableHeight }) {
                popup?.style.setProperty(
                  "--visual-menu-height",
                  `${Math.min(availableHeight, window.innerHeight * 0.5)}px`,
                );
              },
            }),
          ],
        }).then(({ x, y }) => {
          if (!popup?.isConnected) return;
          popup.style.left = `${x}px`;
          popup.style.top = `${y}px`;
          popup.style.visibility = "visible";
        });
      };
      return {
        onStart(props: SuggestionProps<TagSuggestionItem>) {
          currentProps = props;
          selectedIndex = 0;
          const dom = props.editor.view.dom;
          dom.setAttribute("role", "combobox");
          dom.setAttribute("aria-expanded", "true");
          dom.setAttribute("aria-haspopup", "listbox");
          dom.setAttribute("aria-controls", menuId);
          if (props.items.length) dom.setAttribute("aria-activedescendant", `${menuId}-option-0`);
          popup = document.createElement("div");
          popup.className = "visual-tag-popup";
          popup.style.visibility = "hidden";
          document.body.appendChild(popup);
          renderer = new ReactRenderer(VisualTagSuggestionMenu, {
            editor: props.editor,
            props: {
              items: props.items,
              query: props.query,
              selectedIndex,
              idBase: menuId,
              onSelect: props.command,
              onHoverIndex: (index: number) => {
                selectedIndex = index;
                rerender();
              },
            },
          });
          popup.appendChild(renderer.element);
          const virtualElement = {
            getBoundingClientRect: () => currentProps?.clientRect?.() ?? new DOMRect(),
            contextElement: dom,
          };
          stopPositioning = autoUpdate(virtualElement, popup, position);
          position();
        },
        onUpdate(props: SuggestionProps<TagSuggestionItem>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
          if (props.items.length) {
            props.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`);
          } else {
            props.editor.view.dom.removeAttribute("aria-activedescendant");
          }
          rerender();
          position();
        },
        onKeyDown({ event }: SuggestionKeyDownProps) {
          const items = currentProps?.items ?? [];
          if (event.key === "Escape") return false;
          if (event.key === "ArrowDown") {
            if (!items.length) return false;
            selectedIndex = (selectedIndex + 1) % items.length;
          } else if (event.key === "ArrowUp") {
            if (!items.length) return false;
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          } else if (event.key === "Enter" || event.key === "Tab") {
            const item = items[selectedIndex];
            if (item) {
              currentProps?.command(item);
              return true;
            }
            // No item selected — fall back to inserting the typed
            // query as a new tag IF it parses. Otherwise let the
            // event propagate (e.g. Tab continues default behavior).
            const trimmed = (currentProps?.query ?? "").trim();
            if (trimmed && INLINE_TAG_VALUE_RE.test(trimmed)) {
              currentProps?.command({ kind: "create", value: trimmed });
              return true;
            }
            return false;
          } else {
            return false;
          }
          currentProps?.editor.view.dom.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`);
          rerender();
          return true;
        },
        onExit() {
          const dom = currentProps?.editor.view.dom;
          dom?.setAttribute("role", "textbox");
          dom?.removeAttribute("aria-expanded");
          dom?.removeAttribute("aria-haspopup");
          dom?.removeAttribute("aria-controls");
          dom?.removeAttribute("aria-activedescendant");
          stopPositioning?.();
          stopPositioning = null;
          renderer?.destroy();
          renderer = null;
          popup?.remove();
          popup = null;
          currentProps = null;
          selectedIndex = 0;
        },
      };
    },
  });
}
