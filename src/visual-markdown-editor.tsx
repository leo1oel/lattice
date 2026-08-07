import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor } from "@tiptap/react";
import { Extension, posToDOMRect, type NodeViewProps } from "@tiptap/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getMarkdownManager, parseVisualMarkdown, visualEditorExtensions } from "./visual-markdown-schema";
import { SourceDirtyObserver } from "./visual-source-dirty-observer";
import { visualWikiLinkSuggestion } from "./visual-wiki-link-suggestion";
import { visualPaperCitationSuggestion } from "./visual-paper-citation-suggestion";
import type { PaperSummary } from "./app-types";
import type { TrackedChangeTooltipActions } from "./overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";
import { dispatchTagClick, visualTag } from "./visual-tag";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { VisualLinkHover } from "./visual-link-hover";
import { TableRowEnter } from "@ok-app/editor/extensions/table-row-enter";
import {
  canonicalizeSupportedMarkdown,
  preserveMarkdownEnvelope,
  rebaseMarkdownDraft,
} from "./markdown-collab";
// Vendored Open Knowledge editor chrome (see scripts/vendor-open-knowledge.mjs).
import { BridgeIdPlugin } from "@ok-app/editor/extensions/bridge-id-plugin";
import { SelectionStatePlugin } from "@ok-app/editor/extensions/selection-state-plugin";
import {
  PRESERVE_VISUAL_VIEWPORT_META,
  VisualBlockControls,
  VisualBlockMover,
  type PreserveVisualViewportMeta,
} from "./visual-editor-block-controls";
import { VisualFixedCaret } from "./visual-fixed-caret";
import { EditorState, NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { KeyboardNav } from "@ok-app/editor/block-ux/keyboard-nav";
import { SlashCommand } from "@ok-app/editor/extensions/slash-command";
import { getSlashCommandItems } from "@ok-app/editor/slash-command/items";
import type { SlashCommandContext, SlashCommandItem } from "@ok-app/editor/slash-command/items";
import { getComponentItems, getInlineComponentItems } from "@ok-app/editor/slash-command/component-items";
import { getEmbedStarterItems } from "@ok-app/editor/slash-command/embed-starter-items";
import { TiptapFindReplace } from "@ok-app/editor/find-replace/tiptap-find-replace-extension";
import { TableInsertControls } from "@ok-app/editor/extensions/table-insert-controls";
import { FrozenTableHeaders } from "@ok-app/editor/extensions/frozen-table-headers";
import { FootnoteAnchorScroll } from "@ok-app/editor/extensions/footnote-anchor-scroll";
import { FormattingShortcuts } from "@ok-app/editor/extensions/formatting-shortcuts";
import { TabFocusTrap } from "@ok-app/editor/extensions/tab-focus-trap";
import { HeadingAnchors } from "@ok-app/editor/extensions/heading-anchors";
import { MathInputRule } from "@ok-app/editor/math-input-rule";
import { InlineLinkInputRule } from "@ok-app/editor/inline-link-input-rule";
import { setHostKatexMacros } from "@ok-app/shims/katex-macros";
import { TableCellHandles } from "@ok-app/editor/table-controls/TableCellHandles";
import { BubbleMenuBar } from "@ok-app/editor/bubble-menu/BubbleMenuBar";
import { VisualCommentProvider } from "@ok-app/comments/CommentBubbleButton";
import { ViewInSourceProvider } from "@ok-app/editor/bubble-menu/ViewInSourceBubbleButton";
import { EmojiInsertPopover } from "@ok-app/editor/components/EmojiInsertPopover";
import { MirrorHostProvider } from "@ok-app/editor/components/Mirror-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { detectClipboardPrefillUrl } from "@ok-app/editor/clipboard/lone-url";
import { ImageSrcFidelity } from "./open-knowledge-core/extensions/image-src-fidelity";
import { ProjectImageHostProvider, useProjectImageSrc } from "./project-image-host";
import type { PresenceCursor } from "./overleaf-cursors";
import { resolveCommentAnchor, type EditorComment } from "./editor-comment-data";
import { peerColorForKey } from "./collab-colors";
import { notifyError } from "./app-notify";
import { dismissAppToastByDedupeKey } from "./app-log-store";
import Zoom from "react-medium-image-zoom";
import { Check, X } from "lucide-react";
import { markdownPreviewSyncPolicy } from "./markdown-preview-sync-policy";

const EMPTY_MACROS: Record<string, string> = {};
const VISUAL_LINK_INSERT_EVENT = "research-writer:visual-link-insert";
const VISUAL_DOCUMENT_CACHE_LIMIT = 64;
const VISUAL_DOCUMENT_CACHE_TEXT_LIMIT = 4_000_000;
const TRACKED_CHANGE_HOVER_RADIUS = 24;
const TRACKED_CHANGE_CLOSE_DELAY_MS = 180;

type CachedVisualDocument = {
  path: string;
  text: string;
  content: ReturnType<typeof parseVisualMarkdown>;
  representedExactly?: boolean;
};

const visualDocumentCache = new Map<string, CachedVisualDocument>();
let visualDocumentCacheTextSize = 0;

function cachedVisualDocument(path: string, text: string): CachedVisualDocument {
  const cached = visualDocumentCache.get(path);
  if (cached?.text === text) {
    visualDocumentCache.delete(path);
    visualDocumentCache.set(path, cached);
    return cached;
  }
  if (cached) {
    visualDocumentCache.delete(path);
    visualDocumentCacheTextSize -= cached.text.length;
  }
  const entry: CachedVisualDocument = {
    path,
    text,
    content: parseVisualMarkdown(text, path),
  };
  visualDocumentCache.set(path, entry);
  visualDocumentCacheTextSize += text.length;
  while (
    visualDocumentCache.size > VISUAL_DOCUMENT_CACHE_LIMIT
    || visualDocumentCacheTextSize > VISUAL_DOCUMENT_CACHE_TEXT_LIMIT
  ) {
    const oldestPath = visualDocumentCache.keys().next().value;
    if (oldestPath == null) break;
    const oldest = visualDocumentCache.get(oldestPath);
    visualDocumentCache.delete(oldestPath);
    visualDocumentCacheTextSize -= oldest?.text.length ?? 0;
  }
  return entry;
}

/** Prime the bounded visual parse cache without mounting an editor. */
// eslint-disable-next-line react-refresh/only-export-components -- project-open idle warming shares the editor's private LRU.
export function prewarmVisualMarkdownDocument(path: string, text: string): void {
  cachedVisualDocument(path, text);
}

function cachedVisualContent(path: string, text: string): CachedVisualDocument["content"] {
  // TipTap normally constructs fresh ProseMirror nodes from JSON, but some
  // extension attributes contain nested objects. Keep the cached parse result
  // pristine across editor instances while still avoiding another parse.
  return structuredClone(cachedVisualDocument(path, text).content);
}

type VisualSourceRange = { from: number; to: number };

function visualSourceRanges(text: string, blockCount: number): VisualSourceRange[] {
  const sourceNodes = getMarkdownManager().parseToEditorMdast(text).children;
  const direct = sourceNodes.flatMap((node) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    return typeof from === "number" && typeof to === "number" ? [{ from, to }] : [];
  });
  if (direct.length === blockCount) return direct;

  // Most mdast blocks produce one ProseMirror top-level node. A mixed
  // inline/block paragraph can produce several, though, so ordinal pairing
  // shifts every later source anchor. Expand only on that uncommon mismatch:
  // parsing each original source slice tells us how many rendered blocks own
  // the same source range without making the normal scrolling path more
  // expensive.
  const expanded = direct.flatMap((range) => {
    const count = Math.max(
      1,
      parseVisualMarkdown(text.slice(range.from, range.to)).content?.length ?? 0,
    );
    return Array.from({ length: count }, () => range);
  });
  if (expanded.length === blockCount) return expanded;

  // Keep a monotonic best effort for unsupported fallback shapes. Reusing the
  // nearest known range is safer than dropping metadata and jumping to offset
  // zero when the user asks to view the block in source.
  return Array.from({ length: blockCount }, (_, index) => (
    expanded[Math.min(index, expanded.length - 1)] ?? { from: 0, to: 0 }
  ));
}

/**
 * Top-level block ranges only when the source→block mapping is certain: one
 * mdast child per rendered block, in document order, non-overlapping.
 *
 * `visualSourceRanges` deliberately degrades to a monotonic guess so scrolling
 * still lands somewhere useful. Splicing source bytes back into the document
 * cannot use a guess — a duplicated range would emit a block twice — so this
 * variant reports failure instead and its callers fall back.
 */
function exactVisualSourceRanges(text: string, blockCount: number): VisualSourceRange[] | null {
  const sourceNodes = getMarkdownManager().parseToEditorMdast(text).children;
  if (sourceNodes.length !== blockCount) return null;
  const ranges: VisualSourceRange[] = [];
  let previousEnd = 0;
  for (const node of sourceNodes) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (typeof from !== "number" || typeof to !== "number") return null;
    if (from < previousEnd || to < from) return null;
    ranges.push({ from, to });
    previousEnd = to;
  }
  return ranges;
}

function sourceOffsetForRowColumn(text: string, row: number, column: number): number {
  const lines = text.split("\n");
  const lineIndex = Math.min(Math.max(row, 0), Math.max(lines.length - 1, 0));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += lines[index]!.length + 1;
  return offset + Math.min(Math.max(column, 0), lines[lineIndex]?.length ?? 0);
}

function rowColumnForSourceOffset(text: string, sourceOffset: number): { row: number; column: number } {
  const offset = Math.min(Math.max(sourceOffset, 0), text.length);
  const before = text.slice(0, offset);
  const row = before.split("\n").length - 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { row, column: offset - lineStart };
}

function distanceFromPointToRect(x: number, y: number, rect: DOMRect): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function tableCellRanges(line: string): Array<{ from: number; to: number }> {
  const pipes = [-1];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) escapes += 1;
    if (escapes % 2 === 0) pipes.push(index);
  }
  if (pipes.length === 1) return [];
  pipes.push(line.length);
  const ranges = pipes.slice(0, -1).map((pipe, index) => ({
    from: pipe + 1,
    to: pipes[index + 1]!,
  }));
  if (pipes[1] === 0) ranges.shift();
  if (pipes[pipes.length - 2] === line.length - 1) ranges.pop();
  return ranges;
}

function isTableDelimiterLine(line: string): boolean {
  const cells = tableCellRanges(line);
  return cells.length > 0
    && cells.every(({ from, to }) => /^:?-+:?$/.test(line.slice(from, to).trim()));
}

