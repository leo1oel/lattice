/**
 * When the preview carries its annotation layer (pdf-annotations.tsx): from
 * the first selection made on the PDF, or from the first annotation it has
 * to draw. Until then a PDF nobody annotates loads none of it.
 */
import { lazy, Suspense, type ComponentProps } from "react";
import { drawnOnPdf } from "./pdf-drawn-annotations";

// Keep import expressions outside the component: React Compiler cannot lower them.
const PdfAnnotationLayer = lazy(() => import("./pdf-annotations"));

export function PdfAnnotationLoader({ annotating, ...layer }: ComponentProps<typeof PdfAnnotationLayer> & {
  /** Text has been selected on the PDF. */
  annotating: boolean;
}) {
  return annotating || layer.annotations.some(drawnOnPdf) ? <Suspense fallback={null}><PdfAnnotationLayer {...layer} /></Suspense> : null;
}
