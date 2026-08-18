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
import { useEffect, useState } from "react";
import { PopIn } from "../../components/ui/motion";
import { Tip } from "../../components/icon-tip";
import { AppleColorPicker } from "../../components/ui/apple-color-picker";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

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
  { action: "strikethrough", label: "Strikethrough", icon: Strikethrough },
  { action: "quote", label: "Quote", icon: Quote },
  { action: "comment", label: "Comment", icon: MessageSquareText, separated: true },
];

const headingLevels = [
  ["Part", "part"],
  ["Chapter", "chapter"],
  ["Section", "section"],
  ["Subsection", "subsection"],
  ["Subsubsection", "subsubsection"],
] as const;

export function LatexSelectionToolbar(props: {
  position: LatexSelectionToolbarPosition;
  canComment: boolean;
  commentOnly?: boolean;
  onAction: (action: LatexSelectionAction, value?: string) => void;
  onDismiss: () => void;
}) {
  const [linkUrl, setLinkUrl] = useState("https://");
  const [linkOpen, setLinkOpen] = useState(false);
  const [highlightColor, setHighlightColor] = useState("#FFFF00");
  const [highlightOpacity, setHighlightOpacity] = useState(100);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const applyHighlight = (color: string, opacityPercent: number) => {
    setHighlightColor(color);
    setHighlightOpacity(opacityPercent);
    const opacity = opacityPercent / 100;
    const channels = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(color.slice(offset, offset + 2), 16);
      return Math.round(channel * opacity + 255 * (1 - opacity)).toString(16).padStart(2, "0");
    });
    props.onAction("highlight", `#${channels.join("")}`.toUpperCase());
    setHighlightOpen(false);
  };
  const visibleActions = props.commentOnly
    ? actions.filter(({ action }) => action === "comment" && props.canComment)
    : props.canComment
      ? actions
      : actions.filter(({ action }) => action !== "comment");
  const onDismiss = props.onDismiss;
  useEffect(() => {
    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".latex-selection-toolbar-anchor, .latex-tool-menu, .latex-highlight-picker")) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointerDown, true);
  }, [onDismiss]);
  return createPortal(
    <div
      className={`latex-selection-toolbar-anchor${props.position.below ? " below" : ""}`}
      style={{
        left: props.position.left,
        top: props.position.top,
        maxWidth: props.position.maxWidth,
      }}
      role="toolbar"
      aria-label={props.commentOnly ? "Comment on selected Markdown" : "Format selected LaTeX"}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("input")) event.preventDefault();
      }}
    >
      <PopIn className="latex-selection-toolbar">
        {visibleActions.map(({ action, label, tooltip, icon: Icon, separated }) => (
          <span key={action} className={separated ? "latex-selection-tool separated" : "latex-selection-tool"}>
            <Tip label={tooltip ?? label} side="top">
              <button type="button" aria-label={label} onClick={() => props.onAction(action)}>
                <Icon size={14} strokeWidth={1.8} />
              </button>
            </Tip>
          </span>
        ))}
        {!props.commentOnly && <>
        <span className="latex-selection-tool separated">
          <Popover open={linkOpen} onOpenChange={setLinkOpen}>
            <Tip label="Link" side="top">
              <PopoverTrigger asChild><button type="button" aria-label="Link"><Link size={14} strokeWidth={1.8} /></button></PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className="latex-tool-menu link-menu">
              <label>Link URL<Input controlSize="compact" autoFocus value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && linkUrl.trim()) {
                  props.onAction("link", linkUrl.trim());
                  setLinkOpen(false);
                }
              }} /></label>
              <button type="button" aria-label="Apply link" disabled={!linkUrl.trim()} onClick={() => { props.onAction("link", linkUrl.trim()); setLinkOpen(false); }}>Apply</button>
            </PopoverContent>
          </Popover>
        </span>
        <span className="latex-selection-tool">
          <Popover>
            <Tip label="Heading level" side="top">
              <PopoverTrigger asChild><button type="button" aria-label="Heading level"><Heading size={14} strokeWidth={1.8} /></button></PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className="latex-tool-menu heading-menu">
              {headingLevels.map(([label, command]) => <button key={command} type="button" onClick={() => props.onAction("heading", command)}><span>{label}</span><code>\{command}</code></button>)}
            </PopoverContent>
          </Popover>
        </span>
        <span className="latex-selection-tool separated">
          <Popover open={highlightOpen} onOpenChange={setHighlightOpen}>
            <Tip label="Highlight color" side="top">
              <PopoverTrigger asChild><button type="button" aria-label="Highlight color"><Highlighter size={14} strokeWidth={1.8} /></button></PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className="latex-highlight-picker">
              <AppleColorPicker
                value={highlightColor}
                opacity={highlightOpacity}
                onConfirm={applyHighlight}
                onCancel={() => setHighlightOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </span>
        </>}
      </PopIn>
    </div>,
    document.body,
  );
}