/** A GFM delimiter row has no PM node; anchor it in the corresponding header cell. */
function visualizableTableSourceOffset(text: string, sourceOffset: number): number {
  const lineStart = text.lastIndexOf("\n", Math.max(0, sourceOffset - 1)) + 1;
  const lineEnd = text.indexOf("\n", sourceOffset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const delimiterCells = tableCellRanges(line);
  if (
    !isTableDelimiterLine(line)
    || lineStart === 0
  ) return sourceOffset;

  const previousLineEnd = lineStart - 1;
  const previousLineStart = text.lastIndexOf("\n", Math.max(0, previousLineEnd - 1)) + 1;
  const header = text.slice(previousLineStart, previousLineEnd);
  const headerCells = tableCellRanges(header);
  if (headerCells.length !== delimiterCells.length) return sourceOffset;
  // A dash-only body row has the same local shape. If this contiguous table
  // already has a delimiter above it, leave the body-row caret where it is.
  let scanEnd = previousLineStart - 1;
  while (scanEnd >= 0) {
    const scanStart = text.lastIndexOf("\n", Math.max(0, scanEnd - 1)) + 1;
    const scanLine = text.slice(scanStart, scanEnd);
    if (!tableCellRanges(scanLine).length) break;
    if (isTableDelimiterLine(scanLine)) return sourceOffset;
    scanEnd = scanStart - 1;
  }
  const column = Math.max(0, sourceOffset - lineStart);
  const cellIndex = delimiterCells.findIndex(({ from, to }) => column >= from && column <= to);
  const headerCell = headerCells[Math.max(0, cellIndex)];
  if (!headerCell) return sourceOffset;
  const rawHeader = header.slice(headerCell.from, headerCell.to);
  const leadingSpace = rawHeader.length - rawHeader.trimStart().length;
  return previousLineStart + headerCell.from + leadingSpace + rawHeader.trim().length;
}

function cursorSentinel(text: string): string {
  let sentinel = "\uE000\uE001\uE002";
  while (text.includes(sentinel)) sentinel += "\uE003";
  return sentinel;
}

/** Fence punctuation has no visual text position; do not parse it as prose. */
function sourceOffsetIsOnCodeFence(text: string, sourceOffset: number): boolean {
  const lines = text.split("\n");
  const targetLine = text.slice(0, sourceOffset).split("\n").length - 1;
  let openChar = "";
  let openLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, "");
    const match = line.match(/^ {0,3}([`~])(\1{2,})(.*)$/);
    if (!match) continue;
    const char = match[1]!;
    const length = 1 + match[2]!.length;
    if (!openChar) {
      if (index === targetLine) return true;
      openChar = char;
      openLength = length;
      continue;
    }
    const closesFence = char === openChar && length >= openLength && !match[3]!.trim();
    if (!closesFence) continue;
    if (index === targetLine) return true;
    openChar = "";
    openLength = 0;
  }
  return false;
}

/** Parse a temporary marker at the source caret and find where it lands in PM. */
function proseMirrorPositionForSourceOffset(
  doc: Editor["state"]["doc"],
  text: string,
  sourceOffset: number,
): number | null {
  let offset = visualizableTableSourceOffset(
    text,
    Math.min(Math.max(sourceOffset, 0), text.length),
  );
  if (sourceOffsetIsOnCodeFence(text, offset)) return null;
  // Overleaf and ProseMirror both count UTF-16 code units. If a malformed or
  // stale presence update points between a surrogate pair, keep the marker
  // beside the character rather than splitting it into invalid source.
  if (
    offset > 0
    && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]!)
    && /[\uDC00-\uDFFF]/.test(text[offset]!)
  ) {
    offset += 1;
  }
  const sentinel = cursorSentinel(text);
  try {
    const marked = `${text.slice(0, offset)}${sentinel}${text.slice(offset)}`;
    const parsed = doc.type.schema.nodeFromJSON(parseVisualMarkdown(marked));
    let position: number | null = null;
    parsed.descendants((node, nodePosition) => {
      if (!node.isText || position !== null) return;
      const index = node.text?.indexOf(sentinel) ?? -1;
      if (index >= 0) position = nodePosition + index;
    });
    return position === null
      ? null
      : Math.min(Math.max(position, 0), doc.content.size);
  } catch {
    return null;
  }
}

/** Serialize a temporary PM marker to obtain the exact canonical source caret. */
function sourceOffsetForProseMirrorPosition(
  editor: Editor,
  position: number,
  expectedMarkdown: string,
): { markdown: string; offset: number } | null {
  const doc = editor.state.doc;
  const sentinel = cursorSentinel(`${expectedMarkdown}\n${JSON.stringify(doc.toJSON())}`);
  try {
    const at = Math.min(Math.max(position, 0), doc.content.size);
    const transaction = editor.state.tr;
    const resolved = transaction.doc.resolve(at);
    // Pristine MDX serializes from sourceRaw. Mark only the temporary
    // containing components dirty so the sentinel in their body is visible
    // to the serializer without touching the live editor document.
    for (let depth = 1; depth <= resolved.depth; depth += 1) {
      if (resolved.node(depth).type.name === "jsxComponent") {
        transaction.setNodeAttribute(resolved.before(depth), "sourceDirty", true);
      }
    }
    const marked = transaction.insertText(sentinel, at).doc;
    const serialized = getMarkdownManager().serialize(marked.toJSON());
    const enveloped = preserveMarkdownEnvelope(serialized, expectedMarkdown);
    const offset = enveloped.indexOf(sentinel);
    return offset < 0
      ? null
      : { markdown: enveloped.replace(sentinel, ""), offset };
  } catch {
    return null;
  }
}

class VisualPresenceCaret {
  constructor(readonly name: string, readonly hue: number) {}

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "visual-overleaf-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.style.borderColor = `hsl(${this.hue}, 70%, 50%)`;
    const dot = document.createElement("span");
    dot.className = "visual-overleaf-caret-dot";
    dot.style.backgroundColor = `hsl(${this.hue}, 70%, 50%)`;
    const label = document.createElement("span");
    label.className = "visual-overleaf-caret-label";
    label.style.backgroundColor = `hsl(${this.hue}, 70%, 50%)`;
    label.textContent = this.name || "Anonymous";
    caret.append(dot, label);
    return caret;
  }

}

type VisualPresenceMeta = { text: string; cursors: PresenceCursor[] };
const visualPresenceKey = new PluginKey<VisualPresenceMeta & { decorations: DecorationSet }>(
  "visualOverleafPresence",
);

function visualPresenceDecorations(
  doc: Editor["state"]["doc"],
  text: string,
  cursors: PresenceCursor[],
): DecorationSet {
  return DecorationSet.create(doc, cursors.flatMap((cursor) => {
    const position = proseMirrorPositionForSourceOffset(
      doc,
      text,
      sourceOffsetForRowColumn(text, cursor.row, cursor.column),
    );
    return position === null ? [] : [Decoration.widget(
      position,
      () => new VisualPresenceCaret(cursor.name, cursor.hue).toDOM(),
      // A coordinate-bearing key prevents ProseMirror from reusing the old
      // widget DOM for the same collaborator after their caret moves. Keep
      // the default selection handling: ignoring DOM selections inside the
      // widget makes WebKit unable to place a local caret in the same cell.
      {
        side: 1,
        key: `${cursor.name}:${cursor.hue}:${cursor.row}:${cursor.column}`,
        // ProseMirror normally turns widget roots into contenteditable=false
        // islands. WebKit then treats the containing table cell as unclickable
        // when this zero-width widget is its caret hit target. This widget is
        // visual-only and already ignores pointers, so keep it in the cell's
        // editable DOM context instead.
        raw: true,
        stopEvent: () => false,
      },
    )];
  }));
}

const VisualOverleafPresence = Extension.create({
  name: "visualOverleafPresence",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: visualPresenceKey,
      state: {
        init: (): VisualPresenceMeta & { decorations: DecorationSet } => ({
          text: "",
          cursors: [],
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualPresenceKey) as VisualPresenceMeta | undefined;
          const text = meta?.text ?? current.text;
          const cursors = meta?.cursors ?? current.cursors;
          return {
            text,
            cursors,
            decorations: meta
              ? visualPresenceDecorations(newState.doc, text, cursors)
              : transaction.docChanged
                ? current.decorations.map(transaction.mapping, newState.doc)
                : current.decorations,
          };
        },
      },
      props: {
        decorations: (state) => visualPresenceKey.getState(state)?.decorations ?? null,
      },
    })];
  },
});

type VisualTrackChangesMeta = { text: string; changes: TrackedChange[] };
const visualTrackChangesKey = new PluginKey<VisualTrackChangesMeta & { decorations: DecorationSet }>(
  "visualOverleafTrackChanges",
);

function visualTrackChangeDecorations(
  doc: Editor["state"]["doc"],
  text: string,
  changes: TrackedChange[],
): DecorationSet {
  return DecorationSet.create(doc, changes.flatMap((change) => {
    const from = proseMirrorPositionForSourceOffset(doc, text, change.position);
    if (from === null) return [];
    const color = `hsl(${change.hue}, 70%, 50%)`;
    const attributes = {
      class: change.deletion
        ? "visual-tracked-change visual-tracked-change-delete"
        : "visual-tracked-change visual-tracked-change-insert",
      "data-visual-change-id": change.id,
      "aria-controls": "visual-tracked-change-tooltip",
      "aria-haspopup": "dialog",
      "aria-label": change.deletion ? "Suggested deletion" : "Suggested insertion",
      role: "button",
      tabindex: "0",
      style: `--visual-change-color: ${color}; --visual-change-tint: hsl(${change.hue} 70% 50% / ${change.deletion ? 0.1 : 0.14})`,
    };
    if (change.deletion) {
      return [Decoration.widget(from, () => {
        const element = document.createElement("span");
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        element.contentEditable = "false";
        element.textContent = change.text;
        return element;
      }, { side: -1, key: `deletion:${change.id}:${change.position}:${change.text}` })];
    }
    const to = proseMirrorPositionForSourceOffset(doc, text, change.position + change.text.length);
    if (to === null || to <= from || text.slice(change.position, change.position + change.text.length) !== change.text) {
      return [];
    }
    return [Decoration.inline(from, to, {
      ...attributes,
    })];
  }));
}

const EMPTY_EDITOR_COMMENTS: EditorComment[] = [];

type VisualCommentsMeta = { text: string; comments: EditorComment[]; activeId: string | null };
const visualCommentsKey = new PluginKey<VisualCommentsMeta & { decorations: DecorationSet }>(
  "visualEditorComments",
);

/**
 * Comment highlights for the preview.
 *
 * Comments are anchored to source offsets, and only the CodeMirror surface
 * could paint them — a comment on a Markdown file was invisible to everyone
 * reading it in the preview, including the person who wrote it. The mapping is
 * the same one peer carets and tracked changes already use: resolve the anchor
 * in the source, then ask where those offsets land in the parsed document.
 * A comment whose quote no longer resolves (edited away, or living inside
 * syntax the preview does not render as text) is simply not painted.
 */
function visualCommentDecorations(
  doc: Editor["state"]["doc"],
  text: string,
  comments: EditorComment[],
  activeId: string | null,
): DecorationSet {
  return DecorationSet.create(doc, comments.flatMap((comment) => {
    if (comment.resolved) return [];
    const anchor = resolveCommentAnchor(text, comment);
    if (!anchor) return [];
    const from = proseMirrorPositionForSourceOffset(doc, text, anchor.from);
    if (from === null) return [];
    const to = proseMirrorPositionForSourceOffset(doc, text, anchor.to);
    if (to === null || to <= from) return [];
    // Same per-author colour the source editor marks it with, so the two
    // surfaces read as one feature rather than two.
    const colors = peerColorForKey(comment.authorId || comment.authorName);
    return [Decoration.inline(from, to, {
      class: `visual-editor-comment${comment.id === activeId ? " visual-editor-comment-active" : ""}`,
      "data-visual-comment-id": comment.id,
      role: "button",
      tabindex: "0",
      "aria-label": `Comment by ${comment.authorName || "Anonymous"}`,
      style: `--visual-comment-tint: ${colors.colorLight}; --visual-comment-color: ${colors.color}`,
    })];
  }));
}

const VisualEditorComments = Extension.create({
  name: "visualEditorComments",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: visualCommentsKey,
      state: {
        init: (): VisualCommentsMeta & { decorations: DecorationSet } => ({
          text: "",
          comments: [],
          activeId: null,
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualCommentsKey) as VisualCommentsMeta | undefined;
          return meta
            ? { ...meta, decorations: visualCommentDecorations(newState.doc, meta.text, meta.comments, meta.activeId) }
            : {
                ...current,
                decorations: transaction.docChanged
                  ? current.decorations.map(transaction.mapping, newState.doc)
                  : current.decorations,
              };
        },
      },
      props: {
        decorations: (state) => visualCommentsKey.getState(state)?.decorations ?? null,
      },
    })];
  },
});

const VisualOverleafTrackChanges = Extension.create({
  name: "visualOverleafTrackChanges",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: visualTrackChangesKey,
      state: {
        init: (): VisualTrackChangesMeta & { decorations: DecorationSet } => ({
          text: "",
          changes: [],
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualTrackChangesKey) as VisualTrackChangesMeta | undefined;
          return meta
            ? { ...meta, decorations: visualTrackChangeDecorations(newState.doc, meta.text, meta.changes) }
            : {
                ...current,
                decorations: transaction.docChanged
                  ? current.decorations.map(transaction.mapping, newState.doc)
                  : current.decorations,
              };
        },
      },
      props: {
        decorations: (state) => visualTrackChangesKey.getState(state)?.decorations ?? null,
      },
    })];
  },
});

function openVisualLinkInsert(editor: Editor) {
  window.dispatchEvent(new CustomEvent(VISUAL_LINK_INSERT_EVENT, { detail: { editor } }));
}

/**
 * True once the editor's ProseMirror view is mounted. TipTap v3's
 * `editor.view` is a proxy that throws pre-mount, and the vendored
 * BubbleMenuBar reads `editor.view.dom` during render — upstream only
 * renders it after mount, so the host must gate the same way. Reads the
 * non-throwing `editorView` field (upstream's get-editor-view.ts recipe)
 * and tracks TipTap's `mount`/`unmount` events.
 */
function useEditorViewMounted(editor: Editor | null): boolean {
  // State is only a re-render trigger; the returned value is read live each
  // render. A state-held boolean would go stale for one frame when useEditor
  // swaps in a fresh (not yet mounted) editor instance, rendering the chrome
  // against a view-less editor.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => bump((n) => n + 1);
    update();
    editor.on("mount", update);
    editor.on("unmount", update);
    return () => {
      editor.off("mount", update);
      editor.off("unmount", update);
    };
  }, [editor]);
  return Boolean((editor as unknown as { editorView?: unknown } | null)?.editorView);
}

function projectAssetMarkdownHref(activePath: string, projectPath: string): string {
  const from = activePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  const to = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || ".";
}

/** Upstream slash-menu composition minus app-only skill references. */
function slashItemSources(
  importAsset?: (file: File) => Promise<string | null>,
  getActivePath: () => string = () => "",
) {
  const cached = (factory: () => SlashCommandItem[]) => {
    let items: SlashCommandItem[] | null = null;
    return () => (items ??= factory());
  };
  return [
  cached(getSlashCommandItems),
  cached(() => getComponentItems().filter((item) => ![
    "component-video", "component-audio", "component-Pdf", "component-Embed", "component-File",
  ].includes(item.name)).map((item) => item.label !== "Image" || !importAsset ? item : ({
    ...item,
    command: ({ editor, state }: SlashCommandContext) => {
      // `state` is the chainable post-trigger-delete state. Reading
      // editor.state here would capture the old `/image` cursor position,
      // which is out of range by the time the async project import finishes.
      const position = state.selection.from;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.setAttribute("aria-label", "Choose image to upload");
      input.hidden = true;
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) void importAsset(file).then((path) => {
          if (path) editor.commands.insertContentAt(position, {
            type: "jsxComponent",
            attrs: {
              componentName: "img",
              kind: "element",
              props: { src: projectAssetMarkdownHref(getActivePath(), path) },
              sourceDirty: true,
            },
          });
        });
        input.remove();
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    },
  }))),
  cached(() => getEmbedStarterItems().filter((item) => item.name === "embed-starter-html").map((item) => ({
    ...item,
    category: "media",
  }))),
  cached(() => getInlineComponentItems().map((item) => item.name !== "link" ? item : ({
    ...item,
    command: ({ chain, state, editor, afterCommit }: SlashCommandContext) => {
      const from = state.selection.from;
      chain().insertContent({
        type: "text",
        text: "link",
        marks: [{ type: "link", attrs: { href: "" } }],
      }).setTextSelection({ from, to: from + 4 }).run();
      afterCommit(() => openVisualLinkInsert(editor));
    },
  }))),
  ];
}

const SLASH_CATEGORY_LABELS = {
  content: "Components",
  layout: "Layout",
  media: "Media",
  data: "Data",
  embed: "Embeds",
};

type VisualMarkdownEditorProps = {
  text: string;
  activePath: string;
  onChangeMarkdown: (next: string, expected: string) => boolean;
  optimizeForReading?: boolean;
  synchronizeSourceScroll?: boolean;
  onRequestViewportLock?: (
    anchor: HTMLElement | null,
    anchorTop: number | null,
    reveal: HTMLElement | null,
  ) => void;
  onOpenProjectPath?: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  /** Downloaded paper library backing the `@` citation typeahead. */
  papers?: PaperSummary[];
  macros?: Record<string, string>;
  onUndo: () => boolean;
  onRedo: () => boolean;
  onEditSource?: () => void;
  onViewInSource?: (sourceOffset: number, viewportY?: number) => void;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset?: (path: string) => Promise<string | null>;
  presenceCursors?: PresenceCursor[];
  onCaretChange?: (row: number, column: number) => void;
  onSourceCaretChange?: (sourceOffset: number) => void;
  overleafChanges?: TrackedChange[];
  /** Comments anchored in this file, painted as highlights over the prose. */
  editorComments?: EditorComment[];
  activeEditorCommentId?: string | null;
  onEditorCommentClick?: (id: string) => void;
  overleafTrackChangeActions?: TrackedChangeTooltipActions;
  onCreateComment?: (from: number, to: number, body: string) => void;
  editable?: boolean;
};

function resolveProjectLink(activePath: string, href: string): string | null {
  const rawPath = href.split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/")
    ? []
    : activePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

function ProjectInlineImageView({ node }: NodeViewProps) {
  const src = useProjectImageSrc(typeof node.attrs.src === "string" ? node.attrs.src : undefined);
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
  return (
    <NodeViewWrapper as="span" data-image-inline-zoom data-clipboard-inline-leaf="image">
      <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
        <img src={src} alt={alt} title={title} decoding="async" />
      </Zoom>
    </NodeViewWrapper>
  );
}

/**
 * Re-emit the source bytes of every block the reader did not touch.
 *
 * The serializer is entitled to normalize anything it round-trips: a blank line
 * between two blocks the converter wrote tight, `\*` around a stray asterisk,
 * emphasis delimiters inside a bold caption. For a block nobody edited that
 * normalization is pure damage — it rewrites the file on open — and because the
 * eligibility probe below compares serializer output against the source, a
 * single normalized separator disabled visual editing for the whole document.
 * Every imported paper failed that way: `## Contents` sits directly on its list,
 * and arxiv2md captions sit directly on their tables.
 *
 * Splicing the original bytes back keeps an untouched document identical, so
 * only blocks that actually changed pay the serializer's canonical form.
 */
function restoreUnchangedBlocks(
  serialized: string,
  expected: string,
  currentDoc: Editor["state"]["doc"],
  changedBlocks?: ReadonlySet<number>,
): string {
  const textSemantics = (node: Editor["state"]["doc"]) => {
    const semantics: unknown[] = [];
    node.descendants((child) => {
      if (child.isText) {
        semantics.push([
          child.text,
          child.marks
            .filter((mark) => mark.type.name !== "sourceLiteral")
            .map((mark) => [mark.type.name, mark.attrs]),
        ]);
        return;
      }
      // A hard break is the one representation difference this comparison
      // exists to forgive — the same prose carries it as a newline in the
      // source and as a node in the document. Every other leaf is content: a
      // tag chip, an inline-math atom or an image can be deleted without
      // touching a character of text, and that has to read as a change or the
      // deletion is restored away.
      if (child.type.name === "hardBreak") return;
      if (child.isLeaf || child.isAtom) semantics.push([child.type.name, child.attrs]);
    });
    return JSON.stringify(semantics);
  };
  let expectedDoc: Editor["state"]["doc"];
  try {
    expectedDoc = currentDoc.type.schema.nodeFromJSON(parseVisualMarkdown(expected));
  } catch {
    return serialized;
  }
  if (currentDoc.childCount !== expectedDoc.childCount) return serialized;
  // A leading BOM is envelope, not content: the parser reports offsets into the
  // body without it and preserveMarkdownEnvelope re-attaches it around whatever
  // we return, so every offset below — and the result — works on the body.
  const body = expected.startsWith("\uFEFF") ? expected.slice(1) : expected;
  const isUnchanged = (index: number) => {
    const current = currentDoc.child(index);
    const original = expectedDoc.child(index);
    return (changedBlocks ? !changedBlocks.has(index) : false)
      || current.eq(original)
      || (current.isTextblock && current.type === original.type && (
        current.content.eq(original.content)
        || textSemantics(current) === textSemantics(original)
      ));
  };

  const exactExpected = exactVisualSourceRanges(body, expectedDoc.childCount);
  const exactSerialized = exactVisualSourceRanges(serialized, currentDoc.childCount);
  if (exactExpected && exactSerialized) {
    const unchanged = Array.from({ length: currentDoc.childCount }, (_, index) => isUnchanged(index));
    if (unchanged.every(Boolean)) return body;
    const blockText = (index: number) => (unchanged[index]
      ? body.slice(exactExpected[index]!.from, exactExpected[index]!.to)
      : serialized.slice(exactSerialized[index]!.from, exactSerialized[index]!.to));
    // The gap between two blocks comes from the source only when both sides
    // still hold their source bytes. Next to an edited block the serializer
    // decides it, so a boundary the source wrote tight can never splice a
    // rewritten block onto its neighbour and merge the two.
    const gapText = (index: number) => (unchanged[index] && unchanged[index - 1]
      ? body.slice(exactExpected[index - 1]!.to, exactExpected[index]!.from)
      : serialized.slice(exactSerialized[index - 1]!.to, exactSerialized[index]!.from));
    const last = unchanged.length - 1;
    let result = unchanged[0]
      ? body.slice(0, exactExpected[0]!.from)
      : serialized.slice(0, exactSerialized[0]!.from);
    for (let index = 0; index <= last; index += 1) {
      if (index > 0) result += gapText(index);
      result += blockText(index);
    }
    return result + (unchanged[last]
      ? body.slice(exactExpected[last]!.to)
      : serialized.slice(exactSerialized[last]!.to));
  }

  // Uncertain block mapping: keep the narrower rewrite, which only ever
  // substitutes a block whose source spans several lines.
  const expectedRanges = visualSourceRanges(body, expectedDoc.childCount);
  const serializedRanges = visualSourceRanges(serialized, currentDoc.childCount);
  const replacements = expectedRanges.flatMap((expectedRange, index) => {
    const source = body.slice(expectedRange.from, expectedRange.to);
    const target = serializedRanges[index];
    if (!target || !/\r?\n/.test(source)) return [];
    if (!isUnchanged(index)) return [];
    return [{ ...target, source }];
  });
  return replacements.sort((a, b) => b.from - a.from).reduce(
    (result, replacement) => (
      result.slice(0, replacement.from) + replacement.source + result.slice(replacement.to)
    ),
    serialized,
  );
}

function serializeMarkdown(
  editor: Editor,
  expected: string,
  changedBlocks?: ReadonlySet<number>,
): string {
  return restoreUnchangedBlocks(
    getMarkdownManager().serialize(editor.getJSON()),
    expected,
    editor.state.doc,
    changedBlocks,
  );
}

function changedTopLevelBlocks(transaction: Transaction): Set<number> {
  const changed = new Set<number>();
  const addRange = (from: number, to: number) => {
    const max = transaction.doc.content.size;
    const start = Math.min(Math.max(from, 0), max);
    const end = Math.min(Math.max(to, start), max);
    changed.add(transaction.doc.resolve(start).index(0));
    changed.add(transaction.doc.resolve(Math.max(start, end - 1)).index(0));
  };
  for (const step of transaction.steps) {
    let mapped = false;
    step.getMap().forEach((_oldFrom, _oldTo, from, to) => {
      mapped = true;
      addRange(from, to);
    });
    if (mapped) continue;
    // A mark step — bold, a link, an inline-math atom — rewrites content
    // without moving anything, so its step map is empty and reports no changed
    // block at all. Only the step itself carries the range, and since nothing
    // moved its positions are already the ones in `transaction.doc`.
    const range = step as unknown as { from?: unknown; to?: unknown };
    if (typeof range.from === "number" && typeof range.to === "number") {
      addRange(range.from, range.to);
    }
  }
  return changed;
}

function isMultilineTextNormalization(transaction: Transaction): boolean {
  if (!transaction.docChanged || transaction.before.childCount !== transaction.doc.childCount) return false;
  const changed = changedTopLevelBlocks(transaction);
  if (!changed.size) return false;
  const visibleText = (node: Editor["state"]["doc"]): string => {
    if (node.isText) return node.text ?? "";
    if (node.type.name === "hardBreak") return "\n";
    let text = "";
    node.forEach((child) => { text += visibleText(child); });
    return text;
  };
  return [...changed].every((index) => {
    const before = transaction.before.maybeChild(index);
    const after = transaction.doc.maybeChild(index);
    if (!before || !after || visibleText(before) !== visibleText(after)) return false;
    let multilineText = false;
    let beforeBreaks = 0;
    let afterBreaks = 0;
    before.descendants((node) => {
      if (node.isText && /\r?\n/.test(node.text ?? "")) multilineText = true;
      if (node.type.name === "hardBreak") beforeBreaks += 1;
    });
    after.descendants((node) => {
      if (node.type.name === "hardBreak") afterBreaks += 1;
    });
    return multilineText && afterBreaks > beforeBreaks;
  });
}

function canonicalizeVisualEligibility(markdown: string): string {
  // One trailing space is ordinary prose whitespace and CommonMark drops it;
  // two or more spaces remain significant hard-break syntax.
  return canonicalizeSupportedMarkdown(markdown.replace(/(?<! )[ \t](?=\r?$)/gm, ""));
}

function VisualLinkInsertPopover({
  editor,
  onOpenChange,
}: {
  editor: Editor;
  onOpenChange: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [url, setUrl] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const requestedEditor = (event as CustomEvent<{ editor?: Editor }>).detail?.editor;
      if (requestedEditor !== editor) return;
      const coordinates = editor.view.coordsAtPos(editor.state.selection.from);
      const currentUrl = String(editor.getAttributes("link").href ?? "");
      setUrl(currentUrl);
      setAnchor({
        left: Math.max(16, Math.min(coordinates.left, window.innerWidth - 376)),
        bottom: coordinates.bottom,
      });
      onOpenChange(true);
      if (!currentUrl) {
        void readText()
          .then((text) => {
            const href = detectClipboardPrefillUrl(text);
            if (href) setUrl((value) => value || href);
          })
          .catch(() => undefined);
      }
    };
    window.addEventListener(VISUAL_LINK_INSERT_EVENT, handleOpen);
    return () => window.removeEventListener(VISUAL_LINK_INSERT_EVENT, handleOpen);
  }, [editor, onOpenChange]);

  const anchorOpen = anchor !== null;
  useEffect(() => {
    if (!anchorOpen) return;
    let frame: number | null = null;
    const reposition = () => {
      const coordinates = editor.view.coordsAtPos(editor.state.selection.from);
      setAnchor((current) => {
        if (!current) return current;
        const next = {
          left: Math.max(16, Math.min(coordinates.left, window.innerWidth - 376)),
          bottom: coordinates.bottom,
        };
        return current.left === next.left && current.bottom === next.bottom ? current : next;
      });
    };
    const scheduleReposition = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        reposition();
      });
    };
    document.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
    window.addEventListener("resize", scheduleReposition);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scheduleReposition, { capture: true });
      window.removeEventListener("resize", scheduleReposition);
    };
  }, [anchorOpen, editor]);

  const close = useCallback(() => {
    setAnchor(null);
    onOpenChange(false);
  }, [onOpenChange]);
  const apply = useCallback((restoreEditorFocus = true) => {
    const chain = editor.chain();
    if (restoreEditorFocus) chain.focus();
    if (url.trim()) chain.setLink({ href: url.trim() }).run();
    else chain.unsetLink().run();
    close();
  }, [close, editor, url]);
  const remove = useCallback(() => {
    editor.chain().focus().unsetLink().run();
    close();
  }, [close, editor]);

  useEffect(() => {
    if (!anchor) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && formRef.current?.contains(target)) return;
      apply(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [anchor, apply]);

  if (!anchor) return null;
  return (
    <form
      ref={formRef}
      className="visual-link-insert-popover"
      style={{ left: anchor.left, top: anchor.bottom + 6 }}
      onSubmit={(event) => {
      event.preventDefault();
      apply();
      }}
    >
      <input
        autoFocus
        aria-label="Link URL"
        placeholder="Link URL"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            editor.commands.focus();
          }
        }}
      />
      {editor.isActive("link") ? (
        <button className="secondary" type="button" onClick={remove}>Remove</button>
      ) : null}
      <button type="submit">Done</button>
    </form>
  );
}

