import { cn } from "./utils/cn";

export type SpiralLoaderProps = {
  size?: number;
  className?: string;
};

export function SpiralLoader({ size = 16, className }: SpiralLoaderProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 animate-spin rounded-full border-2 border-an-foreground-subtle/35 border-t-an-foreground-muted", className)}
      style={{ width: size, height: size }}
    />
  );
}
