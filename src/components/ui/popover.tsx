import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { floatingSurfaceClassName } from "./menu-surface"
import { popupMotionClassName } from "./popup-motion"

const Popover = PopoverPrimitive.Root

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** Positions the popover against an element other than its trigger. */
function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          floatingSurfaceClassName,
          "w-72 max-w-(--radix-popover-content-available-width) origin-(--radix-popover-content-transform-origin) p-4",
          popupMotionClassName,
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverTrigger,
  PopoverContent,
}
