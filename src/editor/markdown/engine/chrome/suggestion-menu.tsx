/**
 * The typeahead menus of the visual engine, one mechanism for all three: the
 * slash menu (spec R-CHR-1), `[[` wiki links (R-INL-6) and `@` citations
 * (R-INL-7). Tiptap's suggestion plugin (MIT) finds the trigger and the query;
 * a small store carries the menu state to a React listbox portalled to the
 * body and placed at the caret.
 *
 * The listbox is the editor's combobox popup: while it has options, the
 * editor surface names it in `aria-controls` and its active option in
 * `aria-activedescendant`; with no match it gives way to a status message and
 * the surface drops both. Hover and the arrow keys move one active option.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the store, the plugin and the listbox form one mechanism */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import { ScrollArea } from "../../../../components/ui/scroll-area";

export type MenuState<T> = {
  open: boolean;
  items: T[];
  active: number;
  query: string;
  rect: DOMRect | null;
  select: (item: T) => void;
};

export type MenuStore<T> = {
  get: () => MenuState<T>;
  set: (next: Partial<MenuState<T>>) => void;
  subscribe: (listener: () => void) => () => void;
  /** Close the menu and leave the typed trigger text in place. */
  dismiss: () => void;
  /** Called by the plugin once it knows its view, so `dismiss` can reach it. */
  installDismiss: (callback: () => void) => void;
};

export function createMenuStore<T>(): MenuStore<T> {
  let state: MenuState<T> = { open: false, items: [], active: 0, query: "", rect: null, select: () => undefined };
  const listeners = new Set<() => void>();
  let dismiss: () => void = () => undefined;
  return {
    get: () => state,
    set: (next) => {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: () => dismiss(),
    installDismiss: (callback) => {
      dismiss = callback;
    },
  };
}

export type SuggestionConfig<T> = {
  name: string;
  char: string;
  store: MenuStore<T>;
  items: (query: string, editor: Editor) => T[];
  onSelect: (editor: Editor, range: Range, item: T) => void;
  allowSpaces?: boolean;
  startOfLine?: boolean;
  /** Characters that may sit right before the trigger (default: start of text or whitespace). */
  allowedPrefixes?: string[] | null;
  allow?: (editor: Editor, range: Range) => boolean;
};

/** An editor extension that runs one typeahead menu through `store`. */
export function suggestionExtension<T>(config: SuggestionConfig<T>) {
  const key = new PluginKey(config.name);
  return Extension.create({
    name: config.name,
    addProseMirrorPlugins() {
      const store = config.store;
      const editor = this.editor;
      store.installDismiss(() => {
        exitSuggestion(editor.view, key);
        store.set({ open: false, items: [] });
      });
      return [Suggestion<T, T>({
        editor,
        pluginKey: key,
        char: config.char,
        allowSpaces: config.allowSpaces ?? false,
        startOfLine: config.startOfLine ?? false,
        allowedPrefixes: config.allowedPrefixes === undefined ? [" "] : config.allowedPrefixes,
        allow: ({ editor: current, range }) => current.isEditable && (config.allow?.(current, range) ?? true),
        items: ({ query, editor: current }) => config.items(query, current),
        command: ({ editor: current, range, props }) => config.onSelect(current, range, props),
        render: () => {
          const update = (props: { items: T[]; query: string; clientRect?: (() => DOMRect | null) | null; command: (item: T) => void }) => {
            const previous = store.get();
            store.set({
              open: true,
              items: props.items,
              query: props.query,
              active: previous.open && previous.query === props.query ? Math.min(previous.active, Math.max(props.items.length - 1, 0)) : 0,
              rect: props.clientRect?.() ?? null,
              select: props.command,
            });
          };
          return {
            onStart: update,
            onUpdate: update,
            onExit: () => store.set({ open: false, items: [], query: "" }),
            onKeyDown: ({ event }) => {
              // The Enter that commits an IME candidate is not a choice.
              if (event.isComposing || event.keyCode === 229) return false;
              const state = store.get();
              if (!state.open) return false;
              if (event.key === "Escape") {
                store.dismiss();
                return true;
              }
              if (!state.items.length) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                store.set({ active: (state.active + step + state.items.length) % state.items.length });
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                const item = state.items[state.active];
                if (item === undefined) return false;
                state.select(item);
                return true;
              }
              return false;
            },
          };
        },
      })];
    },
  });
}

