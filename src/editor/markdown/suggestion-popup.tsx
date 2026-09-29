/*
 * Popup plumbing shared by the `[[` wiki-link and `@` paper-citation menus,
 * adapted from inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Original file: packages/app/src/editor/extensions/wiki-link-suggestion.ts.
 * Modified 2026-08-04 for Research Writer's design tokens and dependencies.
 * Licensed under GPL-3.0-or-later.
 */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useRef, type ComponentType, type MouseEvent } from "react";
import { element } from "../dom-utils";

export type SuggestionMenuProps<Item> = {
  items: Item[];
  query: string;
  selectedIndex: number;
  idBase: string;
  onSelect: (item: Item) => void;
  onHoverIndex: (index: number) => void;
};

export const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

/** Keeps the keyboard-selected option scrolled into the menu viewport. */
export function useSelectedOptionScroll(selectedIndex: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);
  return containerRef;
}

export const listboxProps = ({ idBase, selectedIndex }: Pick<SuggestionMenuProps<unknown>, "idBase" | "selectedIndex">, label: string) => ({
  id: idBase,
  role: "listbox",
  "aria-label": label,
  // eslint-disable-next-line lingui/no-unlocalized-strings -- element id reference
  "aria-activedescendant": `${idBase}-option-${selectedIndex}`,
  tabIndex: -1,
  style: { maxHeight: "var(--visual-menu-height, 40vh)" },
});

export function optionProps<Item>(
  { idBase, selectedIndex, onSelect, onHoverIndex }: SuggestionMenuProps<Item>,
  item: Item,
  index: number,
) {
  return {
    id: `${idBase}-option-${index}`,
    "data-index": index,
    type: "button" as const,
    role: "option",
    "aria-selected": index === selectedIndex,
    onMouseEnter: () => onHoverIndex(index),
    onMouseDown: (event: MouseEvent) => {
      event.preventDefault();
      onSelect(item);
    },
  };
}

/**
 * TipTap Suggestion `render` for a body-level listbox: combobox ARIA on the
 * editor surface, floating-ui placement under the trigger, and arrow keys plus
 * Enter/Tab selection. The editor keeps focus; the menu never takes it.
 */
export function suggestionPopupRenderer<Item>(
  idPrefix: string,
  popupClassName: string,
  Menu: ComponentType<SuggestionMenuProps<Item>>,
) {
  return () => {
    const menuId = `${idPrefix}-${Math.random().toString(36).slice(2)}`;
    let current: SuggestionProps<Item> | null = null;
    let renderer: ReactRenderer<unknown, SuggestionMenuProps<Item>> | null = null;
    let popup: HTMLDivElement | null = null;
    let stopPositioning: (() => void) | null = null;
    let selectedIndex = 0;

    const menuProps = (): SuggestionMenuProps<Item> => ({
      items: current?.items ?? [],
      query: current?.query ?? "",
      selectedIndex,
      idBase: menuId,
      onSelect: (item) => current?.command(item),
      onHoverIndex: (index) => {
        selectedIndex = index;
        renderer?.updateProps(menuProps());
      },
    });
    const syncActiveDescendant = () => {
      const dom = current?.editor.view.dom;
      if (current?.items.length) dom?.setAttribute("aria-activedescendant", `${menuId}-option-${selectedIndex}`);
      else dom?.removeAttribute("aria-activedescendant");
    };
    const anchor = () => ({
      getBoundingClientRect: () => current?.clientRect?.() ?? new DOMRect(),
      contextElement: current?.editor.view.dom,
    });
    const position = () => {
      if (!popup?.isConnected || !current) return;
      void computePosition(anchor(), popup, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [offset(6), flip(), shift({ padding: 8 }), size({
          apply({ availableHeight }) {
            popup?.style.setProperty("--visual-menu-height", `${Math.min(availableHeight, window.innerHeight * 0.5)}px`);
          },
        })],
      }).then(({ x, y }) => {
        if (!popup?.isConnected) return;
        Object.assign(popup.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    };

    return {
      onStart(props: SuggestionProps<Item>) {
        current = props;
        selectedIndex = 0;
        const comboboxAttributes = { role: "combobox", "aria-expanded": "true", "aria-haspopup": "listbox", "aria-controls": menuId };
        for (const [name, value] of Object.entries(comboboxAttributes)) props.editor.view.dom.setAttribute(name, value);
        syncActiveDescendant();
        popup = element("div", popupClassName);
        popup.style.visibility = "hidden";
        document.body.appendChild(popup);
        renderer = new ReactRenderer(Menu, { editor: props.editor, props: menuProps() });
        popup.appendChild(renderer.element);
        stopPositioning = autoUpdate(anchor(), popup, position);
        position();
      },
      onUpdate(props: SuggestionProps<Item>) {
        // @tiptap/suggestion sends a loading pass with empty items before
        // every result, even for synchronous items. Keep the current menu.
        if (props.loading) return;
        current = props;
        selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
        syncActiveDescendant();
        renderer?.updateProps(menuProps());
        position();
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        const items = current?.items ?? [];
        if (event.key === "Escape" || !items.length) return false;
        if (event.key === "ArrowDown") selectedIndex = (selectedIndex + 1) % items.length;
        else if (event.key === "ArrowUp") selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        else if (event.key === "Enter" || event.key === "Tab") current?.command(items[selectedIndex]);
        else return false;
        syncActiveDescendant();
        renderer?.updateProps(menuProps());
        return true;
      },
      onExit() {
        const dom = current?.editor.view.dom;
        dom?.setAttribute("role", "textbox");
        for (const name of ["aria-expanded", "aria-haspopup", "aria-controls", "aria-activedescendant"]) {
          dom?.removeAttribute(name);
        }
        stopPositioning?.();
        renderer?.destroy();
        popup?.remove();
        stopPositioning = renderer = popup = current = null;
      },
    };
  };
}
