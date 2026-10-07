/**
 * Text that replaces an editor's document, taken in as only what changed.
 *
 * Dispatched as the one replacement between the two, a CodeMirror view maps
 * its selection and scroll anchor through it, so both stay with their text.
 * A replacement of the whole document maps both to its start: the view jumps
 * to the top and the caret to the first line.
 */

/** `text` as a CodeMirror document holds it: CRLF and CR line breaks join its lines as "\n". */
export function documentText(text: string) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** The one replacement turning `previous` into `next`: what they share at either end stays put. */
export function textChange(previous: string, next: string) {
  const shorter = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shorter && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let kept = 0;
  while (kept < shorter - from && previous.charCodeAt(previous.length - 1 - kept) === next.charCodeAt(next.length - 1 - kept)) kept += 1;
  return { from, to: previous.length - kept, insert: next.slice(from, next.length - kept) };
}
