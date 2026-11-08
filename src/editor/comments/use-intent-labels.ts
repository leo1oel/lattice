import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { citationRoleLabel } from "../latex/citation-roles";
import type { AnnotationIntent, EditorComment } from "./editor-comment-data";

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

/** What an annotation's card says: a citation reason's role and line, else its note or the intent it asks for. */
export function annotationNote(comment: EditorComment, intents: Record<AnnotationIntent, string>): string {
  if (comment.citation) return [citationRoleLabel(comment.citation.role), comment.body].filter(Boolean).join(" · ");
  return comment.body || (comment.intent ? intents[comment.intent] : "");
}
