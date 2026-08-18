export const LARGE_MARKDOWN_PREVIEW_THRESHOLD = 50_000;

export type MarkdownPreviewSyncPolicy = {
  publicationIdleMs: number;
  publicationMaxMs: number;
  /**
   * Quiet time after the last scroll event before the peer pane is
   * reconciled exactly, with freshly measured anchor geometry.
   *
   * 0 means the document is small enough that every per-frame follow may
   * measure lazily, so no separate settling pass is needed. When > 0, the
   * peer still follows every animation frame — a throttled or debounced
   * peer reads as stuttering or broken during trackpad momentum — but the
   * burst follows interpolate purely from the cached anchor map (zero DOM
   * measurement on the scroll path) and the one measured alignment runs
   * here, after the gesture settles.
   */
  peerScrollSettleMs: number;
};

/** One adaptive synchronization budget for Markdown, Blog, and Paper previews. */
export function markdownPreviewSyncPolicy(sourceLength: number): MarkdownPreviewSyncPolicy {
  const large = sourceLength >= LARGE_MARKDOWN_PREVIEW_THRESHOLD;
  return {
    publicationIdleMs: large ? 1_000 : 200,
    publicationMaxMs: large ? 5_000 : 1_500,
    peerScrollSettleMs: large ? 140 : 0,
  };
}
