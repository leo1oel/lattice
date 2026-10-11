import { useDeferredValue, useEffect, useState } from "react";
import { loadBibDocumentModule } from "./canvas-lazy-modules";

type BibModule = Awaited<ReturnType<typeof loadBibDocumentModule>>;
let loaded: BibModule | null = null;

/**
 * Why a .bib file's text cannot show as the visual list, or null when it can
 * (or the parser is still loading). `source` is null for any other file.
 * The parse is the list's own (`readBibDocument` remembers the last text it
 * read), so asking costs nothing more when the list reads the same text.
 */
export function useBibUnreadable(source: string | null): string | null {
  const [parser, setParser] = useState(loaded);
  const wanted = source !== null;
  useEffect(() => {
    if (!wanted || parser) return;
    let disposed = false;
    void loadBibDocumentModule().then((module) => {
      loaded = module;
      if (!disposed) setParser(module);
    });
    return () => { disposed = true; };
  }, [parser, wanted]);
  const text = useDeferredValue(source);
  if (!parser || text === null) return null;
  const { error } = parser.readBibDocument(text);
  return error ? parser.bibUnreadableReason(error) : null;
}
