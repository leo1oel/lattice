/**
 * Links in the visual engine (spec R-FMT-4, R-CHR-4, R-INL-7):
 *
 * - The link editor edits a link's URL (and a citation's title as well).
 *   Done or a click outside commits, Escape cancels, Remove unlinks and keeps
 *   the text. A `javascript:` or similar URL is refused.
 * - The hover card opens after a 300 ms dwell on a link and closes 150 ms
 *   after the pointer leaves both. External links show their page's metadata;
 *   project links and citations offer Edit link and fetch nothing.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the Mod-K request and the editor it opens belong together */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { getMarkRange } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { ExternalLink, Pencil } from "lucide-react";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { projectAssetMarkdownHref } from "../../markdown-link-routing";
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";
import { PAPER_HREF } from "../inline-syntax";
import type { ChromeHost } from "./chrome-host";
import { loadLinkPreview, type LinkMetadata } from "./link-preview";

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data|file):/i;
const EXTERNAL_URL = /^(?:https?:|mailto:)/i;

/** Place `element` below `rect`, flipping above when there is no room. */
function place(element: HTMLElement, rect: DOMRect) {
  void computePosition({ getBoundingClientRect: () => rect }, element, {
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
}

function rangeRect(editor: Editor, from: number, to: number): DOMRect {
  const start = editor.view.coordsAtPos(from);
  const end = editor.view.coordsAtPos(Math.max(from, to), -1);
  return new DOMRect(Math.min(start.left, end.left), start.top, Math.max(1, Math.abs(end.right - start.left)), end.bottom - start.top);
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Project pages to offer for a typed relative link, written relative to the
 * current file. Nothing is offered for an empty field, an external URL or an
 * in-page anchor, or once the field holds a page's path exactly.
 */
function pathSuggestions(props: VisualMarkdownEditorProps, value: string): { href: string; title: string }[] {
  const typed = value.trim();
  if (!typed || SCHEME.test(typed) || typed.startsWith("#") || typed.startsWith("//") || !props.workspaceIndex) return [];
  const query = typed.replace(/^(?:\.{1,2}\/)+/, "").replace(/\.mdx?$/i, "");
  const pages = props.workspaceIndex.searchPages(query, 8)
    .filter((page) => page.path !== props.activePath)
    .map((page) => ({ href: projectAssetMarkdownHref(props.activePath, page.path), title: page.title }));
  return pages.some((page) => page.href === typed) ? [] : pages;
}

/** Open the link editor for the link at, or the text selected around, the caret. */
export function requestLinkEditor(editor: Editor, host: ChromeHost): boolean {
  const { state } = editor;
  const { selection } = state;
  const { from, to, empty, $from } = selection;
  // A selected citation chip, or the caret right before or after one, edits the citation.
  const chip = selection instanceof NodeSelection ? selection.node
    : empty ? ($from.nodeAfter?.type.name === "latticeCitation" ? $from.nodeAfter : $from.nodeBefore) : null;
  if (chip?.type.name === "latticeCitation") {
    host.ask({ kind: "citation", at: chip === $from.nodeBefore && !(selection instanceof NodeSelection) ? from - chip.nodeSize : from });
    return true;
  }
  const link = state.schema.marks.link!;
  const range = getMarkRange($from, link);
  if (range && (empty || (range.from <= from && range.to >= to))) {
    host.ask({ kind: "link", from: range.from, to: range.to });
    return true;
  }
  if (empty) return false;
  host.ask({ kind: "link", from, to });
  return true;
}

function useRequest(host: ChromeHost) {
  return useSyncExternalStore(host.subscribe, () => host.request, () => host.request);
}

/** Close when the pointer goes down outside `element`, committing first. */
function useOutsideCommit(element: HTMLElement | null, active: boolean, commit: () => void) {
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (element && !element.contains(event.target as Node)) latest.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, element]);
}

export function LinkEditor({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const request = useRequest(host);
  if (request?.kind === "link") return <TextLinkEditor key={`${request.from}:${request.to}`} editor={editor} host={host} from={request.from} to={request.to} />;
  if (request?.kind === "citation") return <CitationEditor key={request.at} editor={editor} host={host} at={request.at} />;
  return null;
}

function TextLinkEditor({ editor, host, from, to }: { editor: Editor; host: ChromeHost; from: number; to: number }) {
  const { t } = useLingui();
  const link = editor.schema.marks.link!;
  const initial = String(editor.state.doc.rangeHasMark(from, to, link)
    ? editor.state.doc.nodeAt(from)?.marks.find((mark) => mark.type === link)?.attrs.href ?? ""
    : "");
  const [url, setUrl] = useState(initial);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  // Suggestions follow typing only: an existing link's URL does not open them.
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = typing ? pathSuggestions(host.props(), url) : [];
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const choose = (href: string) => {
    setUrl(href);
    setTyping(false);
    setActive(-1);
  };
  useLayoutEffect(() => {
    if (element) place(element, rangeRect(editor, from, to));
  }, [editor, element, from, to]);

  const finish = () => {
    host.clear();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, Math.min(to, editor.state.doc.content.size))));
    editor.view.focus();
  };
  const commit = () => {
    const href = url.trim();
    if (UNSAFE_URL.test(href)) return;
    const transaction = editor.state.tr;
    if (!href) transaction.removeMark(from, to, link);
    else if (href !== initial) transaction.removeMark(from, to, link).addMark(from, to, link.create({ href }));
    if (transaction.docChanged) editor.view.dispatch(transaction);
    finish();
  };
  const remove = () => {
    editor.view.dispatch(editor.state.tr.removeMark(from, to, link));
    finish();
  };
  const cancel = () => {
    // An inserted placeholder that never got a URL is not left as an empty link.
    if (!initial) editor.view.dispatch(editor.state.tr.removeMark(from, to, link));
    finish();
  };
  useOutsideCommit(element, true, commit);

  return createPortal(
    <div ref={setElement} className="lx-md-link-editor" role="dialog" aria-label={t`Edit link`} style={{ position: "fixed", left: 0, top: 0 }}>
      <Input
        autoFocus
        controlSize="compact"
        role="combobox"
        aria-label={t`Link URL`}
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length ? listId : undefined}
        aria-activedescendant={suggestions[active] ? optionId(active) : undefined}
        placeholder={t`Paste or type a link`}
        value={url}
        aria-invalid={UNSAFE_URL.test(url) || undefined}
        spellCheck={false}
        onChange={(event) => {
          setUrl(event.target.value);
          setTyping(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
            event.preventDefault();
            const last = suggestions.length - 1;
            setActive(event.key === "ArrowDown" ? (active >= last ? 0 : active + 1) : (active <= 0 ? last : active - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (suggestions[active]) choose(suggestions[active].href);
            else commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (suggestions.length) setTyping(false);
            else cancel();
          }
        }}
      />
      {typing && url.trim() && !SCHEME.test(url.trim()) && !url.trim().startsWith("#") && (
        suggestions.length ? (
          <div id={listId} className="lx-md-link-paths" role="listbox" aria-label={t`Path suggestions`}>
            {suggestions.map((page, index) => (
              <div
                key={page.href}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className="lx-md-link-path"
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(page.href);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="lx-md-link-path-href">{page.href}</span>
                <span className="lx-md-link-path-title">{page.title}</span>
              </div>
            ))}
          </div>
        ) : (
          host.props().workspaceIndex && <div className="lx-md-link-paths is-empty" role="status">{t`No matching paths`}</div>
        )
      )}
      <span className="lx-md-link-editor-actions">
        {initial && <Button variant="ghost" size="compact" onClick={remove}>{t`Remove`}</Button>}
        <Button variant="primary" size="compact" onClick={commit}>{t`Done`}</Button>
      </span>
    </div>,
    document.body,
  );
}

