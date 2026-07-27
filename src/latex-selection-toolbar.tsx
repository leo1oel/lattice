import {
  Bold,
  Heading,
  Highlighter,
  Italic,
  Link,
  MessageSquareText,
  Quote,
  Strikethrough,
  Underline,
} from "lucide-react";
import { createPortal } from "react-dom";
import { PopIn } from "./motion";

export type LatexSelectionAction =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "link"
  | "heading"
  | "quote"
  | "highlight"
  | "comment";

export type LatexSelectionToolbarPosition = {
  left: number;
  top: number;
  below: boolean;
  maxWidth: number;
};

const actions: { action: LatexSelectionAction; label: string; tooltip?: string; icon: typeof Bold; separated?: boolean }[] = [
  { action: "bold", label: "Bold", icon: Bold },
  { action: "italic", label: "Italic", icon: Italic },
  { action: "underline", label: "Underline", icon: Underline },
  { action: "strikethrough", label: "Strikethrough", tooltip: "Strikethrough (requires ulem)", icon: Strikethrough },
  { action: "link", label: "Link", tooltip: "Link (requires hyperref)", icon: Link, separated: true },
  { action: "heading", label: "Section heading", icon: Heading },
  { action: "quote", label: "Quote", icon: Quote },
  { action: "highlight", label: "Highlight", tooltip: "Highlight (requires xcolor)", icon: Highlighter, separated: true },
  { action: "comment", label: "Comment", icon: MessageSquareText, separated: true },
];

export function LatexSelectionToolbar(props: {
  position: LatexSelectionToolbarPosition;
  canComment: boolean;
  onAction: (action: LatexSelectionAction) => void;
}) {
  const visibleActions = props.canComment
    ? actions
    : actions.filter(({ action }) => action !== "comment");
  return createPortal(
    <div
      className={`latex-selection-toolbar-anchor${props.position.below ? " below" : ""}`}
      style={{
        left: props.position.left,
        top: props.position.top,
        maxWidth: props.position.maxWidth,
      }}
      role="toolbar"
      aria-label="Format selected LaTeX"
      onPointerDown={(event) => event.preventDefault()}
    >
      <PopIn className="latex-selection-toolbar">
        {visibleActions.map(({ action, label, tooltip, icon: Icon, separated }) => (
          <span key={action} className={separated ? "latex-selection-tool separated" : "latex-selection-tool"}>
            <button
              type="button"
              aria-label={label}
              title={tooltip ?? label}
              onClick={() => props.onAction(action)}
            >
              <Icon size={14} strokeWidth={1.8} />
            </button>
          </span>
        ))}
      </PopIn>
    </div>,
    document.body,
  );
}
