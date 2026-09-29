import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { floatingSurfaceClassName, menuItemClassName, menuViewportClassName } from "./menu-surface"
import { popupMotionClassName } from "./popup-motion"
import { FluidHoverSurface } from "./fluid-hover-surface"

const DropdownMenu = DropdownMenuPrimitive.Root

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  children,
  container,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /** Where the menu mounts; a floating toolbar keeps its menu inside itself so focus in the menu stays "inside" it. */
  container?: HTMLElement | null
}) {
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          floatingSurfaceClassName,
          menuViewportClassName,
          "fluid-hover-surface",
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-[9rem] origin-(--radix-dropdown-menu-content-transform-origin)",
          popupMotionClassName,
          className
        )}
        {...props}
      >
        <FluidHoverSurface />
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant="default"
      className={cn(menuItemClassName, className)}
      {...props}
    />
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(
        "px-2 py-1.5 text-[length:var(--type-label-size)] leading-[var(--type-label-line-height)] font-[var(--type-label-weight)]",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
}
