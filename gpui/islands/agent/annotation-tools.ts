/**
 * The annotation tools' host on the Agent's page (`propose`, `ask` from the
 * conversation, checked by `executeAgentAnnotationsToolRequest`): it finds
 * the annotation in the page's view of the window's store and hands what to
 * record to the window (`record_annotation_tool`), whose revision rounds
 * record it into the open round, as the Tauri app's rounds' `toolHost` does
 * (`annotation-rounds.ts`). The page itself writes nothing.
 */
import type { AnnotationToolHost } from "../../../src/agent/agent-annotations";
import type { AnnotationsState } from "../../../src/app/use-editor-comments";

/** What the window is asked to record (`agent/surface/annotations.rs`). */
export type AnnotationToolCall =
  | { annotationId: string; action: "propose"; text: string; reason: string }
  | { annotationId: string; action: "ask"; question: string };

export function annotationToolHost(
  view: () => AnnotationsState,
  record: (call: AnnotationToolCall) => void,
): AnnotationToolHost {
  return {
    find: (number) => view().annotations.find((annotation) => annotation.number === number) ?? null,
    propose: (annotation, text, reason) => record({ annotationId: annotation.id, action: "propose", text, reason }),
    ask: (annotation, question) => record({ annotationId: annotation.id, action: "ask", question }),
  };
}
