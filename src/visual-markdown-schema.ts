/*
 * Assembles the visual Markdown editor's schema from the vendored Open
 * Knowledge core (src/open-knowledge-core, inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e, GPL-3.0-or-later).
 *
 * The editor's extensions and the MarkdownManager MUST share the exact same
 * schema. `visualEditorExtensions` therefore only attaches NodeViews (and
 * UI-only options such as KaTeX macros) onto the upstream extensions —
 * never new nodes, marks, or attrs.
 */
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockFidelity as AppCodeBlock } from "@ok-app/editor/extensions/code-block";
import { MathInline as AppMathInline } from "@ok-app/editor/extensions/math-inline";
import { JsxComponentView } from "@ok-app/editor/extensions/JsxComponentView";
import { JsxComponent } from "./open-knowledge-core/extensions/jsx-component.ts";
import { RawMdxFallback } from "./open-knowledge-core/extensions/raw-mdx-fallback.ts";
import { emptyMarkdownAnchorId } from "./open-knowledge-core/extensions/html-block-fidelity.ts";
import { sharedExtensions } from "./open-knowledge-core/extensions/shared.ts";
import { MarkdownManager } from "./open-knowledge-core/markdown/index.ts";
import { RawMdxFallbackView } from "@ok-app/editor/extensions/RawMdxFallbackCMView";

let manager: MarkdownManager | undefined;

/** Singleton parser/serializer sharing the editor schema (upstream pattern). */
export function getMarkdownManager(): MarkdownManager {
  manager ||= new MarkdownManager({ extensions: sharedExtensions });
  return manager;
}

/** Legacy Research Writer `rw-component <kind>` fence kinds → registry components. */
const LEGACY_COMPONENT_KINDS: Record<string, string> = {
  callout: "Callout",
};

/**
 * Upgrade a legacy ` ```rw-component callout `-fenced block into a pristine
 * `jsxComponent`. `sourceRaw` keeps the exact fence bytes, so untouched
 * documents serialize unchanged; the first visual edit flips `sourceDirty`
 * and migrates the block to canonical MDX.
 */
function upgradeLegacyComponentFence(node: JSONContent): JSONContent {
  if (node.type !== "codeBlock" || String(node.attrs?.language ?? "") !== "rw-component") return node;
  const componentName = LEGACY_COMPONENT_KINDS[String(node.attrs?.meta ?? "").trim().toLowerCase()];
  if (!componentName) return node;
  let data: unknown;
  try {
    data = JSON.parse((node.content ?? []).map((child) => child.text ?? "").join(""));
  } catch {
    return node;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return node;
  const { content: body, ...props } = data as Record<string, unknown>;
  return {
    type: "jsxComponent",
    attrs: {
      componentName,
      kind: "element",
      attributes: [],
      sourceRaw: getMarkdownManager().serialize({ type: "doc", content: [node] }).replace(/\n$/, ""),
      sourceDirty: false,
      props,
    },
    content: [{
      type: "paragraph",
      content: typeof body === "string" && body ? [{ type: "text", text: body }] : [],
    }],
  };
}

function prepareVisualNode(node: JSONContent): JSONContent {
  const upgraded = upgradeLegacyComponentFence(node);
  const anchorSource = upgraded.type === "paragraph"
    && upgraded.content?.length === 1
    && upgraded.content[0]?.type === "text"
    ? upgraded.content[0].text
    : null;
  if (emptyMarkdownAnchorId(anchorSource)) {
    // CommonMark parses a standalone empty <a> as inline HTML inside a
    // paragraph. Promote converter anchors to the existing lossless HTML atom
    // so visual mode can hide the source tag while retaining its fragment id.
    return { type: "htmlBlock", attrs: { content: anchorSource } };
  }
  const content = upgraded.content?.map(prepareVisualNode);
  if (
    upgraded.type === "jsxComponent"
    && upgraded.attrs?.componentName === "Callout"
    && !content?.length
  ) {
    // The Markdown parser represents an empty `<Callout>\n\n</Callout>`
    // with zero children. That leaves ProseMirror without a valid text
    // position; macOS IME can paint composition text into the DOM, then Enter
    // NodeSelects the empty component and it appears to collapse to its halo.
    // A real empty paragraph preserves the same Markdown while giving IME and
    // Enter a stable editable content hole.
    return { ...upgraded, content: [{ type: "paragraph" }] };
  }
  return content ? { ...upgraded, content } : upgraded;
}

/** Parse canonical Markdown for the visual editor (upstream parse + legacy fence upgrade). */
export function parseVisualMarkdown(markdown: string, sourcePath?: string): JSONContent {
  // A leading BOM is file envelope, not content: parsing it as text would make
  // serialize + preserveMarkdownEnvelope emit a doubled BOM and a spurious
  // write-back on mount. The envelope helper restores it from the canonical text.
  const doc = getMarkdownManager().parseWithFallback(
    markdown.replace(/^\uFEFF/, ""),
    sourcePath ? { sourcePath } : undefined,
  );
  const content = doc.content?.map(prepareVisualNode);
  return content ? { ...doc, content } : doc;
}

export function visualEditorExtensions(imageExtension?: AnyExtension): AnyExtension[] {
  const replacements: Record<string, AnyExtension> = {
    // Upstream app code block: same core schema (no attr changes), plus the
    // upstream NodeView (language dropdown, copy, preview), lowlight
    // decorations, tab indentation, and the bare-fence input rule.
    codeBlock: AppCodeBlock,
    // Upstream app jsxComponent NodeView: full component pack (Callout,
    // Accordion, Tabs, media, Math, Mermaid, …) + PropPanel editing chrome.
    // Host KaTeX macros reach its Math renderer through the same
    // @ok-app/shims/katex-macros seam as inline math; `options.macros` is
    // no longer plumbed through extension options.
    jsxComponent: JsxComponent.extend({
      addNodeView: () => ReactNodeViewRenderer(JsxComponentView),
    }),
    // Upstream app inline math: same core schema, plus the upstream KaTeX
    // NodeView (click → PropPanel popover). Host KaTeX macros reach the
    // renderer through the @ok-app/shims/katex-macros seam, published by
    // VisualMarkdownEditor — not through extension options.
    mathInline: AppMathInline,
    ...(imageExtension ? { image: imageExtension } : {}),
    // `tag` intentionally has NO replacement here: the app-side override
    // (VisualTagView NodeView, `#` typeahead, adjacent-atom Backspace)
    // needs the workspace index, which only the editor component can
    // provide — VisualMarkdownEditor swaps it in via `visualTag()`
    // (visual-tag.ts). Core's schema shape is identical either way.
    rawMdxFallback: RawMdxFallback.extend({
      addNodeView: () => ReactNodeViewRenderer(RawMdxFallbackView),
    }),
    // footnoteDefinition intentionally has NO NodeView override: the core
    // extension's renderHTML already emits the upstream UI — the
    // auto-numbered `.footnote-def` aside with `id="fn-{id}"` (the anchor
    // FootnoteAnchorScroll jumps to) and the `.footnote-backref` ↩ arrow.
  };
  return sharedExtensions.map((extension): AnyExtension => replacements[extension.name] ?? extension);
}
