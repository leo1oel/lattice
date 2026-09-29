/**
 * References to other pages and papers (spec R-INL-6, R-INL-7, R-FMT-17,
 * R-FMT-18):
 *
 * - Typing `[[` offers the project's pages from the workspace index, filtered
 *   as the query grows; `[[Page#` offers that page's headings. Choosing one
 *   writes `[[docName]]` or `[[docName#heading-slug]]`.
 * - Typing `@` offers the library's papers that have local content, matching
 *   every word of the query against title and citation key; choosing one
 *   writes a citation chip linking the paper's reading file, then a space.
 * - A paper dropped from the Papers list becomes a `@key` citation at the
 *   pointer; papers from another project, and drops into a read-only
 *   document, are ignored.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the extensions and their listboxes belong together */
import { useLingui } from "@lingui/react/macro";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { FileText, Hash, Newspaper } from "lucide-react";
import type { PaperSummary } from "../../../../app-types";
import { hasPaperDrag, paperCitationLabel, resolvePaperDrag } from "../../../../papers/paper-drag";
import { paperLinkHref } from "../../../../papers/paper-link";
import type { MarkdownDocEntry } from "../../markdown-workspace-index";
import type { ChromeHost } from "./chrome-host";
import { SuggestionListbox, suggestionExtension, type MenuStore } from "./suggestion-menu";

// --- Wiki links -------------------------------------------------------------

export type PageSuggestion =
  | { kind: "page"; doc: MarkdownDocEntry }
  | { kind: "heading"; doc: MarkdownDocEntry; text: string; slug: string; level: number };

const pageKey = (item: PageSuggestion) => (item.kind === "page" ? item.doc.path : `${item.doc.path}#${item.slug}`);

/** Pages for `query`, or a page's headings once the query names a page and a `#`. */
export function pageSuggestions(host: ChromeHost, query: string): PageSuggestion[] {
  const index = host.props().workspaceIndex;
  if (!index) return [];
  const hash = query.indexOf("#");
  if (hash >= 0) {
    const doc = index.getDoc(query.slice(0, hash).trim());
    if (!doc) return [];
    const part = query.slice(hash + 1).toLowerCase();
    return doc.headings
      .filter((heading) => heading.text.toLowerCase().includes(part) || heading.slug.includes(part))
      .map((heading) => ({ kind: "heading", doc, text: heading.text, slug: heading.slug, level: heading.level }));
  }
  return index.searchPages(query, 20).map((doc) => ({ kind: "page", doc }));
}

export function wikiLinkExtension(store: MenuStore<PageSuggestion>, host: ChromeHost) {
  return suggestionExtension<PageSuggestion>({
    name: "latticeWikiLinks",
    char: "[[",
    allowSpaces: true,
    allowedPrefixes: null,
    store,
    items: (query) => pageSuggestions(host, query),
    onSelect: (editor, range, item) => {
      const target = item.kind === "page" ? item.doc.docName : `${item.doc.docName}#${item.slug}`;
      // A typed closing `]]` right after the query belongs to the link too.
      const to = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size)) === "]]" ? range.to + 2 : range.to;
      const transaction = editor.state.tr.replaceWith(range.from, to, editor.schema.nodes.latticeWikiLink!.create({ target }));
      transaction.setSelection(TextSelection.create(transaction.doc, range.from + 1));
      editor.view.dispatch(transaction);
      editor.view.focus();
    },
  });
}

export function WikiLinkMenu({ editor, store }: { editor: Editor; store: MenuStore<PageSuggestion> }) {
  const { t } = useLingui();
  return (
    <SuggestionListbox
      editor={editor}
      store={store}
      label={t`Wiki link suggestions`}
      emptyLabel={t`No matching pages`}
      itemKey={pageKey}
      renderItem={(item) => (item.kind === "page"
        ? (
          <>
            <span className="lx-md-menu-icon" aria-hidden="true"><FileText /></span>
            <span className="lx-md-menu-label">{item.doc.title}</span>
            <span className="lx-md-menu-detail">{item.doc.path}</span>
          </>
        )
        : (
          <>
            <span className="lx-md-menu-icon" aria-hidden="true"><Hash /></span>
            <span className="lx-md-menu-label" style={{ paddingInlineStart: `${(item.level - 1) * 0.75}em` }}>{item.text}</span>
          </>
        ))}
    />
  );
}

// --- Citations --------------------------------------------------------------

/** Papers with local content (full text or blog), matching every word of `query` against title and key. */
export function matchPapers(papers: readonly PaperSummary[], query: string): PaperSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  return papers.filter((paper) => {
    if (!paper.arxivId || !(paper.hasFullText || paper.hasBlog)) return false;
    const key = `${paper.arxivId}\0${paper.citationKey ?? ""}`;
    if (seen.has(key)) return false;
    const haystack = `${paper.title} ${paper.citationKey ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
    seen.add(key);
    return true;
  });
}

export function citationExtension(store: MenuStore<PaperSummary>, host: ChromeHost) {
  return suggestionExtension<PaperSummary>({
    name: "latticeCitations",
    char: "@",
    allowSpaces: true,
    store,
    items: (query) => matchPapers(host.props().papers ?? [], query),
    onSelect: (editor, range, paper) => {
      const citation = editor.schema.nodes.latticeCitation!.create({ label: paper.title, href: paperLinkHref(host.props().activePath, paper) });
      const transaction = editor.state.tr.replaceWith(range.from, range.to, [citation, editor.schema.text(" ")]);
      transaction.setSelection(TextSelection.create(transaction.doc, range.from + 2));
      editor.view.dispatch(transaction);
      editor.view.focus();
    },
  });
}

export function CitationMenu({ editor, store }: { editor: Editor; store: MenuStore<PaperSummary> }) {
  const { t } = useLingui();
  return (
    <SuggestionListbox
      editor={editor}
      store={store}
      label={t`Paper citation suggestions`}
      emptyLabel={t`No matching papers`}
      itemKey={(paper) => `${paper.arxivId}\0${paper.citationKey ?? ""}`}
      renderItem={(paper) => (
        <>
          <span className="lx-md-menu-icon" aria-hidden="true"><Newspaper /></span>
          <span className="lx-md-menu-label">{paper.title}</span>
          {paper.citationKey && <span className="lx-md-menu-detail">{paper.citationKey}</span>}
        </>
      )}
    />
  );
}

/** A paper dropped from the library becomes a `@key` citation at the pointer (R-FMT-17). */
export function paperDropExtension(host: ChromeHost) {
  return Extension.create({
    name: "latticePaperDrop",
    addProseMirrorPlugins: () => [new Plugin({
      key: new PluginKey("latticePaperDrop"),
      props: {
        handleDrop(view, event) {
          const data = event.dataTransfer;
          if (!hasPaperDrag(data)) return false;
          event.preventDefault();
          const { projectRoot = "", papers = [], activePath } = host.props();
          const paper = view.editable ? resolvePaperDrag(data, projectRoot, papers) : undefined;
          if (!paper?.arxivId || !(paper.hasFullText || paper.hasBlog)) return true;
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          const citation = view.state.schema.nodes.latticeCitation!.create({ label: paperCitationLabel(paper), href: paperLinkHref(activePath, paper) });
          const transaction = view.state.tr.insert(position, citation);
          transaction.setSelection(TextSelection.create(transaction.doc, position + 1));
          view.dispatch(transaction);
          event.stopPropagation();
          return true;
        },
      },
    })],
  });
}