/**
 * A citation's title and URL. A library path keeps the chip; a safe external
 * URL turns it into an ordinary link; Remove leaves the title as plain text.
 */
function CitationEditor({ editor, host, at }: { editor: Editor; host: ChromeHost; at: number }) {
  const { t } = useLingui();
  const node = editor.state.doc.nodeAt(at);
  const [label, setLabel] = useState(String(node?.attrs.label ?? ""));
  const [href, setHref] = useState(String(node?.attrs.href ?? ""));
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (element && node) place(element, rangeRect(editor, at, at + node.nodeSize));
  }, [at, editor, element, node]);

  const finish = () => {
    host.clear();
    editor.view.focus();
  };
  const current = () => {
    const live = editor.state.doc.nodeAt(at);
    return live?.type.name === "latticeCitation" ? live : null;
  };
  const commit = () => {
    const live = current();
    const url = href.trim();
    const title = label.trim() || String(live?.attrs.label ?? "");
    if (!live || UNSAFE_URL.test(url) || !url) return;
    const { schema } = editor.state;
    if (PAPER_HREF.test(url)) {
      if (title !== live.attrs.label || url !== live.attrs.href) editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...live.attrs, label: title, href: url }));
    } else if (EXTERNAL_URL.test(url)) {
      editor.view.dispatch(editor.state.tr.replaceWith(at, at + live.nodeSize, schema.text(title, [schema.marks.link!.create({ href: url })])));
    } else {
      return;
    }
    finish();
  };
  const remove = () => {
    const live = current();
    if (live) editor.view.dispatch(editor.state.tr.replaceWith(at, at + live.nodeSize, editor.schema.text(String(live.attrs.label))));
    finish();
  };
  useOutsideCommit(element, true, commit);
  if (!node) return null;
  const keys = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  };
  return createPortal(
    <div ref={setElement} className="lx-md-link-editor is-citation" role="dialog" aria-label={t`Edit link`} style={{ position: "fixed", left: 0, top: 0 }}>
      <Input autoFocus controlSize="compact" aria-label={t`Citation title`} value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={keys} />
      <Input controlSize="compact" aria-label={t`Link URL`} value={href} spellCheck={false} aria-invalid={UNSAFE_URL.test(href) || undefined} onChange={(event) => setHref(event.target.value)} onKeyDown={keys} />
      <span className="lx-md-link-editor-actions">
        <Button variant="ghost" size="compact" onClick={remove}>{t`Remove`}</Button>
        <Button variant="primary" size="compact" onClick={commit}>{t`Done`}</Button>
      </span>
    </div>,
    document.body,
  );
}

