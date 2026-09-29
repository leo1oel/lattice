import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import katex from "katex";
import "katex/dist/katex.min.css";
import { mathRegionAt } from "./math-region";
import { InlineMessage } from "../../components/ui/inline-message";

/**
 * Strip LaTeX bookkeeping that lives inside a math environment but isn't math —
 * KaTeX would otherwise typeset `\label{eq:foo}` as literal text in the preview.
 */
function forPreview(source: string): string {
  return source
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(?:nonumber|notag)\b/g, "")
    .replace(/\\intertext\s*\{[^}]*\}/g, "")
    .trim();
}

export function MathPreview(props: {
  source: string;
  cursor: number;
  macros?: Record<string, string>;
}) {
  const { t } = useLingui();
  const region = useMemo(() => mathRegionAt(props.source, props.cursor), [props.cursor, props.source]);
  const rendered = useMemo(() => {
    const source = region?.source && forPreview(region.source);
    if (!region || !source) return null;
    try {
      const options = { displayMode: region.display, throwOnError: false, strict: "ignore" as const, macros: props.macros };
      return { html: katex.renderToString(source, options), error: "" };
    } catch (reason) {
      return { html: "", error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [props.macros, region]);

  if (!rendered) return null;
  return (
    <div className="math-preview" aria-label={t`Math preview`}>
      <small>{t`Math preview`}</small>
      {rendered.error
        ? <InlineMessage level="error">{rendered.error}</InlineMessage>
        : <div className="math-preview-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />}
    </div>
  );
}
