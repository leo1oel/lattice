import { FileText, PenLine, Layers, Library, GitBranch, Sparkles } from "lucide-react";
import { cn } from "../ui";

/** A CSS-rendered mock of the Lattice window: LaTeX source beside the compiled PDF. */
export function AppMockup({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-[0_30px_80px_-40px_rgba(23,23,26,0.45)]",
        className,
      )}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-border bg-background/60 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs font-medium text-subtle">thesis.tex — Lattice</span>
      </div>

      <div className="grid grid-cols-[52px_1fr_1fr] text-[11px] md:grid-cols-[64px_1fr_1fr]">
        {/* Activity rail */}
        <div className="flex flex-col items-center gap-4 border-r border-border bg-background/50 py-5">
          {[FileText, PenLine, Layers, Library, GitBranch].map((Icon, i) => (
            <span
              key={i}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg",
                i === 0 ? "bg-accent-soft text-accent-strong" : "text-subtle",
              )}
            >
              <Icon size={16} />
            </span>
          ))}
          <span className="mt-auto flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Sparkles size={16} />
          </span>
        </div>

        {/* Source pane */}
        <div className="border-r border-border p-4 font-mono leading-relaxed text-muted">
          <Line n={1}>
            <span className="text-accent-strong">\section</span>
            {"{Introduction}"}
          </Line>
          <Line n={2} />
          <Line n={3}>Lattice keeps writing, reading and</Line>
          <Line n={4}>thinking in one place. We show that</Line>
          <Line n={5}>
            <span className="text-accent-strong">\cite</span>
            {"{knuth1984}"} composition improves.
          </Line>
          <Line n={6} />
          <Line n={7}>
            <span className="text-accent-strong">\begin</span>
            {"{equation}"}
          </Line>
          <Line n={8}>
            {"  E = mc^2 + "}
            <span className="text-accent-strong">\nabla</span>
            {" \\Phi"}
          </Line>
          <Line n={9}>
            <span className="text-accent-strong">\end</span>
            {"{equation}"}
          </Line>
        </div>

        {/* PDF preview pane */}
        <div className="bg-background/40 p-4">
          <div className="mx-auto max-w-[220px] rounded-md border border-border bg-surface p-5 shadow-sm">
            <div className="mb-3 h-2 w-2/3 rounded bg-foreground/80" />
            <div className="space-y-1.5">
              <div className="h-1.5 w-full rounded bg-border-strong" />
              <div className="h-1.5 w-11/12 rounded bg-border-strong" />
              <div className="h-1.5 w-full rounded bg-border-strong" />
              <div className="h-1.5 w-4/5 rounded bg-border-strong" />
            </div>
            <div className="my-3 rounded bg-accent-soft px-3 py-2 text-center font-serif text-[13px] text-accent-strong">
              E = mc² + ∇Φ
            </div>
            <div className="space-y-1.5">
              <div className="h-1.5 w-full rounded bg-border-strong" />
              <div className="h-1.5 w-10/12 rounded bg-border-strong" />
              <div className="h-1.5 w-full rounded bg-border-strong" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ n, children }: { n: number; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-4 shrink-0 select-none text-right text-subtle/70">{n}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}
