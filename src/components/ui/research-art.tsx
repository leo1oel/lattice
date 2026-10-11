import { cn } from "@/lib/utils";
import "./research-art.css";

/*
 * Objects from a research desk, drawn in isometric for the larger empty
 * states (the empty document panel, the first PDF, the empty paper library).
 * They are one monochrome family: line work in the host's tertiary text
 * color over paper in the host's own surface (`--art-paper`), with a few
 * faint tones for the sides. Static on purpose: nothing draws in or moves
 * beside the writing surface. Decorative only: the empty state's text says
 * what it means.
 *
 * The geometry is precomputed (it came from the design board's isometric
 * kit), so a drawing is a flat list of paths in painter's order, and each
 * drawing is its own module, so the PDF's and the library's stay in their
 * lazy chunks.
 */
export type ResearchArtTone = "paper" | "shade" | "shade-mid" | "shade-deep" | "faint" | "line" | "dot";

export type ResearchDrawing = {
  kind: string;
  paths: ReadonlyArray<readonly [ResearchArtTone, string]>;
};

export function ResearchArt({ drawing, className }: { drawing: ResearchDrawing; className?: string }) {
  return (
    <svg
      className={cn("research-art", className)}
      data-kind={drawing.kind}
      viewBox="0 0 160 124"
      aria-hidden="true"
      focusable="false"
    >
      {drawing.paths.map(([tone, d], index) => <path key={index} data-tone={tone} d={d} />)}
    </svg>
  );
}
