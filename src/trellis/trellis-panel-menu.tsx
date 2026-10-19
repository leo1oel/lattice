/**
 * Panel menus drawn with Lattice's own menu surface (portaled, so they are
 * not clipped to the workspace), instead of Trellis's built-in menu.
 */
import { useEffect, useRef } from "react";
import type { MenuEntry, MenuRequest } from "@danfessler/trellis-react";
// Panel menus open at the pointer and have submenus, so they build on the
// primitive rather than the shared DropdownMenuContent; they take the same
// surface, fluid hover included.
// eslint-disable-next-line no-restricted-imports -- see above
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { floatingSurfaceClassName, keepFocusOnClose, menuItemClassName, menuViewportClassName } from "@/components/ui/menu-surface";
import { popupMotionClassName } from "@/components/ui/popup-motion";
import { FluidHoverSurface } from "@/components/ui/fluid-hover-surface";
import { MENU_ICONS } from "./trellis-icons";

function MenuEntries({ entries, onRun }: { entries: readonly MenuEntry[]; onRun: () => void }) {
  // A check column only when something in this list can be checked.
  const checks = entries.some((entry) => entry !== "separator" && entry.checked !== undefined);
  return (
    <>
      {entries.map((entry, index) => {
        if (entry === "separator") {
          return <MenuPrimitive.Separator key={`separator-${index}`} className="-mx-1 my-1 h-px bg-border" />;
        }
        if (entry.items?.length) {
          return (
            <MenuPrimitive.Sub key={entry.id ?? entry.label}>
              <MenuPrimitive.SubTrigger className={cn(menuItemClassName, "data-[state=open]:bg-accent")} disabled={entry.disabled}>
                {checks && <span className="trellis-menu-check" />}
                {entry.id && MENU_ICONS[entry.id]}
                <span className="flex-1 truncate">{entry.label}</span>
                <ChevronRight className="ml-auto" />
              </MenuPrimitive.SubTrigger>
              <MenuPrimitive.Portal>
                <MenuPrimitive.SubContent
                  sideOffset={4}
                  className={cn(floatingSurfaceClassName, menuViewportClassName, "fluid-hover-surface min-w-[10rem]", popupMotionClassName)}
                >
                  <FluidHoverSurface />
                  <MenuEntries entries={entry.items} onRun={onRun} />
                </MenuPrimitive.SubContent>
              </MenuPrimitive.Portal>
            </MenuPrimitive.Sub>
          );
        }
        return (
          <MenuPrimitive.Item
            key={entry.id ?? entry.label}
            className={menuItemClassName}
            data-variant={entry.danger ? "destructive" : "default"}
            disabled={entry.disabled}
            onPointerLeave={keepFocusOnClose}
            onSelect={() => {
              onRun();
              entry.run?.();
            }}
          >
            {checks && <span className="trellis-menu-check">{entry.checked && <Check />}</span>}
            {entry.id && MENU_ICONS[entry.id]}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.shortcut && <span className="trellis-menu-shortcut">{entry.shortcut}</span>}
          </MenuPrimitive.Item>
        );
      })}
    </>
  );
}

export function PanelMenu({ request, open, onDismiss, onClose }: {
  request: MenuRequest;
  open: boolean;
  onDismiss: () => void;
  onClose: () => void;
}) {
  // Closing plays the shared exit (`.popup-motion[data-state="closed"]`) and
  // drops the request when it ends: unmounting the menu with its owner would
  // cut it. With no exit to play, Radix has already removed the content, so the
  // request goes at once. A new request opens at once, even over one leaving.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open && !content.current) onClose();
  }, [open, onClose]);
  return (
    <MenuPrimitive.Root open={open} modal={false} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <MenuPrimitive.Trigger asChild>
        <span aria-hidden="true" style={{ position: "fixed", left: request.x, top: request.y, width: 0, height: 0 }} />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={request.align}
          side="bottom"
          sideOffset={4}
          className={cn(floatingSurfaceClassName, menuViewportClassName, "fluid-hover-surface min-w-[12rem] max-w-[20rem]", popupMotionClassName)}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // A press on the button the menu opened from is that button's: its
          // click closes the menu (openMenu). Dismissed here too, the menu
          // would close on the press and open again on the click.
          onInteractOutside={(event) => {
            if (event.target instanceof Node && request.anchor?.contains(event.target)) event.preventDefault();
          }}
          ref={content}
          onAnimationEnd={(event) => {
            if (!open && event.target === event.currentTarget) onClose();
          }}
        >
          <FluidHoverSurface />
          <MenuEntries entries={request.entries} onRun={onDismiss} />
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
