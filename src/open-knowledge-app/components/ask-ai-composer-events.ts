/**
 * Local seam — not upstream code.
 *
 * Upstream's Ask-AI composer listens for this window event; this host has no
 * Ask-AI composer, so the emit is a no-op signal with upstream's signature.
 * CodeBlockView's "Edit with AI" affordance stays renderable without pulling
 * the upstream composer stack.
 */
const OPEN_ASK_AI_COMPOSER_EVENT = "open-knowledge:open-ask-ai-composer";

export function emitOpenAskAiComposer(
  target: Pick<Window, "dispatchEvent"> | EventTarget = typeof window === "undefined"
    ? new EventTarget()
    : window,
): void {
  target.dispatchEvent(new CustomEvent(OPEN_ASK_AI_COMPOSER_EVENT));
}
