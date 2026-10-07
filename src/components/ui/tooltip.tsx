import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import "./chrome.css"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

const Tooltip = TooltipPrimitive.Root

function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // A new tooltip opens immediately while traversing a toolbar. Keep
          // the entrance motion (`.ui-tooltip-content`, chrome.css) only while
          // open. Closed content must compute to no animation so Radix
          // unmounts it immediately instead of leaving the previous label
          // underneath the next one.
          "ui-tooltip-content z-[var(--z-tooltip)] w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md bg-popover px-2.5 py-1.5 text-[length:var(--type-body-compact-size)] leading-[var(--type-body-compact-line-height)] text-balance text-popover-foreground [box-shadow:var(--elevation-popover)]",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
