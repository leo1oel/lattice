import {
  Bold,
  ChevronDown,
  Heading,
  Highlighter,
  Italic,
  Link,
  MessageSquareText,
  PencilLine,
  Quote,
  SpellCheck,
  Strikethrough,
  Underline,
  WandSparkles,
} from "lucide-react";
import { createPortal } from "react-dom";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { comboText, type KeyCombo } from "../../app/key-combos";
import { useExitPicture } from "../../components/ui/exit-picture";
import { popupMotionClassName } from "../../components/ui/popup-motion";
import { Tip } from "../../components/icon-tip";
import { HighlightPalette } from "./highlight-palette";
import type { LatexSelectionFormats } from "./latex-format-toggle";
import { highlighterOf, rememberHighlight, useHighlightPrefs } from "./highlighters";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import { selectionToolbarMenuClassName } from "../../components/ui/menu-surface";
import { chunk, lazyChunk } from "../../lib/lazy-chunk";
import { listenForRewriteMenu } from "./selection-toolbar-placement";

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
  | "polish"
  /** Rewrite by the writer's own instruction, which is the value. */
  | "rewrite";

/** The toolbar and the menus it opens: pointer or focus there keeps it open. */
export const SELECTION_TOOLBAR_SURFACES = ".latex-selection-toolbar-anchor, .latex-tool-menu, .latex-highlight-picker, .lx-md-toolbar-layer";

export type LatexSelectionToolbarPosition = {
  left: number;
  top: number;
  below: boolean;
  maxWidth: number;
  /** The editor's box, inset: the toolbar, measured once drawn, stays inside it. */
  bounds?: { left: number; right: number };
};

const actions: { action: LatexSelectionAction; label: MessageDescriptor; icon: typeof Bold; separated?: boolean; shortcut?: KeyCombo }[] = [
  { action: "bold", label: msg`Bold`, icon: Bold },
  { action: "italic", label: msg`Italic`, icon: Italic },
  { action: "underline", label: msg`Underline`, icon: Underline },
  { action: "strikethrough", label: msg`Strikethrough`, icon: Strikethrough },
  { action: "quote", label: msg`Quote`, icon: Quote },
  { action: "comment", label: msg`Annotate`, icon: MessageSquareText, separated: true },
  { action: "proofread", label: msg`Proofread`, icon: SpellCheck, shortcut: { key: "p", mod: true, alt: true } },
  { action: "polish", label: msg`Polish`, icon: WandSparkles },
];

// The Rewrite menu is its own chunk: most selections never open it. Pointing
// at the button starts the import, so the menu usually renders on the click
// without a Suspense round.
const loadInstructionMenu = chunk(() => import("./selection-instruction-menu"));
const SelectionInstructionMenu = lazyChunk(loadInstructionMenu, (module) => module.SelectionInstructionMenu);
const warmInstructionMenu = () => void loadInstructionMenu().catch(() => { /* The open reports a failed chunk. */ });

const headingLevels: { command: string; label: MessageDescriptor }[] = [
  { command: "part", label: msg`Part` },
  { command: "chapter", label: msg`Chapter` },
  { command: "section", label: msg`Section` },
  { command: "subsection", label: msg`Subsection` },
  { command: "subsubsection", label: msg`Subsubsection` },
];

type ToolsProps = {
  canComment: boolean;
  commentOnly?: boolean;
  /** Offer the agent's proofread, polish and rewrite (an editable LaTeX source with a project). */
  canProofread?: boolean;
  /** The colour of the highlight around the selection (`latex-highlights.ts`), or null outside one. */
  highlight?: string | null;
  /** The formats the selection is already in (`latex-format-toggle.ts`): their buttons show pressed, and take them off. */
  formats?: LatexSelectionFormats | null;
  /** The selection's text and the document's highlight colours, for the custom picker. */
  sample?: string;
  documentColors?: readonly string[];
  onAction: (action: LatexSelectionAction, value?: string) => void;
};

export function LatexSelectionToolbar(props: ToolsProps & {
  position: LatexSelectionToolbarPosition;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const { position, onDismiss, canComment, commentOnly, canProofread, highlight, formats, sample, documentColors, onAction } = props;
  // It grows from the selection as every popup does and, gone, fades where it stood.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useExitPicture([anchorRef]);
  // Its centre as placed, moved in so its real width (the placement only
  // estimates it) never crosses the editor's edge.
  const [width, setWidth] = useState(0);
  // Its buttons follow these props, and a new placement may wrap it to another width.
  useLayoutEffect(() => setWidth(anchorRef.current?.offsetWidth ?? 0), [position, canComment, canProofread, commentOnly]);
  const { bounds } = position;
  const left = bounds && width ? Math.min(Math.max(position.left, bounds.left + width / 2), bounds.right - width / 2) : position.left;
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
      ref={anchorRef}
      className={`latex-selection-toolbar-anchor ${popupMotionClassName}${position.below ? " below" : ""}`}
      data-side={position.below ? "bottom" : "top"}
      style={{ left, top: position.top, maxWidth: position.maxWidth }}
      role="toolbar"
      aria-label={commentOnly ? t`Comment on selected Markdown` : t`Format selected LaTeX`}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("input")) event.preventDefault();
      }}
    >
      {/* Apart from the placement: a scroll with a selection held moves the
          toolbar every frame, and only the anchor above follows it. */}
      <SelectionTools
        canComment={canComment}
        commentOnly={commentOnly}
        canProofread={canProofread}
        highlight={highlight}
        formats={formats}
        sample={sample}
        documentColors={documentColors}
        onAction={onAction}
      />
    </div>,
    document.body,
  );
}

