import {
  Bold,
  ChevronDown,
  Heading,
  Highlighter,
  Italic,
  Link,
  MessageSquareText,
  Quote,
  SpellCheck,
  Strikethrough,
  Underline,
  WandSparkles,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { PopIn } from "../../components/ui/motion";
import { Tip } from "../../components/icon-tip";
import { HighlightPalette } from "./highlight-palette";
import { highlighterOf, rememberHighlight, useHighlightPrefs } from "./highlighters";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";

export type LatexSelectionAction =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "link"
  | "heading"
  | "quote"
  | "highlight"
  | "unhighlight"
  | "comment"
  | "proofread"
  | "polish";

/** The toolbar and the menus it opens: pointer or focus there keeps it open. */
export const SELECTION_TOOLBAR_SURFACES = ".latex-selection-toolbar-anchor, .latex-tool-menu, .latex-highlight-picker";

export type LatexSelectionToolbarPosition = {
  left: number;
  top: number;
  below: boolean;
  maxWidth: number;
};

const actions: { action: LatexSelectionAction; label: MessageDescriptor; icon: typeof Bold; separated?: boolean; shortcut?: string }[] = [
  { action: "bold", label: msg`Bold`, icon: Bold },
  { action: "italic", label: msg`Italic`, icon: Italic },
  { action: "underline", label: msg`Underline`, icon: Underline },
  { action: "strikethrough", label: msg`Strikethrough`, icon: Strikethrough },
  { action: "quote", label: msg`Quote`, icon: Quote },
  { action: "comment", label: msg`Annotate`, icon: MessageSquareText, separated: true },
  { action: "proofread", label: msg`Proofread`, icon: SpellCheck, shortcut: "⌘⌥P" },
  { action: "polish", label: msg`Polish`, icon: WandSparkles },
];

const headingLevels: { command: string; label: MessageDescriptor }[] = [
  { command: "part", label: msg`Part` },
  { command: "chapter", label: msg`Chapter` },
  { command: "section", label: msg`Section` },
  { command: "subsection", label: msg`Subsection` },
  { command: "subsubsection", label: msg`Subsubsection` },
];

export function LatexSelectionToolbar(props: {
  position: LatexSelectionToolbarPosition;
  canComment: boolean;
  commentOnly?: boolean;
  /** Offer the agent's proofread and polish (an editable LaTeX source with a project). */
  canProofread?: boolean;
  /** The colour of the highlight around the selection (`latex-highlights.ts`), or null outside one. */
  highlight?: string | null;
  /** The selection's text and the document's highlight colours, for the custom picker. */
  sample?: string;
  documentColors?: readonly string[];
  onAction: (action: LatexSelectionAction, value?: string) => void;
  onDismiss: () => void;
}) {
  const { i18n, t } = useLingui();
  const [linkUrl, setLinkUrl] = useState("https://");
  const [linkOpen, setLinkOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const highlightPrefs = useHighlightPrefs();
  const lastHighlighter = highlighterOf(highlightPrefs.last);
  const lastHighlight = lastHighlighter ? highlightPrefs.meaningOf(lastHighlighter) : highlightPrefs.last;
  const applyLink = () => {
    props.onAction("link", linkUrl.trim());
    setLinkOpen(false);
  };
  const applyHighlight = (color: string) => {
    rememberHighlight(color);
    props.onAction("highlight", color);
    setHighlightOpen(false);
  };
  const visibleActions = actions.filter(({ action }) => action === "comment" ? props.canComment
    : action === "proofread" || action === "polish" ? Boolean(props.canProofread) && !props.commentOnly : !props.commentOnly);
  const onDismiss = props.onDismiss;
  useEffect(() => {
    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(SELECTION_TOOLBAR_SURFACES)) return;
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
      aria-label={props.commentOnly ? t`Comment on selected Markdown` : t`Format selected LaTeX`}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("input")) event.preventDefault();
      }}
    >
      <PopIn className="latex-selection-toolbar" side={props.position.below ? "bottom" : "top"}>
        {visibleActions.map(({ action, label: descriptor, icon: Icon, separated, shortcut }, index) => {
          const label = i18n._(descriptor);
          return (
            <span key={action} className={separated && index > 0 ? "latex-selection-tool separated" : "latex-selection-tool"}>
              <Tip label={shortcut ? <>{label} <kbd>{shortcut}</kbd></> : label} side="top">
                <button type="button" aria-label={label} onClick={() => props.onAction(action)}>
                  <Icon size={14} strokeWidth={1.8} />
                </button>
              </Tip>
            </span>
          );
        })}
        {!props.commentOnly && <>
        <span className="latex-selection-tool separated">
          <Popover open={linkOpen} onOpenChange={setLinkOpen}>
            <Tip label={t`Link`} side="top">
              <PopoverTrigger asChild><button type="button" aria-label={t`Link`}><Link size={14} strokeWidth={1.8} /></button></PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className="latex-tool-menu link-menu">
              <label>{t`Link URL`}<Input controlSize="compact" autoFocus value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && linkUrl.trim()) applyLink();
              }} /></label>
              <button type="button" aria-label={t`Apply link`} disabled={!linkUrl.trim()} onClick={applyLink}>{t`Apply`}</button>
            </PopoverContent>
          </Popover>
        </span>
        <span className="latex-selection-tool">
          <Popover>
            <Tip label={t`Heading level`} side="top">
              <PopoverTrigger asChild><button type="button" aria-label={t`Heading level`}><Heading size={14} strokeWidth={1.8} /></button></PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className="latex-tool-menu heading-menu fluid-hover-surface">
              <FluidHoverSurface selector=".heading-menu > button" follow={null} />
              {headingLevels.map(({ command, label }) => <button key={command} type="button" onClick={() => props.onAction("heading", command)}><span>{i18n._(label)}</span><code>\{command}</code></button>)}
            </PopoverContent>
          </Popover>
        </span>
        {/* A split control: the pen applies the last highlighter at once (the
            bar under it is its colour), the caret opens the palette. */}
        <span className="latex-selection-tool separated hl-split">
          <Tip label={t`Highlight: ${lastHighlight}`} side="top">
            <button type="button" className="hl-pen" onClick={() => applyHighlight(highlightPrefs.last)}>
              <Highlighter size={14} strokeWidth={1.8} />
              <span className="hl-pen-bar" style={{ background: highlightPrefs.last }} aria-hidden="true" />
            </button>
          </Tip>
          <Popover open={highlightOpen} onOpenChange={setHighlightOpen}>
            <Tip label={t`Highlight color`} side="top">
              <PopoverTrigger asChild>
                <button type="button" className="hl-caret" aria-label={t`Highlight color`}><ChevronDown size={12} strokeWidth={1.8} /></button>
              </PopoverTrigger>
            </Tip>
            <PopoverContent
              side="top"
              sideOffset={8}
              className="latex-highlight-picker"
              onOpenAutoFocus={(event) => event.preventDefault()}
              // Esc in a meaning being renamed reverts the name; the next one closes.
              onEscapeKeyDown={(event) => {
                if (event.target instanceof Element && event.target.closest(".hl-rename-input")) event.preventDefault();
              }}
            >
              <HighlightPalette
                current={props.highlight ?? null}
                sample={props.sample}
                documentColors={props.documentColors}
                onApply={applyHighlight}
                onRemove={() => {
                  props.onAction("unhighlight");
                  setHighlightOpen(false);
                }}
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
