import { cn } from "../ui";

/** Brand mark: an interlocking lattice grid rendered from the accent color. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        width="26"
        height="26"
        viewBox="0 0 26 26"
        fill="none"
        aria-hidden="true"
        className="text-accent"
      >
        <rect x="1" y="1" width="24" height="24" rx="7" className="fill-foreground" />
        <path
          d="M6 9.5h14M6 13h14M6 16.5h14M9.5 6v14M13 6v14M16.5 6v14"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.9"
        />
      </svg>
      <span className="text-[1.05rem] font-semibold tracking-tight text-foreground">Lattice</span>
    </span>
  );
}
