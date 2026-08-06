/**
 * Local seam — not upstream code.
 *
 * Upstream renamed the Ask-AI entry point: `emitOpenAskAiComposer` from
 * `components/ask-ai-composer-events.ts` became `emitStartComment` on the
 * comment-queue store (`comments/store.ts`, ~790 lines of queue state this
 * host does not run — it has no comment queue and no Ask-AI composer).
 *
 * CodeBlockView's chrome button calls this, so keep the emit a no-op signal
 * with upstream's new signature, exactly as the older seam did. Renaming the
 * seam alongside upstream keeps future vendor merges conflict-free.
 */
const START_COMMENT_EVENT = "open-knowledge:start-comment";

export function emitStartComment(
  target: Pick<Window, "dispatchEvent"> | EventTarget = typeof window === "undefined"
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent(START_COMMENT_EVENT));
}