const DWELL_MS = 300;
const GRACE_MS = 150;

type Hovered = { anchor: HTMLAnchorElement; href: string; citation: boolean };

/** The hover card for links in the editor surface. */
export function LinkHoverCard({ editor, host }: { editor: Editor; host: ChromeHost }) {
  const { t } = useLingui();
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [metadata, setMetadata] = useState<LinkMetadata | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    const surface = editor.view.dom;
    const pending = timers.current;
    const cancelClose = () => clearTimeout(pending.close);
    const onOver = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !surface.contains(anchor)) return;
      cancelClose();
      clearTimeout(pending.open);
      pending.open = setTimeout(() => {
        setHovered({ anchor, href: anchor.getAttribute("href") ?? "", citation: anchor.hasAttribute("data-lattice-citation") });
      }, DWELL_MS);
    };
    const onOut = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      clearTimeout(pending.open);
      pending.close = setTimeout(() => setHovered(null), GRACE_MS);
    };
    surface.addEventListener("mouseover", onOver);
    surface.addEventListener("mouseout", onOut);
    return () => {
      surface.removeEventListener("mouseover", onOver);
      surface.removeEventListener("mouseout", onOut);
      clearTimeout(pending.open);
      clearTimeout(pending.close);
    };
  }, [editor]);

  useEffect(() => {
    if (!hovered || !EXTERNAL_URL.test(hovered.href) || hovered.href.startsWith("mailto:")) return;
    const controller = new AbortController();
    void loadLinkPreview(hovered.href, controller.signal).then((value) => {
      if (!controller.signal.aborted) setMetadata(value);
    });
    return () => {
      controller.abort();
      setMetadata(null);
    };
  }, [hovered]);

  useLayoutEffect(() => {
    if (element && hovered) place(element, hovered.anchor.getBoundingClientRect());
  }, [element, hovered]);

  if (!hovered || !hovered.anchor.isConnected) return null;
  const external = EXTERNAL_URL.test(hovered.href);
  const edit = () => {
    const position = editor.view.posAtDOM(hovered.anchor, 0);
    setHovered(null);
    if (hovered.citation) {
      host.ask({ kind: "citation", at: position });
      return;
    }
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
    requestLinkEditor(editor, host);
  };
  return createPortal(
    <div
      ref={setElement}
      className="lx-md-link-card"
      style={{ position: "fixed", left: 0, top: 0 }}
      onMouseEnter={() => clearTimeout(timers.current.close)}
      onMouseLeave={() => {
        timers.current.close = setTimeout(() => setHovered(null), GRACE_MS);
      }}
    >
      {external && metadata && <ExternalLinkPreview metadata={metadata} />}
      <div className="lx-md-link-card-row">
        {external ? <ExternalLink className="lx-md-link-card-icon" aria-hidden="true" /> : null}
        <span className="lx-md-link-card-url" title={hovered.href}>{hovered.href}</span>
        {editor.isEditable && (
          <button type="button" className="lx-md-link-card-edit" aria-label={t`Edit link`} title={t`Edit link`} onClick={edit}>
            <Pencil aria-hidden="true" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A page's title, description and domain; its favicon only when it came inline as a `data:` URI. */
export function ExternalLinkPreview({ metadata }: { metadata: LinkMetadata }) {
  const favicon = metadata.faviconDataUri?.startsWith("data:image/") ? metadata.faviconDataUri : null;
  return (
    <div className="lx-md-link-card-preview">
      <div className="lx-md-link-card-site">
        {favicon && <img src={favicon} alt="" className="lx-md-link-card-favicon" />}
        <span>{metadata.siteName || metadata.domain}</span>
      </div>
      {metadata.title && <div className="lx-md-link-card-title">{metadata.title}</div>}
      {metadata.description && <div className="lx-md-link-card-description">{metadata.description}</div>}
    </div>
  );
}
