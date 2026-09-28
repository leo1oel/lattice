/*
 * Popup plumbing (ReactRenderer + floating-ui positioning, combobox ARIA
 * wiring, now shared in suggestion-popup.tsx) adapted from
 * visual-wiki-link-suggestion.tsx, itself adapted from inkeep/open-knowledge
 * at commit 9e8a00e24c6eaea110b546758664aad0e7ebab7e.
 * Licensed under GPL-3.0-or-later.
 */
/* eslint-disable react-refresh/only-export-components */
import { Trans, useLingui } from "@lingui/react/macro";
import { Extension, type AnyExtension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { BookOpen } from "lucide-react";
import type { PaperSummary } from "../../app-types";
import { paperLinkHref } from "../../papers/paper-link";
import { hasPaperDrag, paperCitationLabel, resolvePaperDrag } from "../../papers/paper-drag";
import { FluidHoverSurface } from "../../components/ui/fluid-hover-surface";
import { floatingSurfaceClassName } from "../../components/ui/menu-surface";
import { popupMotionClassName } from "../../components/ui/popup-motion";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  keepEditorFocus,
  listboxProps,
  optionProps,
  suggestionPopupRenderer,
  useSelectedOptionScroll,
  type SuggestionMenuProps,
} from "./suggestion-popup";

const suggestionKey = new PluginKey("visualPaperCitationSuggestion");
const menuClassName = `visual-paper-citation-menu ${floatingSurfaceClassName} ${popupMotionClassName}`;

const isLinkable = (paper: PaperSummary) => Boolean((paper.hasFullText || paper.hasBlog) && paper.arxivId);

/** Every whitespace-separated token must match title, citation key, or id. */
export function matchPapers(papers: readonly PaperSummary[], query: string): PaperSummary[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return papers.filter((paper) => {
    const haystack = `${paper.title} ${paper.citationKey ?? ""} ${paper.arxivId}`.toLocaleLowerCase();
    return isLinkable(paper) && tokens.every((token) => haystack.includes(token));
  });
}

function VisualPaperCitationMenu(props: SuggestionMenuProps<PaperSummary>) {
  const { items, selectedIndex } = props;
  const { t } = useLingui();
  const containerRef = useSelectedOptionScroll(selectedIndex);

  if (!items.length) {
    return (
      <div className={`${menuClassName} visual-paper-citation-empty`} role="status" aria-live="polite" onMouseDown={keepEditorFocus}>
        <Trans>No matching papers — import them in the Papers panel first</Trans>
      </div>
    );
  }
  return (
    <ScrollArea
      className={menuClassName}
      viewportRef={containerRef}
      viewportProps={listboxProps(props, t`Paper citation suggestions`)}
      contentClassName="fluid-hover-surface p-[var(--surface-inset)]"
      fadeEdges={false}
      onMouseDown={keepEditorFocus}
    >
      <FluidHoverSurface />
      <span className="sr-only" aria-live="polite" aria-atomic="true">{items[selectedIndex]?.title}</span>
      {items.map((item, index) => {
        const subtitle = [item.citationKey, item.arxivId ? `arXiv ${item.arxivId}` : null].filter(Boolean).join(" · ");
        return (
          <button key={item.arxivId} {...optionProps(props, item, index)} title={item.title} className="visual-paper-citation-option">
            <BookOpen aria-hidden />
            <span className="visual-paper-citation-label">
              <span className="visual-paper-citation-title">{item.title}</span>
              {subtitle && <span className="visual-paper-citation-detail">{subtitle}</span>}
            </span>
          </button>
        );
      })}
    </ScrollArea>
  );
}

/**
 * `@` typeahead over the downloaded paper library. Selecting a paper inserts
 * a plain markdown link to its cached markdown — the same
 * `.research/papers/<id>/…` path shape the agent library announces — which
 * the host routes to the Papers reading view on click. Dropping a paper from
 * the library inserts the same citation at the pointer.
 */
export function visualPaperCitationSuggestion(options: {
  getPapers: () => readonly PaperSummary[];
  getActivePath: () => string;
  getProjectRoot?: () => string;
}): AnyExtension {
  const citationLink = (paper: PaperSummary) => ({ type: "link", attrs: { href: paperLinkHref(options.getActivePath(), paper) } });
  return Extension.create({
    name: "visualPaperCitationSuggestion",
    addProseMirrorPlugins() {
      return [new Plugin({
        props: {
          handleDOMEvents: {
            dragover: (_view, event) => {
              if (!hasPaperDrag(event.dataTransfer)) return false;
              event.preventDefault();
              return true;
            },
          },
          handleDrop: (view, event) => {
            if (!hasPaperDrag(event.dataTransfer)) return false;
            event.preventDefault();
            // Paper reader surfaces let the canvas open the dropped paper.
            const projectRoot = options.getProjectRoot?.();
            if (!projectRoot) return true;
            event.stopPropagation();
            const paper = resolvePaperDrag(event.dataTransfer, projectRoot, options.getPapers());
            if (!paper || !view.editable) return true;
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (position === undefined) return true;
            const { schema } = view.state;
            const label = paperCitationLabel(paper);
            const node = isLinkable(paper)
              ? schema.nodes.paperCitation.create({ label }, null, [schema.markFromJSON(citationLink(paper))])
              : schema.text(label);
            view.dispatch(view.state.tr.insert(position, node).scrollIntoView());
            view.focus();
            return true;
          },
        },
      }), Suggestion<PaperSummary>({
        editor: this.editor,
        pluginKey: suggestionKey,
        char: "@",
        allowSpaces: true,
        items: ({ query }) => matchPapers(options.getPapers(), query),
        command: ({ editor, range, props: paper }) => {
          editor.chain().focus().deleteRange(range).insertContent([
            { type: "paperCitation", attrs: { label: paper.title }, marks: [citationLink(paper)] },
            { type: "text", text: " " },
          ]).run();
        },
        render: suggestionPopupRenderer("visual-paper-citation", "visual-paper-citation-popup", VisualPaperCitationMenu),
      })];
    },
  });
}