function setMarkdownWithoutHistory(editor: Editor, markdown: string, sourcePath: string) {
  editor.chain()
    .setContent(cachedVisualContent(sourcePath, markdown), { emitUpdate: false })
    .command(({ tr }) => {
      tr.setMeta("addToHistory", false);
      tr.setMeta("canonicalMarkdownReplace", true);
      return true;
    })
    .run();
}

function openMarkdownLink(
  activePath: string,
  href: string,
  onOpenProjectPath?: (path: string) => void,
  editorElement?: HTMLElement,
) {
  if (href !== "#" && href.startsWith("#")) {
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = Array.from(editorElement?.querySelectorAll<HTMLElement>("[id]") ?? [])
      .find((element) => element.id === id);
    target?.scrollIntoView({ block: "start" });
    return;
  }
  const path = resolveProjectLink(activePath, href);
  if (path) onOpenProjectPath?.(path);
  else if (/^(?:https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => undefined);
}

const VisualEditorSurface = memo(function VisualEditorSurface({
  editor,
  activePath,
  onLoadAsset,
  workspaceIndex,
  viewInSource,
  editorViewMounted,
  openVisualCommentComposer,
  bubbleMenuHidden,
  editable,
  optimizeForReading,
  onLinkPopoverOpenChange,
}: {
  editor: Editor;
  activePath: string;
  onLoadAsset?: (path: string) => Promise<string | null>;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  viewInSource: (editor: Editor) => void;
  editorViewMounted: boolean;
  openVisualCommentComposer: (() => void) | null;
  bubbleMenuHidden: boolean;
  editable: boolean;
  optimizeForReading: boolean;
  onLinkPopoverOpenChange: (open: boolean) => void;
}) {
  return (
    <ProjectImageHostProvider activePath={activePath} loadAsset={onLoadAsset}>
      <MirrorHostProvider workspaceIndex={workspaceIndex}>
        <ViewInSourceProvider onViewInSource={viewInSource}>
          <TooltipProvider delayDuration={280} skipDelayDuration={400}>
            <div className="tiptap-editor">
              {editorViewMounted && (
                <VisualCommentProvider onComment={openVisualCommentComposer}>
                  <BubbleMenuBar
                    editor={editor}
                    hidden={bubbleMenuHidden}
                    commentOnly={!editable}
                  />
                </VisualCommentProvider>
              )}
              {editorViewMounted && !optimizeForReading && <TableCellHandles editor={editor} />}
              <EmojiInsertPopover />
              {editorViewMounted && (
                <VisualLinkInsertPopover editor={editor} onOpenChange={onLinkPopoverOpenChange} />
              )}
              <EditorContent className="tiptap-editor-portal-content" editor={editor} />
            </div>
          </TooltipProvider>
        </ViewInSourceProvider>
      </MirrorHostProvider>
    </ProjectImageHostProvider>
  );
});

export function VisualMarkdownEditor({
  text,
  activePath,
  onChangeMarkdown,
  optimizeForReading = false,
  synchronizeSourceScroll = true,
  onRequestViewportLock,
  onOpenProjectPath,
  workspaceIndex,
  papers,
  macros,
  onUndo,
  onRedo,
  onEditSource,
  onViewInSource,
  onImportAsset,
  onLoadAsset,
  presenceCursors = [],
  onCaretChange,
  onSourceCaretChange,
  overleafChanges = [],
  editorComments = EMPTY_EDITOR_COMMENTS,
  activeEditorCommentId = null,
  onEditorCommentClick,
  overleafTrackChangeActions,
  onCreateComment,
  editable = true,
}: VisualMarkdownEditorProps): JSX.Element {
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [eligibilityReason, setEligibilityReason] = useState<string | null>(null);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [hoveredChanges, setHoveredChanges] = useState<{
    changeIds: string[];
    left: number;
    top: number;
  } | null>(null);
  const [commentComposer, setCommentComposer] = useState<{
    path: string;
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
    body: string;
    error: string | null;
    left: number;
    top: number;
  } | null>(null);
  const hoveredChangesRef = useRef(hoveredChanges);
  const sectionRef = useRef<HTMLElement | null>(null);
  const editorReadyForChanges = useRef(false);
  const activePathRef = useRef(activePath);
  const acceptedMarkdown = useRef(text);
  const incomingMarkdown = useRef(text);
  const pendingCanonical = useRef<string | null>(null);
  const composing = useRef(false);
  const compositionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictDraftRef = useRef<string | null>(null);
  const eligibilityText = useRef<string | null>(null);
  const eligibilityRepresentedExactly = useRef<boolean | null>(null);
  const changeRef = useRef(onChangeMarkdown);
  const requestViewportLockRef = useRef(onRequestViewportLock);
  const openPathRef = useRef(onOpenProjectPath);
  const indexRef = useRef(workspaceIndex);
  const papersRef = useRef(papers);
  const indexedDocumentRef = useRef<{ index: MarkdownWorkspaceIndex; path: string } | null>(null);
  const undoRef = useRef(onUndo);
  const redoRef = useRef(onRedo);
  const caretChangeRef = useRef(onCaretChange);
  const sourceCaretChangeRef = useRef(onSourceCaretChange);
  const presenceCursorsRef = useRef(presenceCursors);
  const overleafChangesRef = useRef(overleafChanges);
  const commentsWereActive = useRef(false);
  const presenceWasActive = useRef(false);
  const trackChangesWereActive = useRef(false);
  const pendingLocalUpdate = useRef<{
    editor: Editor;
    explicitReplacement: boolean;
    changedBlocks: Set<number>;
    viewportAnchor: PreserveVisualViewportMeta | null;
  } | null>(null);
  const localUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localUpdateMaxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPolicyRef = useRef(markdownPreviewSyncPolicy(text.length));
  const trackedChangeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTrackedChanges = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".visual-tracked-change-tooltip")) return;
    const mark = target.closest<HTMLElement>("[data-visual-change-id]");
    if (!mark) return;
    if (trackedChangeCloseTimer.current) clearTimeout(trackedChangeCloseTimer.current);
    trackedChangeCloseTimer.current = null;
    const changes = overleafChanges.filter((change) => change.id === mark.dataset.visualChangeId);
    if (!changes.length) return;
    const rect = mark.getBoundingClientRect();
    const changeIds = changes.map((change) => change.id);
    setHoveredChanges((current) => (
      current?.changeIds[0] === changeIds[0]
        && current.left === rect.left
        && current.top === rect.top
        ? current
        : { changeIds, left: rect.left, top: rect.top }
    ));
  }, [overleafChanges]);
  const revealTrackedChangesRef = useRef(revealTrackedChanges);
  useEffect(() => {
    revealTrackedChangesRef.current = revealTrackedChanges;
  }, [revealTrackedChanges]);
  const sectionListenerCleanupRef = useRef<(() => void) | null>(null);
  const attachSectionRef = useCallback((section: HTMLElement | null) => {
    sectionListenerCleanupRef.current?.();
    sectionListenerCleanupRef.current = null;
    sectionRef.current = section;
    if (!section) return;
    const reveal = (event: Event) => revealTrackedChangesRef.current(event.target);
    const clear = () => setHoveredChanges(null);
    const focusAnchor = (ids = hoveredChangesRef.current?.changeIds ?? []) => {
      Array.from(section.querySelectorAll<HTMLElement>("[data-visual-change-id]"))
        .find((mark) => ids.includes(mark.dataset.visualChangeId ?? ""))
        ?.focus();
    };
    const activate = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const ids = hoveredChangesRef.current?.changeIds ?? [];
        clear();
        queueMicrotask(() => focusAnchor(ids));
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest("[data-visual-change-id]")) return;
      event.preventDefault();
      revealTrackedChangesRef.current(target);
      queueMicrotask(() => section.querySelector<HTMLButtonElement>(".visual-tracked-change-tooltip button:not(:disabled)")?.focus());
    };
    // ProseMirror handles pointer events at its root. Listen during capture so
    // tracked-change interactions still reach the surrounding React view.
    section.addEventListener("mouseover", reveal, true);
    section.addEventListener("focusin", reveal, true);
    section.addEventListener("keydown", activate, true);
    // Link marks install their own click handler before editorProps are
    // consulted. Capture at the host boundary so ordinary project links and
    // anchors consistently use the application router.
    sectionListenerCleanupRef.current = () => {
      section.removeEventListener("mouseover", reveal, true);
      section.removeEventListener("focusin", reveal, true);
      section.removeEventListener("keydown", activate, true);
    };
  }, []);
  useEffect(() => {
    caretChangeRef.current = onCaretChange;
    sourceCaretChangeRef.current = onSourceCaretChange;
  }, [onCaretChange, onSourceCaretChange]);
  useEffect(() => {
    presenceCursorsRef.current = presenceCursors;
  }, [presenceCursors]);
  useEffect(() => {
    overleafChangesRef.current = overleafChanges;
  }, [overleafChanges]);
  // Clicking a highlight opens that thread, the same gesture the source editor
  // offers. Registered on the container rather than as a ProseMirror handler so
  // it also works when the preview is read-only.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || !onEditorCommentClick) return;
    const open = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const mark = target.closest<HTMLElement>("[data-visual-comment-id]");
      const id = mark?.dataset.visualCommentId;
      if (id) onEditorCommentClick(id);
    };
    const activate = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest("[data-visual-comment-id]")) return;
      open(event);
    };
    section.addEventListener("click", open);
    section.addEventListener("keydown", activate);
    return () => {
      section.removeEventListener("click", open);
      section.removeEventListener("keydown", activate);
    };
  }, [onEditorCommentClick]);
  useEffect(() => {
    hoveredChangesRef.current = hoveredChanges;
  }, [hoveredChanges]);
  useEffect(() => {
    if (!hoveredChanges) return;
    const keepOpenNearSuggestion = (event: PointerEvent) => {
      const section = sectionRef.current;
      if (!section) return;
      const regions = [
        ...Array.from(section.querySelectorAll<HTMLElement>("[data-visual-change-id]"))
          .filter((mark) => hoveredChanges.changeIds.includes(mark.dataset.visualChangeId ?? "")),
        ...Array.from(section.querySelectorAll<HTMLElement>(".visual-tracked-change-tooltip")),
      ];
      const focused = document.activeElement instanceof HTMLElement
        && regions.some((region) => region.contains(document.activeElement));
      const nearby = focused || regions.some((region) => (
        distanceFromPointToRect(event.clientX, event.clientY, region.getBoundingClientRect())
          <= TRACKED_CHANGE_HOVER_RADIUS
      ));
      if (nearby) {
        if (trackedChangeCloseTimer.current) clearTimeout(trackedChangeCloseTimer.current);
        trackedChangeCloseTimer.current = null;
        return;
      }
      if (trackedChangeCloseTimer.current) return;
      trackedChangeCloseTimer.current = setTimeout(() => {
        trackedChangeCloseTimer.current = null;
        setHoveredChanges(null);
      }, TRACKED_CHANGE_CLOSE_DELAY_MS);
    };
    const closeWhenFocusLeaves = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const section = sectionRef.current;
      const ids = hoveredChanges.changeIds;
      const insideActiveRegion = section && [
        ...Array.from(section.querySelectorAll<HTMLElement>("[data-visual-change-id]"))
          .filter((mark) => ids.includes(mark.dataset.visualChangeId ?? "")),
        ...Array.from(section.querySelectorAll<HTMLElement>(".visual-tracked-change-tooltip")),
      ].some((region) => region.contains(target));
      if (!insideActiveRegion) setHoveredChanges(null);
    };
    window.addEventListener("pointermove", keepOpenNearSuggestion, true);
    window.addEventListener("focusin", closeWhenFocusLeaves, true);
    return () => {
      window.removeEventListener("pointermove", keepOpenNearSuggestion, true);
      window.removeEventListener("focusin", closeWhenFocusLeaves, true);
      if (trackedChangeCloseTimer.current) clearTimeout(trackedChangeCloseTimer.current);
      trackedChangeCloseTimer.current = null;
    };
  }, [hoveredChanges]);
  const reportVisualCaret = useCallback((currentEditor: Editor, expectedMarkdown: string) => {
    const callback = caretChangeRef.current;
    if (!callback) return;
    const mapped = sourceOffsetForProseMirrorPosition(
      currentEditor,
      currentEditor.state.selection.head,
      expectedMarkdown,
    );
    if (!mapped) return;
    if (mapped.markdown !== expectedMarkdown) return;
    const caret = rowColumnForSourceOffset(
      expectedMarkdown,
      Math.min(mapped.offset, expectedMarkdown.length),
    );
    callback(caret.row, caret.column);
    sourceCaretChangeRef.current?.(mapped.offset);
  }, []);
  const refreshVisualPresence = useCallback((currentEditor: Editor, markdown: string) => {
    if (currentEditor.isDestroyed || !presenceWasActive.current) return;
    currentEditor.view.dispatch(currentEditor.state.tr.setMeta(visualPresenceKey, {
      text: markdown,
      cursors: presenceCursorsRef.current,
    } satisfies VisualPresenceMeta));
  }, []);
  const refreshVisualTrackChanges = useCallback((
    currentEditor: Editor,
    markdown: string,
    changes = overleafChangesRef.current,
  ) => {
    if (currentEditor.isDestroyed || (!changes.length && !trackChangesWereActive.current)) return;
    currentEditor.view.dispatch(currentEditor.state.tr.setMeta(visualTrackChangesKey, {
      text: markdown,
      changes,
    } satisfies VisualTrackChangesMeta));
  }, []);
  const flushPendingLocalUpdate = useCallback(() => {
    if (localUpdateTimer.current) clearTimeout(localUpdateTimer.current);
    if (localUpdateMaxTimer.current) clearTimeout(localUpdateMaxTimer.current);
    localUpdateTimer.current = null;
    localUpdateMaxTimer.current = null;
    const pending = pendingLocalUpdate.current;
    pendingLocalUpdate.current = null;
    if (!pending || pending.editor.isDestroyed) return;
    const { editor: updatedEditor, explicitReplacement, changedBlocks, viewportAnchor } = pending;
    // Initialization and canonical-reconciliation transactions are not user
    // edits. In particular, never let opening a source-only paper normalize
    // and silently overwrite syntax that the visual editor cannot preserve.
    if (!explicitReplacement && (
      eligibilityText.current !== acceptedMarkdown.current
      || eligibilityRepresentedExactly.current !== true
    )) return;
    const expected = acceptedMarkdown.current;
    const next = preserveMarkdownEnvelope(
      serializeMarkdown(updatedEditor, expected, changedBlocks),
      expected,
    );
    if (next === expected) return;
    // A deferred split publication happens after the short lock requested by
    // the original + transaction. Re-lock immediately before the source echo
    // so its CodeMirror update cannot move the preview several frames later.
    // The first lock may already have scrolled down to reveal the inserted
    // row, so preserve the anchor's current screen position rather than
    // replaying its pre-insertion position and briefly jumping upward.
    if (viewportAnchor) {
      const anchor = updatedEditor.view.nodeDOM(viewportAnchor.anchorPosition);
      const reveal = updatedEditor.view.nodeDOM(viewportAnchor.insertedPosition);
      const currentAnchorTop = anchor instanceof HTMLElement && anchor.isConnected
        ? anchor.getBoundingClientRect().top
        : viewportAnchor.anchorTop;
      requestViewportLockRef.current?.(
        anchor instanceof HTMLElement ? anchor : null,
        currentAnchorTop,
        reveal instanceof HTMLElement ? reveal : null,
      );
    }
    if (changeRef.current(next, expected)) {
      acceptedMarkdown.current = next;
      reportVisualCaret(updatedEditor, next);
      refreshVisualPresence(updatedEditor, next);
      // A document emitted by this editor is already representable. Mark it
      // before the canonical prop comes back so the eligibility effect does
      // not serialize the entire document a second time for the same edit.
      eligibilityText.current = next;
      eligibilityRepresentedExactly.current = true;
      conflictDraftRef.current = null;
      setConflictDraft(null);
      return;
    }
    conflictDraftRef.current = next;
    setConflictDraft(next);
  }, [refreshVisualPresence, reportVisualCaret]);
  // `useEditor` only consumes `content` while creating the editor, but its
  // options object is evaluated on every React render. Parsing here lazily
  // avoids reparsing an entire Markdown document when editor chrome mounts or
  // local status changes; later source updates are reconciled below.
  const [initialContent] = useState(() => cachedVisualContent(activePath, text));
  const slashSources = useMemo(
    () => slashItemSources(onImportAsset, () => activePathRef.current),
    [onImportAsset],
  );
  const imageExtension = useMemo(() => ImageSrcFidelity.extend({
    addNodeView() {
      return ReactNodeViewRenderer(ProjectInlineImageView);
    },
  }).configure({ inline: true }), []);

  // Publish host KaTeX macros to the seam the vendored MathInlineView
  // renders through (see @ok-app/shims/katex-macros).
  useEffect(() => {
    setHostKatexMacros(macros ?? EMPTY_MACROS);
  }, [macros]);

  useEffect(() => {
    changeRef.current = onChangeMarkdown;
    requestViewportLockRef.current = onRequestViewportLock;
    openPathRef.current = onOpenProjectPath;
    indexRef.current = workspaceIndex;
    papersRef.current = papers;
    undoRef.current = onUndo;
    redoRef.current = onRedo;
  }, [onChangeMarkdown, onOpenProjectPath, onRedo, onRequestViewportLock, onUndo, papers, workspaceIndex]);

  useEffect(() => {
    syncPolicyRef.current = markdownPreviewSyncPolicy(text.length);
  }, [text.length]);

  useEffect(() => {
    if (!workspaceIndex) return;
    const indexed = indexedDocumentRef.current;
    if (indexed?.index !== workspaceIndex || indexed.path !== activePath) {
      indexedDocumentRef.current = { index: workspaceIndex, path: activePath };
      workspaceIndex.noteDocumentContent(activePath, text);
      return;
    }
    const updateIndex = () => {
      workspaceIndex.noteDocumentContent(activePath, text);
    };
    if ("requestIdleCallback" in window) {
      const idle = window.requestIdleCallback(updateIndex, { timeout: 1_000 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = globalThis.setTimeout(updateIndex, 400);
    return () => globalThis.clearTimeout(timer);
  }, [workspaceIndex, activePath, text]);

  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (!cancelled) slashSources.forEach((source) => source());
    };
    if ("requestIdleCallback" in window) {
      const idle = window.requestIdleCallback(warm, { timeout: 600 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idle);
      };
    }
    const timer = globalThis.setTimeout(warm, 80);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [slashSources]);

  const wikiLinkSuggestion = useMemo(
    () => visualWikiLinkSuggestion(() => indexRef.current ?? null),
    [],
  );

  const paperCitationSuggestion = useMemo(
    () => visualPaperCitationSuggestion({
      getPapers: () => papersRef.current ?? [],
      getActivePath: () => activePathRef.current,
    }),
    [],
  );

  const tagWithChrome = useMemo(
    () => visualTag(() => indexRef.current ?? null),
    [],
  );

  const canonicalHistoryShortcuts = useMemo(() => Extension.create({
    name: "canonicalMarkdownHistory",
    addKeyboardShortcuts() {
      return {
        "Mod-z": () => {
          flushPendingLocalUpdate();
          return undoRef.current();
        },
        "Mod-Shift-z": () => {
          flushPendingLocalUpdate();
          return redoRef.current();
        },
        "Mod-y": () => {
          flushPendingLocalUpdate();
          return redoRef.current();
        },
      };
    },
  }), [flushPendingLocalUpdate]);
  const linkOpeningShortcut = useMemo(() => Extension.create({
    name: "openMarkdownLink",
    addKeyboardShortcuts() {
      return {
        "Mod-Enter": ({ editor: currentEditor }) => {
          const href = currentEditor.getAttributes("link").href as string | undefined;
          if (!href) return false;
          openMarkdownLink(activePathRef.current, href, openPathRef.current, currentEditor.view.dom);
          return true;
        },
      };
    },
  }), []);
  const atomicBlockSelection = useMemo(() => Extension.create({
    name: "atomicBlockSelection",
    addProseMirrorPlugins() {
      return [new Plugin({
        props: {
          handleClickOn(view, _pos, node, nodePos, event) {
            if (node.type.name !== "thematicBreak") return false;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
            return true;
          },
        },
      })];
    },
    addKeyboardShortcuts() {
      const remove = ({ editor: currentEditor }: { editor: Editor }) => {
        if (!(currentEditor.state.selection instanceof NodeSelection)) return false;
        return currentEditor.commands.deleteSelection();
      };
      return { Delete: remove, Backspace: remove };
    },
  }), []);
  const calloutEnterGuard = useMemo(() => Extension.create({
    name: "calloutEnterGuard",
    priority: 110,
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor: currentEditor }) => {
          const { $from } = currentEditor.state.selection;
          if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== "") return false;
          for (let depth = $from.depth - 1; depth >= 1; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.name !== "jsxComponent") continue;
            if (node.attrs.componentName !== "Callout") return false;
            // Open Knowledge normally treats Enter in an empty trailing
            // container paragraph as "exit component". During macOS IME
            // commit, Chinese glyphs can already be visible while PM still
            // observes that paragraph as empty for this keydown. Split it in
            // place so the Callout cannot collapse into an empty selected atom.
            return currentEditor.commands.splitBlock();
          }
          return false;
        },
      };
    },
    addProseMirrorPlugins() {
      return [new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const emptyCallouts: number[] = [];
          newState.doc.descendants((node, position) => {
            if (
              node.type.name === "jsxComponent"
              && node.attrs.componentName === "Callout"
              && node.childCount === 0
            ) emptyCallouts.push(position);
          });
          const paragraph = newState.schema.nodes.paragraph;
          if (!paragraph || emptyCallouts.length === 0) return null;
          const transaction = newState.tr;
          for (let index = emptyCallouts.length - 1; index >= 0; index -= 1) {
            transaction.insert(emptyCallouts[index] + 1, paragraph.create());
          }
          return transaction;
        },
      })];
    },
  }), []);

  const editor = useEditor({
    // Upstream default (false): the vendored chrome (BubbleMenuBar,
    // TableCellHandles, …) subscribes to editor state itself via
    // useEditorState; re-rendering this host per transaction feeds a
    // render→dispatch cycle that React aborts as an infinite update loop.
    shouldRerenderOnTransaction: false,
    editable,
    extensions: [
      ...visualEditorExtensions(imageExtension).map((extension) =>
        // Swap core's bare `tag` atom for the app-side override (two-state
        // chip NodeView, `#` typeahead, one-keystroke atom removal).
        extension.name === "tag" ? tagWithChrome : extension,
      ),
      SourceDirtyObserver,
      VisualFixedCaret,
      VisualOverleafPresence,
      VisualOverleafTrackChanges,
      VisualEditorComments,
      // Vendored Open Knowledge chrome: block "+"/grip, keyboard block nav,
      // slash menu, table insert bars, frozen headers, footnote scrolling.
      // BridgeIdPlugin must precede SelectionStatePlugin (priority 1000 in
      // the extension itself); both power JsxComponentView's selection halo
      // and ancestor-chain chrome.
      BridgeIdPlugin,
      SelectionStatePlugin,
      VisualBlockControls,
      VisualBlockMover,
      calloutEnterGuard,
      KeyboardNav,
      SlashCommand.configure({
        itemsSources: slashSources,
        categoryLabels: SLASH_CATEGORY_LABELS,
      }),
      TiptapFindReplace,
      ...(optimizeForReading ? [] : [TableInsertControls, FrozenTableHeaders]),
      FootnoteAnchorScroll,
      FormattingShortcuts,
      TabFocusTrap,
      HeadingAnchors,
      MathInputRule,
      InlineLinkInputRule,
      wikiLinkSuggestion,
      paperCitationSuggestion,
      VisualLinkHover,
      TableRowEnter,
      canonicalHistoryShortcuts,
      linkOpeningShortcut,
      atomicBlockSelection,
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        "aria-label": "Markdown document editor",
        "aria-multiline": "true",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        // Return used to commit a macOS IME candidate is not an editing Enter.
        // Consuming it here keeps lower-priority container shortcuts from
        // observing the transient empty composition paragraph and turning the
        // Callout into a selected, zero-height component. A subsequent Return
        // after compositionend remains an ordinary paragraph split.
        return event.key === "Enter"
          && (event.isComposing || event.keyCode === 229 || composing.current);
      },
      handleClickOn: (view, _pos, node, nodePos, event) => {
        if (node.type.name !== "text") return false;
        const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
        if (!anchor || anchor.hasAttribute("data-tag")) return false;
        const href = anchor.getAttribute("href");
        if (!href) return false;
        event.preventDefault();
        openMarkdownLink(activePathRef.current, href, openPathRef.current, view.dom);
        void nodePos;
        return true;
      },
      handleDOMEvents: {
        compositionstart: () => {
          if (compositionClearTimer.current) clearTimeout(compositionClearTimer.current);
          compositionClearTimer.current = null;
          composing.current = true;
          return false;
        },
        compositionend: () => {
          // WebKit can dispatch compositionend immediately before the Enter
          // keydown that committed the candidate. Keep the guard alive through
          // the current event turn so that trailing Enter cannot reach the
          // container-exit shortcut and select/collapse the Callout.
          if (compositionClearTimer.current) clearTimeout(compositionClearTimer.current);
          compositionClearTimer.current = setTimeout(() => {
            composing.current = false;
            compositionClearTimer.current = null;
          }, 0);
          const pending = pendingCanonical.current;
          pendingCanonical.current = null;
          if (pending != null) queueMicrotask(() => reconcileCanonical(pending));
          return false;
        },
        blur: () => {
          flushPendingLocalUpdate();
          return false;
        },
        click: (view, event) => {
          const target = event.target as HTMLElement | null;
          const cell = target?.closest<HTMLTableCellElement>("td, th");
          if (
            event.button === 0
            && !event.shiftKey
            && !event.metaKey
            && !event.ctrlKey
            && !event.altKey
            && cell?.querySelector(".visual-overleaf-caret")
          ) {
            const cellFrom = view.posAtDOM(cell, 0);
            const cellTo = view.posAtDOM(cell, cell.childNodes.length);
            const current = view.state.selection;
            // Let WebKit's native mousedown/mousemove selection stand. Only a
            // collapsed click that still landed outside the occupied cell
            // needs the caret-position fallback.
            if (current.empty && (current.from < cellFrom || current.from > cellTo)) {
              const pointer = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const position = Math.min(Math.max(pointer?.pos ?? cellFrom, cellFrom), cellTo);
              let selection = TextSelection.near(view.state.doc.resolve(position), 1);
              if (selection.from < cellFrom || selection.from > cellTo) {
                selection = TextSelection.near(view.state.doc.resolve(cellFrom), 1);
              }
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(selection));
              view.focus();
              return true;
            }
          }
          if (target?.matches("hr")) {
            event.preventDefault();
            const position = view.posAtDOM(target, 0);
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
            return true;
          }
          if (event.metaKey || event.ctrlKey) {
            const wikiLink = target?.closest<HTMLElement>("[data-wiki-link]");
            if (wikiLink) {
              const target = wikiLink.dataset.target;
              const anchor = wikiLink.dataset.anchor;
              const doc = target ? indexRef.current?.getDoc(target) : undefined;
              if (doc) {
                void anchor;
                event.preventDefault();
                openPathRef.current?.(doc.path);
                return true;
              }
            }
          }
          const anchor = target?.closest("a");
          if (!anchor) return false;
          event.preventDefault();
          // Tag chips (`<a class="tag" data-tag>`) surface the upstream
          // `ok:tag-click` event instead of link navigation — the href
          // (`#tag/{value}`) is keyboard/right-click chrome only.
          const tagValue = anchor.getAttribute("data-tag");
          if (tagValue) {
            dispatchTagClick(tagValue);
            return true;
          }
          const href = anchor.getAttribute("href");
          if (href) openMarkdownLink(activePathRef.current, href, openPathRef.current, view.dom);
          return true;
        },
      },
    },
    onUpdate: ({ editor: currentEditor, transaction }) => {
      if (!editorReadyForChanges.current || transaction.getMeta("preventUpdate") === true) return;
      // ProseMirror's DOM observer turns parser-preserved multiline text into
      // equivalent hard-break nodes after mount. This is internal document
      // normalization, not an authored Markdown change.
      if (isMultilineTextNormalization(transaction)) return;
      const viewportAnchor = transaction.getMeta(PRESERVE_VISUAL_VIEWPORT_META) as
        PreserveVisualViewportMeta | undefined;
      if (viewportAnchor) {
        const anchor = currentEditor.view.nodeDOM(viewportAnchor.anchorPosition);
        const reveal = currentEditor.view.nodeDOM(viewportAnchor.insertedPosition);
        requestViewportLockRef.current?.(
          anchor instanceof HTMLElement ? anchor : null,
          viewportAnchor.anchorTop,
          reveal instanceof HTMLElement ? reveal : null,
        );
      }
      const changedBlocks = changedTopLevelBlocks(transaction);
      for (const index of pendingLocalUpdate.current?.changedBlocks ?? []) changedBlocks.add(index);
      pendingLocalUpdate.current = {
        editor: currentEditor,
        explicitReplacement: transaction.getMeta("preventUpdate") === false,
        changedBlocks,
        viewportAnchor: viewportAnchor ?? pendingLocalUpdate.current?.viewportAnchor ?? null,
      };
      // Every preview uses the same adaptive publication boundary. The editor
      // DOM remains immediate; source serialization waits for an idle pause,
      // with a bounded maximum delay during sustained typing.
      if (localUpdateTimer.current) clearTimeout(localUpdateTimer.current);
      const policy = syncPolicyRef.current;
      localUpdateTimer.current = setTimeout(flushPendingLocalUpdate, policy.publicationIdleMs);
      localUpdateMaxTimer.current ??= setTimeout(flushPendingLocalUpdate, policy.publicationMaxMs);
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      reportVisualCaret(currentEditor, acceptedMarkdown.current);
    },
    onFocus: ({ editor: currentEditor }) => {
      reportVisualCaret(currentEditor, acceptedMarkdown.current);
    },
  // Recreate only when reading-mode chrome changes. File switches reuse this
  // instance via the path-swap layout effect below — remounting TipTap is what
  // made .md navigation feel slow.
  }, [optimizeForReading]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const wired = new WeakSet<HTMLAnchorElement>();
    const wireLinks = () => {
      editor.view.dom.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        if (wired.has(anchor)) return;
        wired.add(anchor);
        anchor.addEventListener("click", (event) => {
          if (anchor.hasAttribute("data-tag")) return;
          const href = anchor.getAttribute("href");
          if (!href) return;
          event.preventDefault();
          event.stopPropagation();
          openMarkdownLink(activePathRef.current, href, openPathRef.current, editor.view.dom);
        });
      });
    };
    wireLinks();
    const observer = new MutationObserver(wireLinks);
    observer.observe(editor.view.dom, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editor]);
  const reconcileCanonical = useCallback((canonical: string) => {
    if (!editor || editor.isDestroyed || canonical === acceptedMarkdown.current) return;
    const base = acceptedMarkdown.current;
    const draft = conflictDraftRef.current
      ?? preserveMarkdownEnvelope(serializeMarkdown(editor, base), base);
    // A document the parser cannot round-trip serializes back into something
    // unlike its own source, and the surface is read-only for exactly that
    // reason — so the difference is the round trip's drift, not the reader's
    // work. Counting it as an unsaved draft reported a conflict to someone who
    // had not typed a character, most visibly the moment a share connected and
    // swapped the document underneath them. Only a document known to be lossy
    // is discounted: an undetermined one keeps its draft, so a writer demoted
    // to read-only mid-edit does not lose theirs.
    const hasLocalDraft = draft !== base
      && (conflictDraftRef.current != null || eligibilityRepresentedExactly.current !== false);
    if (hasLocalDraft) {
      const rebased = rebaseMarkdownDraft(base, draft, canonical);
      if (rebased != null && changeRef.current(rebased, canonical)) {
        acceptedMarkdown.current = rebased;
        conflictDraftRef.current = null;
        setConflictDraft(null);
        setMarkdownWithoutHistory(editor, rebased, activePathRef.current);
        refreshVisualPresence(editor, rebased);
        refreshVisualTrackChanges(editor, rebased, []);
        return;
      }
      setConflictDraft(draft);
    }
    acceptedMarkdown.current = canonical;
    setMarkdownWithoutHistory(editor, canonical, activePathRef.current);
    refreshVisualPresence(editor, canonical);
    refreshVisualTrackChanges(editor, canonical);
  }, [editor, refreshVisualPresence, refreshVisualTrackChanges]);

  /**
   * A failed publish is an error like any other, so it belongs in the app's
   * notifications rather than wedged into the document as a red bar the reader
   * has to scroll past. The toast keeps both ways out of it — the draft on the
   * clipboard, and restoring it — and stays until it is answered.
   */
  useEffect(() => {
    if (conflictDraft == null) return;
    const key = `visual-conflict:${activePath}`;
    notifyError("Preview", "This document changed in the same place", {
      detail: "The shared version is shown. Your visual draft was kept — copy it, or restore it and try again.",
      copyText: conflictDraft,
      timeoutMs: 0,
      dedupeKey: key,
      primaryAction: {
        label: "Restore draft and retry",
        onClick: () => {
          if (editor && !editor.isDestroyed) {
            setMarkdownWithoutHistory(editor, conflictDraft, activePathRef.current);
          }
          conflictDraftRef.current = null;
          setConflictDraft(null);
        },
      },
      ...(onEditSource ? { secondaryAction: { label: "Edit Markdown source", onClick: onEditSource } } : {}),
      onDismiss: () => {
        conflictDraftRef.current = null;
        setConflictDraft(null);
      },
    });
    return () => dismissAppToastByDedupeKey(key);
  }, [activePath, conflictDraft, editor, onEditSource]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editable, editor]);

  // Swap TipTap content across .md files without tearing down the editor.
  // Runs in layout so changeRef still points at the previous file's publisher
  // (that ref is refreshed in a later useEffect).
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activePathRef.current === activePath) return;

    flushPendingLocalUpdate();

    activePathRef.current = activePath;
    composing.current = false;
    if (compositionClearTimer.current) {
      clearTimeout(compositionClearTimer.current);
      compositionClearTimer.current = null;
    }
    pendingCanonical.current = null;
    conflictDraftRef.current = null;
    setConflictDraft(null);
    setHoveredChanges(null);
    setCommentComposer(null);
    setLinkPopoverOpen(false);
    eligibilityText.current = null;
    eligibilityRepresentedExactly.current = null;
    editorReadyForChanges.current = false;

    acceptedMarkdown.current = text;
    incomingMarkdown.current = text;
    setMarkdownWithoutHistory(editor, text, activePath);
    // Fresh history so Undo cannot walk back into the previous file.
    editor.view.updateState(EditorState.create({
      doc: editor.state.doc,
      plugins: editor.state.plugins,
    }));

    const scroller = sectionRef.current?.closest<HTMLElement>("[data-testid='editor-scroll-container']");
    if (scroller) scroller.scrollTop = 0;
  }, [activePath, editor, flushPendingLocalUpdate, text]);

  useEffect(() => {
    incomingMarkdown.current = text;
    if (!editor) return;
    // Path swaps are handled in the layout effect; skip the reconcile echo for
    // the same commit so we do not double-apply content.
    if (activePathRef.current !== activePath) return;
    if (text === acceptedMarkdown.current) return;
    if (composing.current) {
      pendingCanonical.current = text;
      return;
    }
    queueMicrotask(() => {
      if (editor.isDestroyed || incomingMarkdown.current !== text || text === acceptedMarkdown.current) return;
      if (activePathRef.current !== activePath) return;
      reconcileCanonical(text);
    });
  }, [activePath, editor, reconcileCanonical, text]);

  useLayoutEffect(() => () => {
    // Keyboard mode/tab switches can unmount the editor without a DOM blur.
    // Publish the pending ProseMirror state while the editor is still alive so
    // the paper debounce cannot discard the user's final input.
    flushPendingLocalUpdate();
    if (compositionClearTimer.current) clearTimeout(compositionClearTimer.current);
    if (localUpdateTimer.current) clearTimeout(localUpdateTimer.current);
    if (localUpdateMaxTimer.current) clearTimeout(localUpdateMaxTimer.current);
  }, [flushPendingLocalUpdate]);

  useEffect(() => {
    if (!editor) return;
    if (eligibilityText.current === text) return;
    // Eligibility is a property of the source parser's round trip, not of the
    // live Editor instance. The editor can still be applying initialization or
    // path-switch transactions while a tutorial advances, which made the same
    // lossless paper appear incompatible only during the guided flow.
    const parsed = cachedVisualDocument(activePath, text);
    const representedExactly = parsed.representedExactly ?? (() => {
      const serialized = preserveMarkdownEnvelope(
        // MarkdownManager serialization annotates its input, so keep the
        // cached parse tree pristine for this and later editor instances.
        restoreUnchangedBlocks(
          getMarkdownManager().serialize(structuredClone(parsed.content)),
          text,
          editor.state.schema.nodeFromJSON(structuredClone(parsed.content)),
        ),
        text,
      );
      const exact = canonicalizeVisualEligibility(serialized)
        === canonicalizeVisualEligibility(text);
      parsed.representedExactly = exact;
      return exact;
    })();
    eligibilityText.current = text;
    eligibilityRepresentedExactly.current = representedExactly;
    const reason = representedExactly
      ? null
      : "Visual editing is unavailable because this Markdown contains unsupported or lossy syntax. Use source mode to preserve it.";
    setEligibilityReason(reason);
    const canEdit = representedExactly && editable;
    if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
    editorReadyForChanges.current = true;
  }, [activePath, editable, editor, optimizeForReading, text]);

  const editorViewMounted = useEditorViewMounted(editor);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    reportVisualCaret(editor, acceptedMarkdown.current);
  }, [editor, editorViewMounted, reportVisualCaret]);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    if (text !== acceptedMarkdown.current) return;
    if (!presenceCursors.length && !presenceWasActive.current) return;
    presenceWasActive.current = presenceCursors.length > 0;
    editor.view.dispatch(editor.state.tr.setMeta(visualPresenceKey, {
      text,
      cursors: presenceCursors,
    } satisfies VisualPresenceMeta));
  }, [editor, editorViewMounted, presenceCursors, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    if (text !== acceptedMarkdown.current) return;
    if (!overleafChanges.length && !trackChangesWereActive.current) return;
    trackChangesWereActive.current = overleafChanges.length > 0;
    editor.view.dispatch(editor.state.tr.setMeta(visualTrackChangesKey, {
      text,
      changes: overleafChanges,
    } satisfies VisualTrackChangesMeta));
  }, [editor, editorViewMounted, overleafChanges, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    // Anchors are resolved against the source this document was parsed from;
    // repainting while they disagree would place highlights by stale offsets.
    if (text !== acceptedMarkdown.current) return;
    if (!editorComments.length && !commentsWereActive.current) return;
    commentsWereActive.current = editorComments.length > 0;
    editor.view.dispatch(editor.state.tr.setMeta(visualCommentsKey, {
      text,
      comments: editorComments,
      activeId: activeEditorCommentId,
    } satisfies VisualCommentsMeta));
  }, [activeEditorCommentId, editor, editorComments, editorViewMounted, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || !synchronizeSourceScroll) return;
    let active = true;
    let renderedBlocks: Element[] = [];
    let sourceRanges: VisualSourceRange[] | null = null;
    let sourceRangeBlockCount = -1;
    const labelSourceBlocks = () => {
      if (!active || editor.isDestroyed) return;
      const editorDom = sectionRef.current?.querySelector<HTMLElement>(".ProseMirror");
      if (!editorDom) return;
      renderedBlocks = Array.from(editorDom.children);
      if (!sourceRanges || sourceRangeBlockCount !== renderedBlocks.length) {
        sourceRanges = visualSourceRanges(text, renderedBlocks.length);
        sourceRangeBlockCount = renderedBlocks.length;
      }
      // Source labels are synchronization metadata, not editable document
      // attributes. Keep ProseMirror's DOM observer from reparsing the whole
      // document when these data attributes change; reparsing destroys every
      // React NodeView and visibly reloads images, Mermaid, and HTML previews.
      const domObserver = (editor.view as unknown as {
        domObserver?: { flush: () => void; start: () => void; stop: () => void };
      }).domObserver;
      domObserver?.flush();
      domObserver?.stop();
      try {
        let previousOffset = 0;
        let sourceLine = 1;
        for (const [index, element] of renderedBlocks.entries()) {
          if (!(element instanceof HTMLElement)) continue;
          const range = sourceRanges[index];
          if (!range) {
            delete element.dataset.sourceLine;
            delete element.dataset.sourceOffset;
            delete element.dataset.sourceEndOffset;
            continue;
          }
          sourceLine += text.slice(previousOffset, range.from).split(/\r\n|\r|\n/).length - 1;
          previousOffset = range.from;
          const nextSourceLine = String(sourceLine);
          const nextSourceOffset = String(range.from);
          const nextSourceEndOffset = String(range.to);
          if (element.dataset.sourceLine !== nextSourceLine) {
            element.dataset.sourceLine = nextSourceLine;
          }
          if (element.dataset.sourceOffset !== nextSourceOffset) {
            element.dataset.sourceOffset = nextSourceOffset;
          }
          if (element.dataset.sourceEndOffset !== nextSourceEndOffset) {
            element.dataset.sourceEndOffset = nextSourceEndOffset;
          }
        }
      } finally {
        domObserver?.start();
      }
    };
    labelSourceBlocks();
    // A canonical source update is reconciled in a microtask above. Label the
    // blocks again after that transaction so inserted or removed blocks receive
    // the source positions for their new DOM nodes, rather than the old tree.
    queueMicrotask(labelSourceBlocks);
    return () => {
      active = false;
    };
  }, [editor, editorViewMounted, synchronizeSourceScroll, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || !synchronizeSourceScroll) return;
    const editorDom = sectionRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (!editorDom) return;
    return () => {
      for (const element of Array.from(editorDom.children)) {
        if (!(element instanceof HTMLElement)) continue;
        delete element.dataset.sourceLine;
        delete element.dataset.sourceOffset;
        delete element.dataset.sourceEndOffset;
      }
    };
  }, [editor, editorViewMounted, synchronizeSourceScroll]);

  const viewInSource = useCallback((selectedEditor: Editor) => {
    if (!onViewInSource) return;
    const selection = selectedEditor.state.selection;
    const blockIndex = selection.$from.index(0);
    const renderedBlock = selectedEditor.view.dom.children[blockIndex];
    let viewportY: number | undefined;
    try {
      const selectionCoords = selectedEditor.view.coordsAtPos(selection.from);
      const selectionCenter = (selectionCoords.top + selectionCoords.bottom) / 2;
      if (Number.isFinite(selectionCenter)) viewportY = selectionCenter;
    } catch {
      // The DOM selection can briefly be unavailable while a NodeView updates.
      // Source navigation still works; it falls back to centering the target.
    }
    const sourceOffset = renderedBlock instanceof HTMLElement
      ? Number(renderedBlock.dataset.sourceOffset)
      : Number.NaN;
    if (Number.isFinite(sourceOffset)) {
      onViewInSource(sourceOffset, viewportY);
      return;
    }
    onViewInSource(
      visualSourceRanges(acceptedMarkdown.current, selectedEditor.state.doc.childCount)[blockIndex]?.from ?? 0,
      viewportY,
    );
  }, [onViewInSource]);

  const openVisualCommentComposer = useCallback(() => {
    if (!editor || !onCreateComment) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const mappedFrom = sourceOffsetForProseMirrorPosition(editor, from, acceptedMarkdown.current);
    const mappedTo = sourceOffsetForProseMirrorPosition(editor, to, acceptedMarkdown.current);
    if (
      !mappedFrom
      || !mappedTo
      || mappedFrom.markdown !== acceptedMarkdown.current
      || mappedTo.markdown !== acceptedMarkdown.current
      || mappedTo.offset <= mappedFrom.offset
    ) return;
    const quote = acceptedMarkdown.current.slice(mappedFrom.offset, mappedTo.offset);
    if (!quote.trim()) return;
    const rect = posToDOMRect(editor.view, from, to);
    setCommentComposer({
      path: activePath,
      from: mappedFrom.offset,
      to: mappedTo.offset,
      quote,
      prefix: acceptedMarkdown.current.slice(Math.max(0, mappedFrom.offset - 32), mappedFrom.offset),
      suffix: acceptedMarkdown.current.slice(mappedTo.offset, Math.min(acceptedMarkdown.current.length, mappedTo.offset + 32)),
      body: "",
      error: null,
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 328)),
      top: Math.min(window.innerHeight - 220, rect.bottom + 8),
    });
  }, [activePath, editor, onCreateComment]);

  if (!editor) return <div aria-label="Loading Markdown editor" />;

  const activeHoveredChanges = hoveredChanges
    ? hoveredChanges.changeIds.flatMap((id) => {
        const change = overleafChanges.find((candidate) => candidate.id === id);
        return change ? [change] : [];
      })
    : [];
  const restoreTrackedChangeFocus = () => {
    const ids = hoveredChanges?.changeIds ?? [];
    Array.from(sectionRef.current?.querySelectorAll<HTMLElement>("[data-visual-change-id]") ?? [])
      .find((mark) => ids.includes(mark.dataset.visualChangeId ?? ""))
      ?.focus();
  };
  const submitVisualComment = () => {
    if (!commentComposer || !commentComposer.body.trim() || !onCreateComment) return;
    if (commentComposer.path !== activePath) {
      setCommentComposer(null);
      return;
    }
    const range = resolveCommentAnchor(acceptedMarkdown.current, commentComposer);
    if (!range) {
      setCommentComposer((current) => current ? {
        ...current,
        error: "The selected text changed. Select it again before commenting.",
      } : current);
      return;
    }
    onCreateComment(range.from, range.to, commentComposer.body.trim());
    setCommentComposer(null);
    editor.commands.focus();
  };

  return (
    <section
      ref={attachSectionRef}
      className={`visual-markdown-editor${optimizeForReading ? " optimize-for-reading" : ""}`}
      data-active-path={activePath}
      aria-label="Visual Markdown editor"
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (!anchor || anchor.hasAttribute("data-tag")) return;
        const href = anchor.getAttribute("href");
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        openMarkdownLink(activePath, href, openPathRef.current, sectionRef.current ?? undefined);
      }}
    >
      {commentComposer && (
        <div
          className="visual-comment-composer"
          role="dialog"
          aria-label="Add comment"
          style={{ left: commentComposer.left, top: commentComposer.top }}
        >
          <p className="editor-comment-quote">{commentComposer.quote}</p>
          <textarea
            autoFocus
            rows={3}
            aria-label="Comment"
            placeholder="Leave a comment for collaborators…"
            value={commentComposer.body}
            onChange={(event) => setCommentComposer((current) => (
              current ? { ...current, body: event.target.value } : current
            ))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setCommentComposer(null);
                editor.commands.focus();
              } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submitVisualComment();
              }
            }}
          />
          {commentComposer.error && <p role="alert" className="visual-node-source-error">{commentComposer.error}</p>}
          <div className="editor-comment-popover-actions">
            <button type="button" onClick={() => {
              setCommentComposer(null);
              editor.commands.focus();
            }}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={!commentComposer.body.trim()}
              onClick={submitVisualComment}
            >Add comment</button>
          </div>
        </div>
      )}
      {hoveredChanges && activeHoveredChanges.length > 0 && overleafTrackChangeActions && (
        <div
          id="visual-tracked-change-tooltip"
          className="visual-tracked-change-tooltip"
          role="dialog"
          aria-label="Suggested change"
          style={{ left: hoveredChanges.left, top: hoveredChanges.top }}
          onMouseOver={(event) => event.stopPropagation()}
        >
          {activeHoveredChanges.map((change) => {
            const canAct = overleafTrackChangeActions.canAct();
            return (
              <div className="visual-tracked-change-tooltip-item" key={change.id}>
                <div className="visual-tracked-change-tooltip-head">
                  <span style={{ backgroundColor: `hsl(${change.hue}, 70%, 50%)` }} />
                  <div>
                    <strong>{overleafTrackChangeActions.authorName(change.userId)}</strong>
                    <small>{change.deletion ? "Suggested deletion" : "Suggested insertion"}</small>
                  </div>
                </div>
                <div
                  className={`visual-tracked-change-quote${change.deletion ? " is-deletion" : ""}`}
                  style={{
                    backgroundColor: `hsl(${change.hue} 70% 50% / ${change.deletion ? 0.1 : 0.14})`,
                    textDecorationColor: change.deletion ? `hsl(${change.hue}, 70%, 50%)` : undefined,
                  }}
                >
                  {change.text}
                </div>
                <div className="visual-tracked-change-tooltip-actions">
                  <button className="accept" type="button" disabled={!canAct} onClick={() => {
                    restoreTrackedChangeFocus();
                    setHoveredChanges(null);
                    overleafTrackChangeActions.onAccept(change);
                  }}><Check aria-hidden="true" />Accept</button>
                  <button className="reject" type="button" disabled={!canAct} onClick={() => {
                    restoreTrackedChangeFocus();
                    setHoveredChanges(null);
                    overleafTrackChangeActions.onReject(change);
                  }}><X aria-hidden="true" />Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {eligibilityReason && (
        <div className="visual-markdown-eligibility" role="status">
          {eligibilityReason}
          {onEditSource && <button type="button" onClick={onEditSource}>Edit Markdown source</button>}
        </div>
      )}
      {/* Upstream DOM shape (TiptapEditor.tsx): the .tiptap-editor grid
          directly contains the bubble menu, the table cell handle layer
          (pinned to grid row 1), and EditorContent as the content-column
          grid item. `.editor-doc-scroll` lives on the ScrollArea viewport
          ancestor (document-canvas.tsx) per upstream's scroll-container
          contract (bubble-menu-clip.ts resolves it via closest()). The
          legacy visual-markdown-content typography class is intentionally
          gone — vendored editor-globals.css owns all editor styling. */}
      {/* Keep the portal plane outside controlled Markdown echo renders.
          NodeView subscriptions update their own chrome; unchanged image,
          Mermaid, and HTML views must retain their mounted DOM and state. */}
      <VisualEditorSurface
        editor={editor}
        activePath={activePath}
        onLoadAsset={onLoadAsset}
        workspaceIndex={workspaceIndex}
        viewInSource={viewInSource}
        editorViewMounted={editorViewMounted}
        openVisualCommentComposer={onCreateComment ? openVisualCommentComposer : null}
        bubbleMenuHidden={linkPopoverOpen || Boolean(commentComposer)}
        editable={editable}
        optimizeForReading={optimizeForReading}
        onLinkPopoverOpenChange={setLinkPopoverOpen}
      />
    </section>
  );
}
