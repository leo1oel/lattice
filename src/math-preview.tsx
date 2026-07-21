import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { mathRegionAt } from "./math-region";

export function MathPreview(props: {
  source: string;
  cursor: number;
  macros?: Record<string, string>;
}) {
  const region = useMemo(
    () => mathRegionAt(props.source, props.cursor),
    [props.cursor, props.source],
  );
  const rendered = useMemo(() => {
    if (!region?.source) return null;
    try {
      return {
        html: katex.renderToString(region.source, {
          displayMode: region.display,
          throwOnError: false,
          strict: "ignore",
          macros: props.macros,
        }),
        error: "",
      };
    } catch (reason) {
      return {
        html: "",
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [props.macros, region]);

  if (!region || !rendered) return null;
  return (
    <div className="math-preview" aria-label="Math preview">
      <small>Math preview</small>
      {rendered.error
        ? <p className="math-preview-error">{rendered.error}</p>
        : <div className="math-preview-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />}
    </div>
  );
}
