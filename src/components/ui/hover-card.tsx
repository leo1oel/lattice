import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { floatingSurfaceClassName } from "./menu-surface"
import { popupMotionClassName } from "./popup-motion"

/**
 * A card a control shows while the pointer rests on it or it has keyboard
 * focus: more than a tooltip can say, and nothing the control's own
 * accessible name and description leave out (Radix keeps the card itself out
 * of the accessibility tree).
 */
const HoverCard = HoverCardPrimitive.Root

function HoverCardTrigger(props: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          floatingSurfaceClassName,
          "max-w-(--radix-hover-card-content-available-width) origin-(--radix-hover-card-content-transform-origin)",
          popupMotionClassName,
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
