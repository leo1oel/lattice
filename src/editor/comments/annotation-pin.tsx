import { cn } from "@/lib/utils";
import type { AnnotationStatus } from "./editor-comment-data";
import "./annotations.css";

/**
 * An annotation's number in its status colour: amber while open, blue with a
 * proposal, violet while the agent waits on the writer, green once accepted.
 * The same pin marks it in the gutter, on the PDF, in the panel and on the
 * agent's card, so the number is how the writer follows one note across them.
 */
export function AnnotationPin({ number, status, className }: { number: number; status: AnnotationStatus; className?: string }) {
  return (
    <span className={cn("annotation-pin", className)} data-annotation-status={status} aria-hidden>
      {number}
    </span>
  );
}
