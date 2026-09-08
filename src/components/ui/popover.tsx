import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { floatingSurfaceClassName } from "./menu-surface"
import { popupMotionClassName } from "./popup-motion"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
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
          "w-72 origin-(--radix-popover-content-transform-origin) p-4",
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
  PopoverTrigger,
  PopoverContent,
}
