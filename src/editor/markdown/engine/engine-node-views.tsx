/**
 * Node views for the Lattice visual engine: project images, KaTeX formulas,
 * and the decoration that reveals a display formula's TeX while the caret is
 * inside it.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the extensions and their views form one module */
import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useProjectImageSrc } from "../project-image-host";
import { InlineMath, MathBlock } from "./engine-schema";

/** KaTeX macros for every formula in the editor (the project's `\newcommand`s). */
export const MathMacrosContext = createContext<Record<string, string>>({});

const UNSAFE_SOURCE = /^\s*(?:javascript|vbscript|file):/i;

function Formula({ tex, display }: { tex: string; display: boolean }) {
  const macros = useContext(MathMacrosContext);
  const target = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!target.current) return;
    katex.render(tex, target.current, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      // KaTeX mutates the macro table it is given; keep the shared one pristine.
      macros: { ...macros },
    });
  }, [display, macros, tex]);
  return <span ref={target} className="lx-md-formula" />;
}

function InlineMathView({ node, selected }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={`lx-md-math${selected ? " is-selected" : ""}`} data-tex={node.attrs.tex}>
      <Formula tex={String(node.attrs.tex)} display={false} />
    </NodeViewWrapper>
  );
}

function MathBlockView({ node, editor, getPos }: NodeViewProps) {
  // ProseMirror puts the `is-editing` decoration class on this view's outer
  // element; the stylesheet reveals the TeX source from there.
  return (
    <NodeViewWrapper className="lx-md-math-block">
      <div
        className="lx-md-math-preview"
        contentEditable={false}
        onMouseDown={(event) => {
          // The preview is not editable; clicking it moves the caret into the TeX.
          const position = getPos();
          if (typeof position !== "number" || !editor.isEditable) return;
          event.preventDefault();
          editor.chain().focus().setTextSelection(position + 1 + node.content.size).run();
        }}
      >
        {node.textContent.trim() ? <Formula tex={node.textContent} display /> : <span className="lx-md-math-empty">TeX</span>}
      </div>
      <NodeViewContent<"pre"> as="pre" className="lx-md-math-source" spellCheck={false} />
    </NodeViewWrapper>
  );
}

function ImageView({ node, selected }: NodeViewProps) {
  const authored = String(node.attrs.src ?? "");
  const src = useProjectImageSrc(UNSAFE_SOURCE.test(authored) ? undefined : authored);
  return (
    <NodeViewWrapper as="span" className={`lx-md-image${selected ? " is-selected" : ""}`}>
      {src
        ? <img src={src} alt={node.attrs.alt ?? ""} title={node.attrs.title ?? undefined} decoding="async" draggable={false} />
        : <span className="lx-md-image-missing">{node.attrs.alt || authored}</span>}
    </NodeViewWrapper>
  );
}

const activeMathKey = new PluginKey("latticeActiveMath");

/** Marks the display formula that holds the caret, so its TeX source shows while it is edited. */
const ActiveMathBlock = Extension.create({
  name: "latticeActiveMathBlock",
  addProseMirrorPlugins: () => [new Plugin({
    key: activeMathKey,
    props: {
      decorations(state) {
        const { $head } = state.selection;
        for (let depth = $head.depth; depth > 0; depth -= 1) {
          if ($head.node(depth).type.name !== "latticeMathBlock") continue;
          const from = $head.before(depth);
          return DecorationSet.create(state.doc, [Decoration.node(from, from + $head.node(depth).nodeSize, { class: "is-editing" })]);
        }
        return null;
      },
    },
  })],
});

/** The engine's views: replace the schema's static rendering for formulas and images. */
export function engineNodeViews() {
  return [
    InlineMath.extend({ addNodeView: () => ReactNodeViewRenderer(InlineMathView) }),
    MathBlock.extend({ addNodeView: () => ReactNodeViewRenderer(MathBlockView) }),
    Image.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView) }).configure({ inline: true, allowBase64: true }),
    ActiveMathBlock,
  ];
}
