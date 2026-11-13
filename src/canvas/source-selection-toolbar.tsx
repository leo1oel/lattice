import { LatexSelectionToolbar } from "../editor/latex/latex-selection-toolbar";
import type { SelectionToolbarPlacement } from "../editor/latex/selection-toolbar-placement";
import { MarkdownSourceToolbar } from "./markdown-source-toolbar";
import type { SourceSelectionAction } from "./source-selection-edits";

/**
 * The source editor's selection toolbar for the placement shown: the
 * Markdown one over a Markdown selection (the placement read its format),
 * the LaTeX one over any other.
 */
export function SourceSelectionToolbar(props: {
  placement: SelectionToolbarPlacement;
  /** The selected text, which the highlight picker previews. */
  sample: string;
  editable: boolean;
  canProofread: boolean;
  documentColors: readonly string[];
  onAction: (action: SourceSelectionAction, value?: string) => void;
  onDismiss: () => void;
}) {
  const { placement, editable, onAction, onDismiss } = props;
  if (placement.format) {
    return <MarkdownSourceToolbar position={placement.position} format={placement.format} editable={editable} onAction={onAction} onDismiss={onDismiss} />;
  }
  return (
    <LatexSelectionToolbar
      position={placement.position}
      canComment
      canProofread={props.canProofread}
      highlight={placement.highlight}
      formats={placement.latexFormats}
      sample={props.sample}
      documentColors={props.documentColors}
      commentOnly={!editable}
      onAction={onAction}
      onDismiss={onDismiss}
    />
  );
}
