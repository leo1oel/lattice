/**
 * Node views for the Lattice visual engine: each schema node that draws more
 * than its static HTML gets its view here, along with the plugins those views
 * rely on (syntax highlighting, figure alignment, footnote numbers, and the
 * rich blocks' keyboard behavior).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeHighlight } from "./code-highlight";
import { EngineKeymap, type ImeGuard } from "./engine-keymap";
import {
  Component, FootnoteDefinition, FootnoteReference, InlineMath, LatticeCodeBlock, LatticeImage, MathBlock, RawBlock,
} from "./engine-schema";
import { CodeBlockView } from "./views/code-block-view";
import { ComponentView } from "./views/component-views";
import { FootnoteDefinitionView, FootnoteNumbering, FootnoteReferenceView } from "./views/footnote-views";
import { ImageFigures, ImageView } from "./views/image-view";
import { InlineMathView, MathBlockView, inlineMathInputRule } from "./views/math-views";
import { RawBlockView } from "./views/raw-block-view";

export { MathMacrosContext } from "./views/math-views";

/**
 * The engine's views: they replace the schema's static rendering, keeping
 * node names and attributes identical, so documents and baselines are shared
 * with the view-less schema (engine-schema.ts).
 */
export function engineNodeViews(options: { ime: ImeGuard }): AnyExtension[] {
  return [
    InlineMath.extend({
      addNodeView: () => ReactNodeViewRenderer(InlineMathView, { as: "span" }),
      addInputRules() {
        return [inlineMathInputRule(this.type)];
      },
    }),
    MathBlock.extend({ addNodeView: () => ReactNodeViewRenderer(MathBlockView) }),
    LatticeImage.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView, { as: "span" }) }).configure({ inline: true, allowBase64: true }),
    LatticeCodeBlock.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }),
    Component.extend({ addNodeView: () => ReactNodeViewRenderer(ComponentView) }),
    FootnoteReference.extend({ addNodeView: () => ReactNodeViewRenderer(FootnoteReferenceView, { as: "span" }) }),
    FootnoteDefinition.extend({ addNodeView: () => ReactNodeViewRenderer(FootnoteDefinitionView) }),
    RawBlock.extend({ addNodeView: () => ReactNodeViewRenderer(RawBlockView) }),
    CodeHighlight,
    ImageFigures,
    FootnoteNumbering,
    EngineKeymap.configure({ ime: options.ime }),
  ];
}
