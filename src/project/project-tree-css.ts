import fluidHoverCSS from "../components/ui/fluid-hover.css?inline";

/** Injected into the tree's shadow root through Pierre's `unsafeCSS`. */
export const PIERRE_TREE_CSS = `
${fluidHoverCSS}
/* Preserve Pierre's virtual-window geometry while hosting the hover fill. */
[data-file-tree-virtualized-sticky="true"].fluid-hover-surface {
  position: sticky;
}

/* Wheel/scroll can recycle rows beneath a stationary pointer. Keep selection
   and context-menu feedback, but suppress both hover paint paths until idle. */
[data-tree-scrolling] .fluid-hover-highlight {
  display: none;
}
[data-tree-scrolling] button[data-type="item"]:hover:not([data-item-selected="true"]):not([data-item-context-hover="true"]) {
  background: transparent;
}

:host {
  display: block;
  min-height: 0;
  height: 100%;
}

/* Pierre must retain this scroll owner for virtualization, keyboard focus, and
   scroll-to-selection. Hide both of its native scrollbar paths; the outer
   ExternalScrollbar paints the same single Lattice scrollbar as ScrollArea. */
[data-file-tree-virtualized-scroll="true"],
[data-file-tree-scrollbar-measure="true"] {
  -ms-overflow-style: none;
  scrollbar-gutter: auto;
  scrollbar-width: none;
}

[data-file-tree-virtualized-scroll="true"]::-webkit-scrollbar,
[data-file-tree-scrollbar-measure="true"]::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

button[data-type="item"] {
  background: transparent;
  letter-spacing: -0.005em;
  transition: background-color var(--motion-moderate),
    box-shadow var(--motion-moderate),
    color var(--motion-fast),
    opacity var(--motion-fast);
}

/* Tauri's native file-drop bridge and HTML5 row dragging do not share a
   reliable coordinate space when the WKWebView is zoomed. Keep the gesture in
   pointer events and let Pierre's public model own the actual move. */
button[data-type="item"][draggable="true"] {
  -webkit-user-drag: none;
  user-select: none;
  cursor: grab;
}

button[data-type="item"][data-item-dragging="true"],
button[data-type="item"][data-lattice-pointer-dragging="true"] {
  cursor: grabbing;
  opacity: 0.38;
}

:host([data-lattice-pointer-drag-active="true"]),
:host([data-lattice-pointer-drag-active="true"]) * {
  cursor: grabbing !important;
}

button[data-type="item"][data-lattice-pointer-drag-preview="true"] {
  position: fixed;
  inset: 0 auto auto 0;
  z-index: var(--z-drag-ghost);
  margin: 0;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--text-primary) 9%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-panel-raised) 54%, transparent);
  box-shadow: var(--elevation-floating-shadow);
  opacity: 0;
  pointer-events: none;
  transform-origin: center;
  will-change: transform, opacity;
  backdrop-filter: blur(10px) saturate(92%);
  -webkit-backdrop-filter: blur(10px) saturate(92%);
  transition: opacity var(--motion-fast),
    box-shadow var(--motion-fast);
}

[data-lattice-pointer-drag-count="true"] {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--surface-panel-raised) 80%, transparent);
  border-radius: 999px;
  background: var(--control-active);
  box-shadow: var(--elevation-raised-shadow);
  color: var(--control-active-contrast);
  font-size: var(--type-micro-size);
  font-weight: var(--weight-semibold);
  line-height: 1;
}

button[data-type="item"]:hover:not([data-item-selected="true"]),
button[data-type="item"][data-item-context-hover="true"]:not([data-item-selected="true"]) {
  background: var(--trees-bg-muted);
}

button[data-type="item"][data-item-selected="true"] {
  background: var(--trees-selected-bg);
  font-weight: var(--weight-medium);
}

button[data-type="item"][data-item-focused="true"]::before {
  outline-color: transparent;
}

/* The product's one ring, drawn inside the row: rows touch, and the
   virtualized scroller clips anything outside them. */
button[data-type="item"]:focus-visible::before {
  outline: var(--focus-ring-width) solid var(--navigation-focus-ring);
  outline-offset: calc(-1 * var(--focus-ring-width));
}

button[data-type="item"][data-item-selected="true"] [data-item-section="icon"] {
  color: var(--trees-fg-muted);
}

[data-item-section="icon"] {
  opacity: 0.76;
}

[data-icon-name="file-tree-icon-chevron"] {
  width: 12px;
  height: 12px;
}

[data-icon-name="file-tree-icon-file"] {
  width: 14px;
  height: 14px;
}

[data-item-section="content"] {
  flex: 1 1 auto;
}

[data-truncate-group-container="middle"] {
  width: max-content;
  max-width: 100%;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

[data-truncate-group-container="middle"] > div:first-child {
  min-width: 0;
  flex: 0 1 auto;
}

[data-truncate-group-container="middle"] > div:last-child {
  min-width: 0;
  flex: 0 0 auto;
}

[data-truncate-container] {
  height: auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
}

[data-truncate-grid] {
  min-width: 0;
  display: block;
}

[data-truncate-content="visible"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-truncate-container="fruncate"] [data-truncate-content] {
  direction: ltr;
}

[data-truncate-content="overflow"],
[data-truncate-marker-cell],
[data-truncate-fill] {
  display: none;
}

button[data-type="item"][data-lattice-native-drop-target="true"] {
  background: color-mix(in srgb, var(--text-primary) 9%, transparent);
  color: var(--text-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 18%, transparent);
}

[data-item-drag-target="true"] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 18%, transparent);
}

button[data-type="item"][data-lattice-pointer-drop-target="true"] {
  background: var(--control-active-soft);
  color: var(--text-primary);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--control-active) 27%, transparent),
    var(--elevation-raised-shadow);
}

[data-item-flattened-subitem][data-lattice-pointer-flattened-drop-target="true"] {
  border-radius: 4px;
  background: var(--control-active-soft);
}

@media (prefers-reduced-motion: reduce) {
  button[data-type="item"],
  button[data-type="item"][data-lattice-pointer-drag-preview="true"] {
    transition: none;
  }
}

[data-file-tree-search-container] {
  margin: 0 0 7px;
  padding-inline: var(--space-1);
}

[data-file-tree-search-container][data-open="false"] {
  display: none;
}

[data-file-tree-search-input] {
  box-sizing: border-box;
  height: var(--navigation-search-height);
  padding: 0 var(--search-control-padding-inline) 0 14px;
  border: var(--search-control-border-width) solid var(--search-control-border-color);
  border-radius: var(--search-control-radius);
  outline: none !important;
  background: var(--search-control-background);
  color: var(--text-primary);
  font-size: var(--navigation-search-font-size);
  font-weight: var(--navigation-search-font-weight);
  line-height: var(--navigation-search-line-height);
  transition: background-color var(--motion-fast),
    border-color var(--motion-fast);
}

[data-file-tree-search-input]::placeholder {
  color: var(--text-tertiary);
}

[data-file-tree-search-input]::-webkit-search-cancel-button,
[data-file-tree-search-input]::-webkit-search-decoration,
[data-file-tree-search-input]::-webkit-search-results-button,
[data-file-tree-search-input]::-webkit-search-results-decoration {
  -webkit-appearance: none;
  appearance: none;
}

[data-file-tree-search-input]:hover:not(:focus-visible):not(
  [data-file-tree-search-input-fake-focus="true"]
) {
  border-color: var(--search-control-interactive-border-color);
}

[data-file-tree-search-input]:focus,
[data-file-tree-search-input]:focus-visible,
[data-file-tree-search-input][data-file-tree-search-input-fake-focus="true"] {
  border-color: var(--search-control-interactive-border-color);
  box-shadow: none;
}

/* The name stays where it was when editing starts: the field's padding and
   border sit outside the text's left edge. */
[data-item-rename-input] {
  height: 20px;
  margin-inline-start: calc(-1 * (var(--space-2) + var(--field-control-border-width)));
  padding: 0 var(--space-2);
  border: var(--field-control-border-width) solid var(--field-control-interactive-border-color);
  border-radius: var(--radius-compact);
  outline: none;
  background: var(--field-control-background);
  box-shadow: none;
  overflow-x: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
