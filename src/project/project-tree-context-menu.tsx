import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuOpenContext } from "@pierre/trees";
import type { LucideIcon } from "lucide-react";
import { ContextMenuContent, ContextMenuItem } from "../components/ui/context-menu";
import { DestructiveButton } from "../components/ui/destructive-button";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

/** One project-tree menu entry; `checked` makes it a checkbox item. */
export type MenuAction = { icon: LucideIcon; label: string; run: () => void; checked?: boolean; disabled?: boolean };

const menuItemRole = (action: MenuAction) => action.checked === undefined
  ? { role: "menuitem" }
  : { role: "menuitemcheckbox", "aria-checked": action.checked };

/** Waits out the menu's close and focus restoration, which would blur a new rename input. */
function afterMenuClose(action: () => void) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(action);
  });
}

const VIEWPORT_INSET = 8;

/** The row menu Pierre asks for through `renderContextMenu`. */
export function ProjectTreeItemMenu(props: {
  context: ContextMenuOpenContext;
  actions: MenuAction[];
  destructive: { label: string; run: () => void } | null;
}) {
  const { destructive } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const closeThen = (action: () => void) => {
    props.context.close({ restoreFocus: false });
    afterMenuClose(action);
  };
  const menuLeft = props.context.anchorRect.right + 4;
  const menuTop = props.context.anchorRect.top;
  // Keep the whole menu on screen, re-measured after every render.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_INSET, window.innerWidth - bounds.width - VIEWPORT_INSET);
    const maxTop = Math.max(VIEWPORT_INSET, window.innerHeight - bounds.height - VIEWPORT_INSET);
    menu.style.left = `${Math.min(Math.max(VIEWPORT_INSET, menuLeft), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(VIEWPORT_INSET, menuTop), maxTop)}px`;
  });
  // Pierre normally mounts this menu inside the tree's Shadow DOM. Portal it
  // out of the sidebar stacking context so older WKWebViews cannot composite
  // the neighbouring editor above the part that extends past the sidebar.
  return createPortal(
    <div
      ref={menuRef}
      className="file-tree-context-menu fluid-hover-surface popup-motion"
      data-file-tree-context-menu-root="true"
      role="menu"
      style={{ left: menuLeft, position: "fixed", top: menuTop, zIndex: "var(--z-radix-popper)" }}
    >
      <FluidHoverSurface />
      {props.actions.map((action) => (
        <button key={action.label} {...menuItemRole(action)} disabled={action.disabled} onClick={() => closeThen(action.run)}>
          <action.icon size={14} />{action.label}
        </button>
      ))}
      {destructive && (
        <DestructiveButton className="destructive" role="menuitem" iconSize={14} onClick={() => closeThen(destructive.run)}>
          {destructive.label}
        </DestructiveButton>
      )}
    </div>,
    document.body,
  );
}

/** The menu for the empty area around the rows. */
export function ProjectTreeBackgroundMenu({ actions }: { actions: MenuAction[] }) {
  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      {actions.map((action) => (
        <ContextMenuItem
          key={action.label}
          {...menuItemRole(action)}
          // Only a creation must wait for the menu to release focus.
          onSelect={action.checked === undefined ? () => afterMenuClose(action.run) : action.run}
        >
          <action.icon size={14} />{action.label}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );
}
