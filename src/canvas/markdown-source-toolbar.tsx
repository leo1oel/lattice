/**
 * The Markdown source editor's selection toolbar: the visual editor's toolbar
 * (block type menu and inline formats, selection-toolbar-parts.tsx) writing
 * Markdown syntax over the CodeMirror selection, plus Annotate. Actions with
 * no Markdown form stay in the visual editor (footnotes, View in source). A
 * read-only file offers only Annotate, and so does a selection inside a
 * fenced code block, apart from the menu that turns it back into text.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { Link, MessageSquareText, Radical } from "lucide-react";
import { useExitPicture } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { SELECTION_TOOLBAR_SURFACES, type LatexSelectionToolbarPosition } from "../editor/latex/latex-selection-toolbar";
import { BlockTypeMenu, ToolbarButton, ToolbarDivider } from "../editor/markdown/engine/chrome/selection-toolbar-parts";
import { TOOLBAR_MARKS } from "../editor/markdown/engine/chrome/selection-toolbar-items";
import type { MarkdownSelectionFormat } from "../editor/markdown/markdown-source-format";
import type { SourceSelectionAction } from "./source-selection-edits";

export function MarkdownSourceToolbar(props: {
  position: LatexSelectionToolbarPosition;
  format: MarkdownSelectionFormat;
  editable: boolean;
  onAction: (action: SourceSelectionAction) => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useLingui();
  const { position, format, editable, onAction, onDismiss } = props;
  // The block type menu mounts in this layer, untransformed (the anchor's
  // `translate` would offset the menu's fixed placement), and inside the
  // toolbar's surfaces, so focus in the menu keeps the toolbar.
  const [layer] = useState(() => {
    const element = document.createElement("div");
    element.className = "lx-md-toolbar-layer";
    return element;
  });
  useLayoutEffect(() => {
    document.body.append(layer);
    return () => layer.remove();
  }, [layer]);
  // It grows from the selection as every popup does and, gone, fades where it stood.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useExitPicture([anchorRef]);
  useEffect(() => {
    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(SELECTION_TOOLBAR_SURFACES)) onDismiss();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointerDown, true);
  }, [onDismiss]);
  const formats = editable && !format.inCode;
  return createPortal(
    <div
      ref={anchorRef}
      className={`latex-selection-toolbar-anchor lx-md-toolbar-anchor ${popupMotionClassName}${position.below ? " below" : ""}`}
      data-side={position.below ? "bottom" : "top"}
      style={{ left: position.left, top: position.top, maxWidth: position.maxWidth }}
    >
      <div className="lx-md-toolbar is-source" role="toolbar" aria-label={t`Formatting`}>
        {editable && <>
          <BlockTypeMenu active={format.block} container={layer} onSelect={(block) => onAction({ block })} />
          <ToolbarDivider />
        </>}
        {formats && <>
          {TOOLBAR_MARKS.map(({ mark, label, icon: Icon }) => (
            <ToolbarButton key={mark} label={i18n._(label)} pressed={format.inline.has(mark)} onPress={() => onAction({ format: mark })}>
              <Icon aria-hidden="true" />
            </ToolbarButton>
          ))}
          <ToolbarDivider />
          <ToolbarButton label={t`Insert link`} pressed={format.inline.has("link")} onPress={() => onAction({ format: "link" })}>
            <Link aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton label={t`Convert selection to inline math`} pressed={format.inline.has("math")} onPress={() => onAction({ format: "math" })}>
            <Radical aria-hidden="true" />
          </ToolbarButton>
          <ToolbarDivider />
        </>}
        <ToolbarButton label={t`Annotate`} onPress={() => onAction("comment")}>
          <MessageSquareText aria-hidden="true" />
        </ToolbarButton>
      </div>
    </div>,
    layer,
  );
}
