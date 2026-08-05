export const LARGE_MARKDOWN_PREVIEW_THRESHOLD = 50_000;

export type MarkdownPreviewSyncPolicy = {
  publicationIdleMs: number;
  publicationMaxMs: number;
  peerScrollDelayMs: number;
};

/** One adaptive synchronization budget for Markdown, Blog, and Paper previews. */
export function markdownPreviewSyncPolicy(sourceLength: number): MarkdownPreviewSyncPolicy {
  const large = sourceLength >= LARGE_MARKDOWN_PREVIEW_THRESHOLD;
  return {
    publicationIdleMs: large ? 1_000 : 200,
    publicationMaxMs: large ? 5_000 : 1_500,
    peerScrollDelayMs: large ? 140 : 0,
  };
}
