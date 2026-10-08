import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { floatingSurfaceClassName, menuItemClassName, menuViewportClassName } from "./menu-surface"
import { popupMotionClassName } from "./popup-motion"
import { FluidHoverSurface } from "./fluid-hover-surface"

const ContextMenu = ContextMenuPrimitive.Root

function ContextMenuTrigger(props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          floatingSurfaceClassName,
          menuViewportClassName,
          "fluid-hover-surface",
          "max-h-(--radix-context-menu-content-available-height) max-w-[min(var(--menu-max-width),var(--radix-context-menu-content-available-width))] min-w-[9rem] origin-(--radix-context-menu-content-transform-origin)",
          popupMotionClassName,
          className
        )}
        {...props}
      >
        <FluidHoverSurface />
        {children}
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(menuItemClassName, className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
}
