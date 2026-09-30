/** Small DOM helpers shared by hand-built editor chrome (tooltips, popups, panels). */

/** A detached element with an optional class name and text. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
