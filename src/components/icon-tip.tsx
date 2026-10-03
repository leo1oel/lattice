import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** True when the element already has visible text among its direct children. */
function hasTextChild(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => typeof child === "string" || typeof child === "number");
}

type TipProps = {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
};

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
export function Tip({ label, side = "bottom", children }: TipProps) {
  if (!label) return children;
  return <LabeledTip label={label} side={side}>{children}</LabeledTip>;
}

function LabeledTip({ label, side, children }: TipProps) {
  // A menu or popover trigger reports its open popup through aria-expanded.
  // The tooltip sits on a higher layer than menus, so it stays shut while the
  // popup is open — hovering back onto the trigger would otherwise lay it over
  // the popup's first items — and gives way when the popup opens under it
  // without taking focus or a click (a shortcut, a programmatic open).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const popupOpen = () => triggerRef.current?.getAttribute("aria-expanded") === "true";
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const observer = new MutationObserver(() => {
      if (trigger.getAttribute("aria-expanded") === "true") setOpen(false);
    });
    observer.observe(trigger, { attributes: true, attributeFilter: ["aria-expanded"] });
    return () => observer.disconnect();
  }, [open]);

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
      <Tooltip open={open} onOpenChange={(next) => setOpen(next && !popupOpen())}>
        <TooltipTrigger ref={triggerRef} asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} className="font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
