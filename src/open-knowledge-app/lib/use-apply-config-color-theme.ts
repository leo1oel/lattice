/**
 * Local seam — not upstream code.
 *
 * Upstream's hook applies its user-configurable color themes by stamping
 * `data-color-theme` on the root element; this host has no configurable
 * theme system (only `:root[data-theme]`). Vendored code (preview-live-tokens)
 * imports just the attribute name to watch for theme flips, so this seam
 * carries only that constant. The attribute simply never appears here, which
 * makes the upstream observer a no-op — the host's own theme signal is
 * covered by `@ok-app/lib/color-theme-epoch`.
 */
export const COLOR_THEME_ATTRIBUTE = "data-color-theme";
