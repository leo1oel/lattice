export const DECK_ERROR_OVERLAY_MODULE = "\0virtual:lattice-deck-error-overlay";

/**
 * Loaded by every Open Slide page. A deck that fails to compile raises Vite's
 * error overlay, which Vite clears only on its own HMR `update`. Open Slide
 * reloads an edited deck through `open-slide:slide-changed` instead, so the
 * overlay outlived the fix until the page reloaded or a click dismissed it.
 * Each reload drops the overlay for an error in that deck's files: a reload
 * that still fails compiles the deck again, and Vite raises a fresh one.
 */
export const DECK_ERROR_OVERLAY_SOURCE = `
if (import.meta.hot) {
  import.meta.hot.on("open-slide:slide-changed", (data) => {
    const ids = Array.isArray(data?.slideIds) ? data.slideIds : [];
    for (const overlay of document.querySelectorAll("vite-error-overlay")) {
      const file = overlay.shadowRoot?.querySelector(".file")?.textContent ?? "";
      if (ids.some((id) => file.includes("/slides/" + id + "/"))) overlay.close();
    }
  });
}
`;
