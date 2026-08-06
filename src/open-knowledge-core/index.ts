/**
 * Local seam — not upstream code.
 *
 * Barrel over the vendored Open Knowledge core (src/open-knowledge-core/),
 * standing in for the upstream `@inkeep/open-knowledge-core` package entry.
 * Vendored app-layer files (src/open-knowledge-app/) import this via the
 * `@ok-core` alias (see scripts/vendor-open-knowledge.mjs rewrites).
 *
 * Re-export only the modules the vendored app layer actually consumes; grow
 * this list as the vendored surface grows.
 */
export * from "./metrics/parse-health.ts";
export * from "./registry/index.ts";
export * from "./registry/types.ts";
export * from "./constants/preview-embed-starters.ts";
export * from "./constants/upload.ts";
export * from "./constants/cc1.ts";
export * from "./extensions/footnote-reference.ts";
export * from "./constants/preview-theme-tokens.ts";
export * from "./constants/embedded-host.ts";
export * from "./handoff/index.ts";
export { CodeBlockFidelity } from "./extensions/code-block-fidelity.ts";
export * from "./utils/link-targets.ts";
export * from "./utils/asset-href.ts";
export * from "./utils/slug.ts";
export { isAllowedLinkUri } from "./extensions/link-fidelity.ts";
export { SAFE_URL_SCHEMES } from "./markdown/safe-url.ts";
// consumed by vendored SrcAutocomplete (BM25 asset-path suggestions)
export * from "./search/workspace-search.ts";
// consumed by vendored image-upload/upload-file.ts (RFC 9457 + upload contract)
export { ProblemDetailsSchema, UploadAssetSuccessSchema } from "./schemas/api/_envelope.ts";
// consumed by vendored editor/extensions/math-inline.ts (app NodeView wrapper)
export { MathInline } from "./extensions/math-inline.ts";
// consumed by vendored editor/utils/validate-media-url.ts
export { isLoomUrl } from "./utils/loom-embed.ts";
export { isVimeoUrl } from "./utils/vimeo-embed.ts";
export { parseYouTubeUrl } from "./utils/youtube-embed.ts";
// consumed by the vendored jsxComponent pack (JsxComponentView + componentMap)
export { rewriteEmbedUrl } from "./utils/embed-url-rewrite.ts";
export { parsePdfAnchor } from "./utils/pdf-anchor.ts";
export { parseLoomUrl } from "./utils/loom-embed.ts";
export type { ParsedYouTubeUrl } from "./utils/youtube-embed.ts";
export { normalizeDocRelativeAssetUrl } from "./markdown/resolve-image-url.ts";
export { isRelativeUrl } from "./markdown/safe-url.ts";
export { MarkdownManager } from "./markdown/index.ts";
export { sharedExtensions } from "./extensions/shared.ts";
// consumed by vendored editor/bubble-menu/bubble-menu-state.ts — an inline
// atom (wiki link, inline math) contributes no `textBetween` characters, so a
// selection containing only one used to read as empty and suppress the bubble
// menu entirely.
export { commentQuoteText } from "./comments/leaf-text.ts";

/**
 * Upstream renamed this type after our core snapshot was taken; vendored
 * app files still import `SkillScope`. Same union, newer local name.
 */
export type { ManagedArtifactScope as SkillScope } from "./constants/cc1.ts";
