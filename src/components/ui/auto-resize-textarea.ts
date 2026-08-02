/**
 * Resize a textarea to its content while keeping geometry in CSS.
 *
 * Callers own `min-height` and `max-height`; this helper only applies those
 * computed limits. That keeps responsive density changes out of JavaScript.
 */
export function resizeTextareaToContent(textarea: HTMLTextAreaElement) {
  textarea.style.height = "0px";

  const styles = getComputedStyle(textarea);
  const minHeight = Number.parseFloat(styles.minHeight) || 0;
  const parsedMaxHeight = Number.parseFloat(styles.maxHeight);
  const maxHeight = Number.isFinite(parsedMaxHeight) ? parsedMaxHeight : Number.POSITIVE_INFINITY;
  const contentHeight = textarea.scrollHeight;
  const height = Math.min(Math.max(contentHeight, minHeight), maxHeight);

  textarea.style.height = `${height}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}