function SelectionTools(props: ToolsProps) {
  const { i18n, t } = useLingui();
  const { onAction } = props;
  const [linkUrl, setLinkUrl] = useState("https://");
  const [linkOpen, setLinkOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const highlightPrefs = useHighlightPrefs();
  const lastHighlighter = highlighterOf(highlightPrefs.last);
  const lastHighlight = lastHighlighter ? highlightPrefs.meaningOf(lastHighlighter) : highlightPrefs.last;
  const applyLink = () => {
    onAction("link", linkUrl.trim());
    setLinkOpen(false);
  };
  const applyHighlight = (color: string) => {
    rememberHighlight(color);
    onAction("highlight", color);
    setHighlightOpen(false);
  };
  const canAskAgent = Boolean(props.canProofread) && !props.commentOnly;
  const { formats } = props;
  const pressed = (action: LatexSelectionAction) => {
    if (!formats) return undefined;
    if (action === "quote") return formats.quote;
    return action === "bold" || action === "italic" || action === "underline" || action === "strikethrough"
      ? formats.inline.has(action) : undefined;
  };
  const visibleActions = actions.filter(({ action }) => action === "comment" ? props.canComment
    : action === "proofread" || action === "polish" ? canAskAgent : !props.commentOnly);
  // The palette's Rewrite selection… opens the menu its button opens.
  useEffect(() => (canAskAgent ? listenForRewriteMenu(() => {
    warmInstructionMenu();
    setRewriteOpen(true);
  }) : undefined), [canAskAgent]);
  return (
    <div className="latex-selection-toolbar">
      {visibleActions.map(({ action, label: descriptor, icon: Icon, separated, shortcut }, index) => {
        const label = i18n._(descriptor);
        return (
          <span key={action} className={separated && index > 0 ? "latex-selection-tool separated" : "latex-selection-tool"}>
            <Tip label={shortcut ? <>{label} <kbd>{comboText(shortcut)}</kbd></> : label} side="top">
              <button type="button" aria-label={label} aria-pressed={pressed(action)} onClick={() => onAction(action)}>
                <Icon size={14} strokeWidth={1.8} />
              </button>
            </Tip>
          </span>
        );
      })}
      {canAskAgent && (
        <span className="latex-selection-tool">
          <Popover open={rewriteOpen} onOpenChange={setRewriteOpen}>
            <Tip label={t`Rewrite with an instruction`} side="top">
              <PopoverTrigger asChild>
                <button type="button" aria-label={t`Rewrite with an instruction`} onPointerEnter={warmInstructionMenu} onFocus={warmInstructionMenu}>
                  <PencilLine size={14} strokeWidth={1.8} />
                </button>
              </PopoverTrigger>
            </Tip>
            <PopoverContent side="top" sideOffset={8} className={`latex-tool-menu instruction-menu ${selectionToolbarMenuClassName}`}>
              <Suspense fallback={null}>
                <SelectionInstructionMenu onSubmit={(instruction) => onAction("rewrite", instruction)} />
              </Suspense>
            </PopoverContent>
          </Popover>
        </span>
      )}
      {!props.commentOnly && <>
      <span className="latex-selection-tool separated">
        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <Tip label={t`Link`} side="top">
            <PopoverTrigger asChild><button type="button" aria-label={t`Link`} aria-pressed={formats ? formats.link : undefined}><Link size={14} strokeWidth={1.8} /></button></PopoverTrigger>
          </Tip>
          <PopoverContent side="top" sideOffset={8} className={`latex-tool-menu link-menu ${selectionToolbarMenuClassName}`}>
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
            <PopoverTrigger asChild><button type="button" aria-label={t`Heading level`} aria-pressed={formats ? Boolean(formats.heading) : undefined}><Heading size={14} strokeWidth={1.8} /></button></PopoverTrigger>
          </Tip>
          <PopoverContent side="top" sideOffset={8} className={`latex-tool-menu heading-menu fluid-hover-surface ${selectionToolbarMenuClassName}`}>
            <FluidHoverSurface selector=".heading-menu > button" follow={null} />
            {/* The selection's own level is pressed: choosing it again makes the text plain. */}
            {headingLevels.map(({ command, label }) => <button key={command} type="button" aria-pressed={formats ? formats.heading === command : undefined} onClick={() => onAction("heading", command)}><span>{i18n._(label)}</span><code>\{command}</code></button>)}
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
            className={`latex-highlight-picker ${selectionToolbarMenuClassName}`}
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
                onAction("unhighlight");
                setHighlightOpen(false);
              }}
              onCancel={() => setHighlightOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </span>
      </>}
    </div>
  );
}
