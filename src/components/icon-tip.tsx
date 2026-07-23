import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** True when the element already has visible text among its direct children. */
function hasTextChild(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => typeof child === "string" || typeof child === "number");
}

/**
 * Wrap a single interactive element with a styled, animated tooltip.
 *
 * The tooltip content is portaled to <body>, so it never collides with the
 * app's own (unlayered) CSS. A Radix tooltip is only a *description*, so for
 * icon-only triggers we also copy a string `label` onto the child as
 * `aria-label` (unless it already names itself) — otherwise dropping the old
 * `title` attribute would leave the button with no accessible name.
 *
 * Pass a falsy `label` to render the child untouched.
 */
export function Tip({
  label,
  side = "bottom",
  sideOffset = 6,
  children,
}: {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  children: ReactElement;
}) {
  if (!label) return children;

  // Only name icon-only triggers: a button with visible text already has an
  // accessible name, and overriding it with the (verbose) tooltip would make
  // its name worse for screen readers.
  let trigger = children;
  if (typeof label === "string" && isValidElement<{ children?: ReactNode; "aria-label"?: unknown; "aria-labelledby"?: unknown }>(children)) {
    const props = children.props;
    const alreadyNamed = props["aria-label"] || props["aria-labelledby"] || hasTextChild(props.children);
    if (!alreadyNamed) {
      trigger = cloneElement(children, { "aria-label": label });
    }
  }

  // Self-contained provider so a Tip works anywhere — in the app tree and in
  // component tests — without depending on a provider being mounted upstream.
  return (
    <TooltipProvider delayDuration={280} skipDelayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset} className="font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
