import type { ReactNode, ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs));
}

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-6", className)}>{children}</div>;
}

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";

const buttonVariants = {
  primary: "bg-foreground text-background hover:bg-foreground/90",
  accent: "bg-accent text-accent-foreground hover:bg-accent-strong",
  outline: "border border-border-strong bg-surface text-foreground hover:border-foreground/40",
  ghost: "text-muted hover:text-foreground",
} as const;

const buttonSizes = {
  sm: "h-9 px-4",
  md: "h-11 px-6",
  lg: "h-12 px-7 text-[0.95rem]",
} as const;

type Variant = keyof typeof buttonVariants;
type Size = keyof typeof buttonSizes;

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)} {...props} />
  );
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size }) {
  return (
    <a className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], className)} {...props} />
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-subtle">
      {children}
    </span>
  );
}
