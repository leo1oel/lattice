import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import type { AnnotationIntent } from "./editor-comment-data";

/** The intent chips' labels: what the writer can ask of the agent on an annotation. */
export function useIntentLabels(): Record<AnnotationIntent, string> {
  const { t } = useLingui();
  return useMemo(() => ({
    rewrite: t`Rewrite`,
    shorten: t`Shorten`,
    clarify: t`Clarify`,
    cite: t`Add a citation`,
    fix: t`Fix`,
  }), [t]);
}
