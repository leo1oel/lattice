/**
 * Which root document's PDF a viewer shows, when it is not the compiled one:
 * another document's own tab (src/trellis/compiled-pdf-tabs.ts). SyncTeX
 * lookups made from inside the viewer (its marks, a note placed from a
 * selection, a figure's source) name it, so they search that document's map
 * rather than the compiled document's. Null: the compiled document.
 */
import { createContext } from "react";

export const PdfDocumentContext = createContext<string | null>(null);

/** The `document` argument of a SyncTeX command for the PDF of `document`. */
export function syncTexDocument(document: string | null): { document?: string } {
  return document ? { document } : {};
}
