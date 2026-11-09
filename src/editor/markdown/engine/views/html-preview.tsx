/**
 * A raw HTML block drawn as what it describes (R-BLK-16): the sanitized
 * markup renders in place, and the source — the block's editable text, which
 * is the file's bytes — shows while the focused editor's caret is in it. Clicking the drawing
 * or "Edit HTML" puts the caret there; "Show preview" or moving away selects
 * the block again and the drawing returns.
 *
 * The markup lives in a shadow root inside a contained box: the app's styles
 * do not reach it, its ids and `url(#…)` references stay its own, and nothing
 * it lays out (a fixed position included) can leave the box. Colours are the
 * markup's own; a drawing is not recoloured for the dark theme.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useLayoutEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper, useEditorState, type NodeViewProps } from "@tiptap/react";
import { Code, Eye } from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import { sanitizeHtmlPreview } from "./html-sanitize";

/** Inside the shadow root: wide drawings scale down to the column instead of overflowing it. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a stylesheet
const SHADOW_STYLE = ":host{display:block}svg,img{max-width:100%;height:auto}table{border-collapse:collapse}";

function HtmlSurface({ source, emptyLabel, tooComplexLabel }: { source: string; emptyLabel: string; tooComplexLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const preview = sanitizeHtmlPreview(source);
    const fragment = preview?.kind === "drawn" ? preview.fragment : null;
    const style = document.createElement("style");
    style.textContent = SHADOW_STYLE;
    // Markup that draws nothing visible (or is refused as too costly) says so instead of leaving a blank box.
    const frame = element.parentElement;
    frame?.toggleAttribute("data-blank", !fragment?.textContent?.trim() && !fragment?.querySelector("svg, img, hr, table"));
    frame?.setAttribute("data-empty-label", preview?.kind === "too-complex" ? tooComplexLabel : emptyLabel);
    root.replaceChildren(style, ...(fragment ? [fragment] : []));
  }, [emptyLabel, source, tooComplexLabel]);
  return <div ref={host} className="lx-md-html-surface" data-lattice-html-preview="" />;
}

export function HtmlBlockView({ node, editor, getPos }: NodeViewProps) {
  const { t } = useLingui();
  const editable = editor.isEditable;
  const source = node.textContent;
  // A read-only view has no caret to follow, so its source is a plain toggle.
  const [readOnlySource, setReadOnlySource] = useReducer((_shown: boolean, next: boolean) => next, false);
  const caretInside = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      // Only a focused editor's caret counts: a file that opens on a figure shows the figure.
      if (!current?.isEditable || !current.isFocused) return false;
      const position = getPos();
      if (typeof position !== "number") return false;
      const { selection, doc } = current.state;
      const size = doc.nodeAt(position)?.nodeSize ?? 0;
      return !(selection instanceof NodeSelection) && selection.from > position && selection.to < position + size;
    },
  });
  const sourceShown = !source.trim() || (editable ? caretInside : readOnlySource);

  const editSource = () => {
    if (!editable) {
      setReadOnlySource(true);
      return;
    }
    const position = getPos();
    if (typeof position !== "number") return;
    editor.chain().focus().command(({ tr }) => {
      tr.setSelection(TextSelection.create(tr.doc, position + 1));
      return true;
    }).run();
  };
  const showPreview = () => {
    if (!editable) {
      setReadOnlySource(false);
      return;
    }
    const position = getPos();
    if (typeof position !== "number") return;
    editor.chain().focus().setNodeSelection(position).run();
  };

  return (
    <NodeViewWrapper className="lx-md-raw" data-kind="html" data-preview={!sourceShown} role="group" aria-label={t`HTML`}>
      <span className="lx-md-raw-header" contentEditable={false}>
        <span className="lx-md-raw-label">{t`HTML`}</span>
        {source.trim() && (
          <IconButton
            size="compact"
            tooltip={false}
            className="lx-md-raw-toggle"
            label={sourceShown ? t`Show preview` : t`Edit HTML`}
            onClick={sourceShown ? showPreview : editSource}
          >
            {sourceShown ? <Eye aria-hidden="true" /> : <Code aria-hidden="true" />}
          </IconButton>
        )}
      </span>
      {!sourceShown && (
        <div
          className="lx-md-html-preview"
          contentEditable={false}
          onMouseDown={(event) => {
            // A <summary> still opens its <details>; anywhere else edits the source.
            if (event.button !== 0 || event.nativeEvent.composedPath().some((target) => (target as Element).localName === "summary")) return;
            event.preventDefault();
            editSource();
          }}
        >
          <HtmlSurface source={source} emptyLabel={t`Nothing to show`} tooComplexLabel={t`Too complex to preview`} />
        </div>
      )}
      <NodeViewContent<"pre"> as="pre" className="lx-md-raw-source" spellCheck={false} hidden={!sourceShown} />
    </NodeViewWrapper>
  );
}