/** The menu's live state. */
function useMenuState<T>(store: MenuStore<T>): MenuState<T> {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Place `element` below the caret rectangle, flipping above when there is no room. */
function usePlacement(element: HTMLElement | null, rect: DOMRect | null) {
  useLayoutEffect(() => {
    if (!element || !rect) return;
    const reference = { getBoundingClientRect: () => rect };
    let cancelled = false;
    void computePosition(reference, element, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (cancelled) return;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });
    return () => {
      cancelled = true;
    };
  }, [element, rect]);
}

export type SuggestionListboxProps<T> = {
  editor: Editor;
  store: MenuStore<T>;
  label: string;
  emptyLabel: string;
  itemKey: (item: T) => string;
  renderItem: (item: T, active: boolean) => ReactNode;
  /** Group heading shown before an item when it differs from the previous item's. */
  groupOf?: (item: T) => string;
  /** A panel beside the list describing the active item. */
  preview?: (item: T) => ReactNode;
  className?: string;
};

/** The floating listbox for one typeahead menu. */
export function SuggestionListbox<T>({ editor, store, label, emptyLabel, itemKey, renderItem, groupOf, preview, className }: SuggestionListboxProps<T>) {
  const state = useMenuState(store);
  const id = useId().replace(/:/g, "");
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  usePlacement(element, state.open ? state.rect : null);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a DOM id
  const optionId = (index: number) => `${id}-option-${index}`;
  const hasItems = state.open && state.items.length > 0;

  // The surface is the combobox: it names the listbox and its active option only while they exist.
  useEffect(() => {
    const surface = editor.isDestroyed ? null : editor.view.dom;
    if (!surface) return;
    if (hasItems) {
      surface.setAttribute("aria-controls", `${id}-listbox`);
      surface.setAttribute("aria-activedescendant", optionId(state.active));
    } else {
      surface.removeAttribute("aria-controls");
      surface.removeAttribute("aria-activedescendant");
    }
    return () => {
      surface.removeAttribute("aria-controls");
      surface.removeAttribute("aria-activedescendant");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, hasItems, id, state.active]);

  // Keyboard moves keep the active option in view; hover never scrolls.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    list.current?.querySelector(`#${optionId(state.active)}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") moved.current = true;
    };
    const surface = editor.view.dom;
    surface.addEventListener("keydown", onKey, true);
    return () => surface.removeEventListener("keydown", onKey, true);
  }, [editor]);

  if (!state.open) return null;
  const active = state.items[state.active];
  return createPortal(
    <div ref={setElement} className={`lx-md-menu ${className ?? ""}`} style={{ position: "fixed", left: 0, top: 0 }} onMouseDown={(event) => event.preventDefault()}>
      {hasItems
        ? (
          <>
            <ScrollArea className="lx-md-menu-scroll" viewportRef={list} viewportProps={{ role: "listbox", id: `${id}-listbox`, "aria-label": label, tabIndex: -1 } as never}>
              {state.items.map((item, index) => {
                const group = groupOf?.(item);
                const previousGroup = index > 0 ? groupOf?.(state.items[index - 1]!) : undefined;
                return (
                  <div key={itemKey(item)} role="presentation">
                    {group && group !== previousGroup && <div className="lx-md-menu-group" role="presentation">{group}</div>}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === state.active}
                      className="lx-md-menu-option"
                      onMouseEnter={() => store.set({ active: index })}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        state.select(item);
                      }}
                    >
                      {renderItem(item, index === state.active)}
                    </div>
                  </div>
                );
              })}
            </ScrollArea>
            {preview && active !== undefined && <aside className="lx-md-menu-preview">{preview(active)}</aside>}
          </>
        )
        : <div className="lx-md-menu-empty" role="status">{emptyLabel}</div>}
    </div>,
    document.body,
  );
}
