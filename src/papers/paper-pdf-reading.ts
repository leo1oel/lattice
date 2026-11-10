/**
 * The Papers being read as their original PDF, by arXiv id, in this window.
 * The reader (canvas/use-paper-pdf.ts) marks a Paper as it shows its PDF and
 * clears the mark when the writer goes back to its text; a marked Paper set
 * aside in another panel keeps showing its PDF there
 * (trellis/trellis-document-views.tsx), so two PDFs can be read side by side,
 * and coming back to it opens the PDF again.
 */

/** Where a Paper's PDF comes from, and the reading file its place is saved under. */
export type PaperPdfReading = Readonly<{ key: string; url: string; fileName: string; generic: boolean; path: string }>;

const reading = new Map<string, PaperPdfReading>();
const listeners = new Set<() => void>();

export const paperPdfReading = {
  get: (arxivId: string) => reading.get(arxivId),
  set(arxivId: string, value: PaperPdfReading | null) {
    const current = reading.get(arxivId);
    if (current === value || (!current && !value)) return;
    if (value) reading.set(arxivId, value);
    else reading.delete(arxivId);
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
