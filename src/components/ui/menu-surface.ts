/**
 * Visual contracts shared by Radix menu-like primitives.
 *
 * Focus management and portal behavior stay with each Radix primitive; these
 * constants only unify surface geometry, typography, and item states.
 */
export const floatingSurfaceClassName =
  "z-50 rounded-[var(--radius-surface)] border bg-popover text-popover-foreground shadow-lg outline-hidden";

export const menuViewportClassName =
  "overflow-x-hidden overflow-y-auto p-1.5";

export const menuItemClassName =
  "relative flex cursor-default items-center gap-2.5 rounded-[var(--radius-icon)] px-2.5 py-1.5 text-[length:var(--type-body-size)] leading-[var(--type-body-line-height)] font-normal outline-hidden select-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!";
