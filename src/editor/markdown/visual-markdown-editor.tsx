import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Extension, posToDOMRect, type NodeViewProps } from "@tiptap/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getMarkdownManager, parseVisualMarkdown, visualEditorExtensions } from "./visual-markdown-schema";
import { SourceDirtyObserver } from "./visual-source-dirty-observer";
import { visualWikiLinkSuggestion } from "./visual-wiki-link-suggestion";
import { visualPaperCitationSuggestion } from "./visual-paper-citation-suggestion";
import type { PaperSummary } from "../../app-types";
import type { TrackedChangeTooltipActions } from "../../overleaf/overleaf-track-changes";
import type { TrackedChange } from "../../overleaf/use-overleaf-realtime";
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
import { AllSelection, EditorState, NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import {
  CellSelection,
  TableMap,
  mergeCells as pmMergeCells,
  splitCell as pmSplitCell,
} from "@tiptap/pm/tables";
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
// Stateful seam, not the vendored original: upstream rebuilds its whole-doc
// DecorationSet on every view update (caret moves included), which is
// O(document) per keypress on large files. See the seam header for details.
import { HeadingAnchorsStateful as HeadingAnchors } from "@ok-app/editor/extensions/heading-anchors-stateful";
import {
  activeChunkDecorationPlugin,
  chunkWrapperDecorationPlugin,
} from "@ok-app/editor/extensions/chunk-wrapper-decoration";
import { MathInputRule } from "@ok-app/editor/math-input-rule";
import { InlineLinkInputRule } from "@ok-app/editor/inline-link-input-rule";
import { setHostKatexMacros } from "@ok-app/shims/katex-macros";
import { TableCellHandles } from "@ok-app/editor/table-controls/TableCellHandles";
import { BubbleMenuBar } from "@ok-app/editor/bubble-menu/BubbleMenuBar";
import { VisualCommentProvider } from "@ok-app/comments/CommentBubbleButton";
import { ViewInSourceProvider } from "@ok-app/editor/bubble-menu/ViewInSourceBubbleButton";
import { serializeWysiwygSelection } from "@ok-app/editor/edit-with-ai-selection";
import { EmojiInsertPopover } from "@ok-app/editor/components/EmojiInsertPopover";
import { MirrorHostProvider } from "@ok-app/editor/components/Mirror-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@ok-app/components/ui/button";
import { detectClipboardPrefillUrl } from "@ok-app/editor/clipboard/lone-url";
import { ImageSrcFidelity } from "../../open-knowledge-core/extensions/image-src-fidelity";
import { ProjectImageHostProvider, useProjectImageSrc } from "./project-image-host";
import { presenceCursorColor, type PresenceCursor } from "../../overleaf/overleaf-cursors";
import {
  editorCommentAuthorDisplayName,
  resolveCommentAnchor,
  type EditorComment,
} from "../comments/editor-comment-data";
import { peerColorForKey } from "../../components/ui/collab-colors";
import { notifyError, notifyInfo } from "../../telemetry/app-notify";
import { addAppLog, dismissAppToastByDedupeKey } from "../../telemetry/app-log-store";
import { InlineMessage } from "../../components/ui/inline-message";
import { InfinityLoader } from "../../components/ui/activity-icons";
import Zoom from "react-medium-image-zoom";
import { Check, TableCellsMerge, TableCellsSplit, X } from "lucide-react";
import { VisualMarkdownFindReplace } from "./visual-markdown-find-replace";
import {
  LARGE_MARKDOWN_PREVIEW_THRESHOLD,
  markdownPreviewSyncPolicy,
} from "./markdown-preview-sync-policy";
import { useNearViewport } from "./use-near-viewport";
import {
  buildVisualMarkdownBlockModel,
  type VisualMarkdownBlock,
  type VisualMarkdownBlockModel,
} from "./visual-markdown-block-model";
import { stripFrontmatter } from "../../open-knowledge-core/extensions/frontmatter";
import {
  parseTableSpanLayoutMarker,
  tableSpanLayoutForPmTable,
} from "../../open-knowledge-core/extensions/table-fidelity";
import { DocumentHeadingRail, documentHeadingItems } from "./document-heading-rail";

const EMPTY_MACROS: Record<string, string> = {};
const VISUAL_LINK_INSERT_EVENT = "research-writer:visual-link-insert";
const VISUAL_DOCUMENT_CACHE_LIMIT = 64;
const VISUAL_DOCUMENT_CACHE_TEXT_LIMIT = 4_000_000;
const TRACKED_CHANGE_HOVER_RADIUS = 24;
const TRACKED_CHANGE_CLOSE_DELAY_MS = 180;
const VIRTUAL_BLOCK_MODEL_SOURCE_THRESHOLD = 20_000;
const VIRTUAL_BLOCK_COUNT_THRESHOLD = 160;

const ChunkWrapperDecoration = Extension.create({
  name: "chunkWrapperDecoration",
  addProseMirrorPlugins() {
    return [chunkWrapperDecorationPlugin(), activeChunkDecorationPlugin()];
  },
});

function generatedPaperContentsDecorations(doc: Editor["state"]["doc"]): DecorationSet {
  const decorations: Decoration[] = [];
  let position = 0;
  for (let index = 0; index < doc.childCount - 1; index += 1) {
    const heading = doc.child(index);
    const list = doc.child(index + 1);
    let hasInternalAnchor = false;
    if (list.type.name === "list") {
      list.descendants((node) => {
        if (hasInternalAnchor || !node.isText) return !hasInternalAnchor;
        hasInternalAnchor = node.marks.some((mark) => (
          mark.type.name === "link"
          && typeof mark.attrs.href === "string"
          && mark.attrs.href.startsWith("#")
        ));
        return !hasInternalAnchor;
      });
    }
    if (
      heading.type.name === "heading"
      && heading.attrs.level === 2
      && heading.textContent.trim().toLocaleLowerCase() === "contents"
      && hasInternalAnchor
    ) {
      decorations.push(
        Decoration.node(position, position + heading.nodeSize, {
          class: "visual-generated-paper-contents",
          "aria-hidden": "true",
        }),
        Decoration.node(position + heading.nodeSize, position + heading.nodeSize + list.nodeSize, {
          class: "visual-generated-paper-contents",
          "aria-hidden": "true",
        }),
      );
    }
    position += heading.nodeSize;
  }
  return DecorationSet.create(doc, decorations);
}

/** Keep the imported Contents bytes editable while omitting that redundant block from paper previews. */
const GeneratedPaperContents = Extension.create({
  name: "generatedPaperContents",
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      state: {
        init: (_config, state) => generatedPaperContentsDecorations(state.doc),
        apply: (transaction, value) => transaction.docChanged
          ? generatedPaperContentsDecorations(transaction.doc)
          : value,
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    })];
  },
});

// The vendored editor normally renders a 56px toolbar over its document
// scroller. Lattice hosts the visual editor without that toolbar, so pin table
// headers to the actual viewport edge and do not paint the toolbar occluder.
const LatticeFrozenTableHeaders = FrozenTableHeaders.configure({
  topOffset: 0,
  occludeTop: false,
});

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

/**
 * Run a DOM mutation with ProseMirror's DOM observer paused, restarting it
 * even when the mutation throws. Hoisted to module scope: the try/finally
 * would make the React Compiler bail out of the component containing it.
 */
function withPausedDomObserver(view: Editor["view"], apply: () => void): void {
  const domObserver = (view as unknown as {
    domObserver?: { flush: () => void; start: () => void; stop: () => void };
  }).domObserver;
  domObserver?.flush();
  domObserver?.stop();
  try {
    apply();
  } finally {
    domObserver?.start();
  }
}

type VisualSourceRange = { from: number; to: number };

// Three-slot MRU parse memo. A single publication legitimately parses up to
// three distinct strings — the canonical text, the freshly serialized draft
// (restoreUnchangedBlocks compares both), and the caret-report snapshot — and
// a one-slot memo thrashed between them, costing three full parses where one
// suffices. Three slots cover exactly that working set; anything larger would
// only hold dead document generations alive.
const MDAST_CACHE_SLOTS = 3;
type EditorMdastChildren =
  ReturnType<ReturnType<typeof getMarkdownManager>["parseToEditorMdast"]>["children"];
type CachedEditorMdast = {
  children: EditorMdastChildren;
  sourceOffsetBase: number;
};
const mdastCache: ({ text: string } & CachedEditorMdast)[] = [];

function parseEditorMdastChildrenCached(text: string): CachedEditorMdast {
  const hit = mdastCache.findIndex((entry) => entry.text === text);
  if (hit !== -1) {
    const [entry] = mdastCache.splice(hit, 1);
    mdastCache.unshift(entry);
    return entry;
  }
  const bomLength = text.startsWith("\uFEFF") ? 1 : 0;
  const withoutBom = bomLength ? text.slice(1) : text;
  const { frontmatter, body } = stripFrontmatter(withoutBom);
  const sourceOffsetBase = bomLength + frontmatter.length;
  let children: EditorMdastChildren;
  try {
    // Frontmatter is document envelope, not an editor root. Parse only the
    // body so its non-emitting YAML node cannot shift every source/root pair;
    // ranges below add the envelope length back to the body-relative offsets.
    children = getMarkdownManager().parseToEditorMdast(body).children;
  } catch (error) {
    // The document itself opens through parse-with-fallback, which survives
    // MDX syntax errors, but this position probe uses the raw parser — a PDF
    // text-layer paper with an unclosed `{` throws here and was crashing the
    // whole editor over a scroll-sync lookup. Empty children degrade every
    // consumer to its no-position path (top-of-document anchors, canonical
    // serialization), which is the right trade for a document that already
    // renders a rawMdxFallback block. Cached so one broken paper does not
    // re-throw on every caret move.
    console.warn(JSON.stringify({
      event: "editor-mdast-parse-failed",
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
    }));
    children = [];
  }
  const entry = { text, children, sourceOffsetBase };
  mdastCache.unshift(entry);
  mdastCache.length = Math.min(mdastCache.length, MDAST_CACHE_SLOTS);
  return entry;
}

function visualSourceRanges(text: string, blockCount: number): VisualSourceRange[] {
  const { children: sourceNodes, sourceOffsetBase } = parseEditorMdastChildrenCached(text);
  const direct = sourceNodes.flatMap((node) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    return typeof from === "number" && typeof to === "number"
      ? [{ from: from + sourceOffsetBase, to: to + sourceOffsetBase }]
      : [];
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
// eslint-disable-next-line react-refresh/only-export-components -- exported for the corruption regression test
export function exactVisualSourceRanges(text: string, blockCount: number): VisualSourceRange[] | null {
  const { children: sourceNodes, sourceOffsetBase } = parseEditorMdastChildrenCached(text);
  if (sourceNodes.length !== blockCount) return null;
  const ranges: VisualSourceRange[] = [];
  let previousEnd = 0;
  for (const node of sourceNodes) {
    const relativeFrom = node.position?.start.offset;
    const relativeTo = node.position?.end.offset;
    if (typeof relativeFrom !== "number" || typeof relativeTo !== "number") return null;
    const from = relativeFrom + sourceOffsetBase;
    const to = relativeTo + sourceOffsetBase;
    if (from < previousEnd || to < from) return null;
    // Equal total counts do not prove ordinal ownership: an ignored YAML,
    // definition, or footnote node (zero PM roots) can cancel a mixed
    // paragraph that expands into two roots. Prove each source child owns
    // exactly one rendered root before allowing source-byte splicing.
    if ((parseVisualMarkdown(text.slice(from, to)).content?.length ?? 0) !== 1) return null;
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
  let scanEnd = previousLineEnd;
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

/**
 * Keep an explicit span valid while probing one of its rectangular source
 * coordinates. Every repeated coordinate receives the same sentinel at the
 * same content-relative offset, so strict metadata validation still applies
 * and the visual parser collapses the probes back into their one origin cell.
 */
function markExplicitTableSpanSource(
  text: string,
  sourceOffset: number,
  sentinel: string,
): string | null {
  const lines = text.split("\n");
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  let lineIndex = 0;
  for (let index = 1; index < starts.length && starts[index]! <= sourceOffset; index++) {
    lineIndex = index;
  }
  const sourceLine = lines[lineIndex]?.replace(/\r$/, "") ?? "";
  if (tableCellRanges(sourceLine).length === 0) return null;

  let tableStart = lineIndex;
  while (
    tableStart > 0
    && tableCellRanges(lines[tableStart - 1]!.replace(/\r$/, "")).length > 0
  ) tableStart -= 1;
  let tableEnd = lineIndex;
  while (
    tableEnd + 1 < lines.length
    && tableCellRanges(lines[tableEnd + 1]!.replace(/\r$/, "")).length > 0
  ) tableEnd += 1;
  const delimiterLine = Array.from(
    { length: tableEnd - tableStart + 1 },
    (_, index) => tableStart + index,
  ).find((index) => isTableDelimiterLine(lines[index]!.replace(/\r$/, "")));
  if (delimiterLine === undefined || delimiterLine <= tableStart) return null;
  const headerLine = delimiterLine - 1;
  const logicalRow = lineIndex === headerLine
    ? 0
    : lineIndex > delimiterLine
      ? lineIndex - delimiterLine
      : -1;
  if (logicalRow < 0) return null;

  const markerPrefix = text.slice(0, starts[headerLine]);
  const markerStart = markerPrefix.lastIndexOf("<!--");
  if (markerStart < 0) return null;
  const marker = markerPrefix.slice(markerStart).match(/^<!--\s*([\s\S]*?)\s*-->\s*$/);
  const layout = marker ? parseTableSpanLayoutMarker(marker[1]!.trim()) : null;
  if (layout === null) return null;

  const sourceColumn = sourceOffset - starts[lineIndex]!;
  const sourceRanges = tableCellRanges(sourceLine);
  const logicalColumn = sourceRanges.findIndex(({ from, to }, index) => (
    sourceColumn >= from && (sourceColumn < to || (index === sourceRanges.length - 1 && sourceColumn <= to))
  ));
  if (logicalColumn < 0) return null;
  const span = layout.find(([row, column, rowspan, colspan]) => (
    logicalRow >= row
    && logicalRow < row + rowspan
    && logicalColumn >= column
    && logicalColumn < column + colspan
  ));
  if (!span) return null;

  const sourceCell = sourceRanges[logicalColumn]!;
  const sourceRaw = sourceLine.slice(sourceCell.from, sourceCell.to);
  const sourceContentStart = sourceCell.from + sourceRaw.length - sourceRaw.trimStart().length;
  const sourceContent = sourceRaw.trim();
  const relativeOffset = Math.min(
    Math.max(sourceColumn - sourceContentStart, 0),
    sourceContent.length,
  );
  const insertionPoints = new Set<number>();
  const [spanRow, spanColumn, rowspan, colspan] = span;
  for (let row = spanRow; row < spanRow + rowspan; row++) {
    const targetLineIndex = row === 0 ? headerLine : delimiterLine + row;
    const targetLine = lines[targetLineIndex]?.replace(/\r$/, "");
    if (targetLine === undefined) return null;
    for (let column = spanColumn; column < spanColumn + colspan; column++) {
      const cell = tableCellRanges(targetLine)[column];
      if (!cell) return null;
      const raw = targetLine.slice(cell.from, cell.to);
      if (raw.trim() !== sourceContent) return null;
      const contentStart = starts[targetLineIndex]!
        + cell.from
        + raw.length
        - raw.trimStart().length;
      insertionPoints.add(contentStart + relativeOffset);
    }
  }

  let marked = text;
  for (const point of [...insertionPoints].sort((left, right) => right - left)) {
    marked = `${marked.slice(0, point)}${sentinel}${marked.slice(point)}`;
  }
  return marked;
}

function tableGeometrySignature(doc: Editor["state"]["doc"]): string {
  const tables: Array<Array<Array<[string, number, number]>>> = [];
  doc.descendants((node) => {
    if (node.type.name !== "table") return;
    const rows: Array<Array<[string, number, number]>> = [];
    node.forEach((row) => {
      const cells: Array<[string, number, number]> = [];
      row.forEach((cell) => {
        cells.push([
          cell.type.name,
          Number(cell.attrs.colspan ?? 1),
          Number(cell.attrs.rowspan ?? 1),
        ]);
      });
      rows.push(cells);
    });
    tables.push(rows);
    return false;
  });
  return JSON.stringify(tables);
}

type TableCellContext = {
  cell: PmNode;
  cellPosition: number;
  table: PmNode;
  tablePosition: number;
};

type TableSpanControlState = "merge" | "merge-disabled" | "split" | null;

function tableContextAtPosition($position: ResolvedPos): {
  table: PmNode;
  tablePosition: number;
} | null {
  for (let depth = $position.depth; depth > 0; depth--) {
    const node = $position.node(depth);
    if (node.type.spec.tableRole !== "table" && node.type.name !== "table") continue;
    return { table: node, tablePosition: $position.before(depth) };
  }
  return null;
}

function selectedTableCellContext(state: EditorState): TableCellContext | null {
  const { selection } = state;
  if (selection instanceof CellSelection) {
    if (selection.$anchorCell.pos !== selection.$headCell.pos) return null;
    const cell = selection.$anchorCell.nodeAfter;
    const tableContext = tableContextAtPosition(selection.$anchorCell);
    return cell && tableContext
      ? { ...tableContext, cell, cellPosition: selection.$anchorCell.pos }
      : null;
  }
  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    const role = node.type.spec.tableRole;
    if (role !== "cell" && role !== "header_cell") continue;
    const tableContext = tableContextAtPosition($from);
    return tableContext
      ? { ...tableContext, cell: node, cellPosition: $from.before(depth) }
      : null;
  }
  return null;
}

function pmTableCellIsEmpty(cell: PmNode): boolean {
  return cell.childCount === 1 && Boolean(cell.firstChild?.isTextblock)
    && cell.firstChild!.content.size === 0;
}

function selectedCellsRepeatPopulatedContent(state: EditorState): boolean {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) return false;
  const cells: PmNode[] = [];
  selection.forEachCell((cell) => cells.push(cell));
  const populated = cells.filter((cell) => !pmTableCellIsEmpty(cell));
  return populated.length > 1
    && populated.slice(1).every((cell) => cell.content.eq(populated[0]!.content));
}

function tableSpanControlState(editor: Editor): TableSpanControlState {
  if (!editor.isEditable) return null;
  const { state } = editor;
  const { selection } = state;
  if (
    selection instanceof CellSelection
    && selection.$anchorCell.pos !== selection.$headCell.pos
  ) {
    return pmMergeCells(state) ? "merge" : "merge-disabled";
  }
  return pmSplitCell(state) ? "split" : null;
}

function markSelectedTableLayoutExplicit(transaction: Transaction): boolean {
  const resolved = transaction.selection instanceof CellSelection
    ? transaction.selection.$anchorCell
    : transaction.selection.$from;
  const context = tableContextAtPosition(resolved);
  if (!context) return false;
  const table = transaction.doc.nodeAt(context.tablePosition);
  if (!table) return false;
  transaction.setNodeMarkup(context.tablePosition, undefined, {
    ...table.attrs,
    sourceSpanLayout: tableSpanLayoutForPmTable(table),
  });
  return true;
}

function mergeSelectedTableCells(editor: Editor): void {
  if (tableSpanControlState(editor) !== "merge") {
    notifyInfo("Table", "Select a complete rectangular group of cells.");
    return;
  }
  const deduplicateRepeatedContent = selectedCellsRepeatPopulatedContent(editor.state);
  editor.chain()
    .focus()
    .command(({ tr }) => {
      // ProseMirror preserves different cell contents as separate blocks in
      // the merged cell. Only clear duplicates when every populated cell is
      // identical, which keeps extracted-paper labels from becoming
      // "GroupGroupGroup" while allowing an arbitrary rectangular selection.
      if (!deduplicateRepeatedContent) return true;
      const { selection } = tr;
      if (!(selection instanceof CellSelection)) return false;
      const cells: Array<{ cell: PmNode; position: number }> = [];
      selection.forEachCell((cell, position) => cells.push({ cell, position }));
      const preferred = cells.find(({ cell }) => !pmTableCellIsEmpty(cell));
      for (const { position } of cells.sort((left, right) => right.position - left.position)) {
        if (position === preferred?.position) continue;
        const cell = tr.doc.nodeAt(position);
        if (!cell || pmTableCellIsEmpty(cell)) continue;
        const emptyCell = cell.type.createAndFill(cell.attrs);
        if (!emptyCell) return false;
        tr.replaceWith(position + 1, position + cell.nodeSize - 1, emptyCell.content);
      }
      return true;
    })
    .mergeCells()
    .command(({ tr }) => markSelectedTableLayoutExplicit(tr))
    .run();
}

function splitSelectedTableCell(editor: Editor): void {
  const target = selectedTableCellContext(editor.state);
  if (!target || !pmSplitCell(editor.state)) return;
  const map = TableMap.get(target.table);
  const rect = map.findCell(target.cellPosition - target.tablePosition - 1);
  const sourceContent = target.cell.content;
  editor.chain()
    .focus()
    .splitCell()
    .command(({ tr }) => {
      const table = tr.doc.nodeAt(target.tablePosition);
      if (!table) return false;
      const splitMap = TableMap.get(table);
      const positions = new Map<number, number>();
      for (let row = rect.top; row < rect.bottom; row++) {
        for (let column = rect.left; column < rect.right; column++) {
          const relative = splitMap.map[row * splitMap.width + column];
          if (relative != null) positions.set(target.tablePosition + 1 + relative, row);
        }
      }
      for (const [position, row] of [...positions].sort((left, right) => right[0] - left[0])) {
        const cell = tr.doc.nodeAt(position);
        if (!cell) return false;
        const crossesGfmHeaderBoundary = rect.top === 0 && rect.bottom > 1;
        const expectedType = crossesGfmHeaderBoundary
          ? tr.doc.type.schema.nodes[row === 0 ? "tableHeader" : "tableCell"]
          : target.cell.type;
        if (!expectedType) return false;
        if (cell.type !== expectedType) {
          tr.setNodeMarkup(position, expectedType, cell.attrs, cell.marks);
        }
        if (!cell.content.eq(sourceContent)) {
          tr.replaceWith(position + 1, position + cell.nodeSize - 1, sourceContent);
        }
      }
      return markSelectedTableLayoutExplicit(tr);
    })
    .run();
}

function TableSpanControls({ editor }: { editor: Editor }) {
  const action = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => tableSpanControlState(currentEditor),
  });
  const mergeReasonId = useId();
  if (!action) return null;
  const mergeDisabled = action === "merge-disabled";
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableSpanControls"
      appendTo={() => document.body}
      shouldShow={({ editor: currentEditor }) => tableSpanControlState(currentEditor) !== null}
      updateDelay={0}
      className="visual-table-span-controls"
      data-testid="table-span-controls"
    >
      {action === "split" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => splitSelectedTableCell(editor)}
        >
          <TableCellsSplit aria-hidden />
          Split cell
        </Button>
      ) : (
        <>
          <span
            className="inline-flex"
            title={mergeDisabled
              ? "Select a complete rectangular group of cells"
              : undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mergeDisabled}
              aria-describedby={mergeDisabled ? mergeReasonId : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => mergeSelectedTableCells(editor)}
            >
              <TableCellsMerge aria-hidden />
              Merge cells
            </Button>
          </span>
          {mergeDisabled && (
            <span id={mergeReasonId} className="sr-only">
              Only a complete rectangular group of cells can be merged.
            </span>
          )}
        </>
      )}
    </BubbleMenu>
  );
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
  sourcePath?: string,
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
    const marked = markExplicitTableSpanSource(text, offset, sentinel)
      ?? `${text.slice(0, offset)}${sentinel}${text.slice(offset)}`;
    const parsed = doc.type.schema.nodeFromJSON(parseVisualMarkdown(marked, sourcePath));
    // Inserting a marker into one coordinate covered by an inferred paper
    // span changes the evidence used to infer that span. Do not map through a
    // differently shaped temporary table; an omitted overlay is safer than an
    // action painted over another cell.
    if (tableGeometrySignature(parsed) !== tableGeometrySignature(doc)) return null;
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

/**
 * Large documents cannot afford the whole-document sentinel serialization
 * below on every caret move. When each rendered block maps exactly onto one
 * source range, serializing only the caret's top-level block recovers the
 * offset at a fraction of the cost. The intra-block position comes from the
 * serializer's canonical form of that one block, so inside an edited,
 * not-yet-published block it can drift by the serializer's normalization;
 * the offset is clamped into the block's source range either way.
 */
function blockSourceOffsetForPosition(
  editor: Editor,
  position: number,
  expectedMarkdown: string,
): { markdown: string; offset: number } | null {
  const doc = editor.state.doc;
  const ranges = exactVisualSourceRanges(expectedMarkdown, doc.childCount);
  if (!ranges) return null;
  const at = Math.min(Math.max(position, 0), doc.content.size);
  const resolved = doc.resolve(at);
  const blockIndex = Math.min(resolved.index(0), doc.childCount - 1);
  const range = ranges[blockIndex];
  if (!range) return null;
  // A caret between blocks, or on a non-text block (a horizontal rule, a
  // selected figure), has no character-precise source position to recover.
  if (resolved.depth === 0 || !resolved.parent.isTextblock) {
    return { markdown: expectedMarkdown, offset: range.from };
  }
  try {
    const transaction = editor.state.tr;
    for (let depth = 1; depth <= resolved.depth; depth += 1) {
      if (resolved.node(depth).type.name === "jsxComponent") {
        transaction.setNodeAttribute(resolved.before(depth), "sourceDirty", true);
      }
    }
    const sentinel = cursorSentinel(expectedMarkdown);
    const marked = transaction.insertText(sentinel, at).doc;
    if (marked.childCount !== doc.childCount) return null;
    const serialized = getMarkdownManager().serialize({
      type: "doc",
      content: [marked.child(blockIndex).toJSON()],
    });
    const index = serialized.indexOf(sentinel);
    if (index < 0) return null;
    return {
      markdown: expectedMarkdown,
      offset: Math.min(range.from + index, range.to),
    };
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
  if (expectedMarkdown.length >= LARGE_MARKDOWN_PREVIEW_THRESHOLD) {
    const blockScoped = blockSourceOffsetForPosition(editor, position, expectedMarkdown);
    if (blockScoped) return blockScoped;
  }
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
  constructor(readonly name: string, readonly color: string) {}

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "visual-overleaf-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.style.borderColor = this.color;
    const dot = document.createElement("span");
    dot.className = "visual-overleaf-caret-dot";
    dot.style.backgroundColor = this.color;
    const label = document.createElement("span");
    label.className = "visual-overleaf-caret-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name || "Anonymous";
    caret.append(dot, label);
    return caret;
  }

}

type VisualPresenceMeta = { text: string; sourcePath: string; cursors: PresenceCursor[] };
const visualPresenceKey = new PluginKey<VisualPresenceMeta & { decorations: DecorationSet }>(
  "visualOverleafPresence",
);

function visualPresenceDecorations(
  doc: Editor["state"]["doc"],
  text: string,
  sourcePath: string,
  cursors: PresenceCursor[],
): DecorationSet {
  return DecorationSet.create(doc, cursors.flatMap((cursor) => {
    const position = proseMirrorPositionForSourceOffset(
      doc,
      text,
      sourceOffsetForRowColumn(text, cursor.row, cursor.column),
      sourcePath,
    );
    return position === null ? [] : [Decoration.widget(
      position,
      () => new VisualPresenceCaret(cursor.name, presenceCursorColor(cursor)).toDOM(),
      // A coordinate-bearing key prevents ProseMirror from reusing the old
      // widget DOM for the same collaborator after their caret moves. Keep
      // the default selection handling: ignoring DOM selections inside the
      // widget makes WebKit unable to place a local caret in the same cell.
      {
        side: 1,
        key: `${cursor.name}:${presenceCursorColor(cursor)}:${cursor.row}:${cursor.column}`,
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
          sourcePath: "",
          cursors: [],
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualPresenceKey) as VisualPresenceMeta | undefined;
          const text = meta?.text ?? current.text;
          const cursors = meta?.cursors ?? current.cursors;
          return {
            text,
            sourcePath: meta?.sourcePath ?? current.sourcePath,
            cursors,
            decorations: meta
              ? visualPresenceDecorations(newState.doc, text, meta.sourcePath, cursors)
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

type VisualTrackChangesMeta = { text: string; sourcePath: string; changes: TrackedChange[] };
const visualTrackChangesKey = new PluginKey<VisualTrackChangesMeta & { decorations: DecorationSet }>(
  "visualOverleafTrackChanges",
);

function visualTrackChangeDecorations(
  doc: Editor["state"]["doc"],
  text: string,
  sourcePath: string,
  changes: TrackedChange[],
): DecorationSet {
  return DecorationSet.create(doc, changes.flatMap((change) => {
    const from = proseMirrorPositionForSourceOffset(doc, text, change.position, sourcePath);
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
    const to = proseMirrorPositionForSourceOffset(
      doc,
      text,
      change.position + change.text.length,
      sourcePath,
    );
    if (to === null || to <= from || text.slice(change.position, change.position + change.text.length) !== change.text) {
      return [];
    }
    return [Decoration.inline(from, to, {
      ...attributes,
    })];
  }));
}

const EMPTY_EDITOR_COMMENTS: EditorComment[] = [];

type VisualCommentsMeta = {
  text: string;
  sourcePath: string;
  comments: EditorComment[];
  activeId: string | null;
  labelForAuthor: (authorName: string) => string;
};
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
  sourcePath: string,
  comments: EditorComment[],
  activeId: string | null,
  labelForAuthor: (authorName: string) => string,
): DecorationSet {
  return DecorationSet.create(doc, comments.flatMap((comment) => {
    if (comment.resolved) return [];
    const anchor = resolveCommentAnchor(text, comment);
    if (!anchor) return [];
    const from = proseMirrorPositionForSourceOffset(doc, text, anchor.from, sourcePath);
    if (from === null) return [];
    const to = proseMirrorPositionForSourceOffset(doc, text, anchor.to, sourcePath);
    if (to === null || to <= from) return [];
    // Same per-author colour the source editor marks it with, so the two
    // surfaces read as one feature rather than two.
    const colors = peerColorForKey(comment.authorId || comment.authorName);
    return [Decoration.inline(from, to, {
      class: `visual-editor-comment${comment.id === activeId ? " visual-editor-comment-active" : ""}`,
      "data-visual-comment-id": comment.id,
      role: "button",
      tabindex: "0",
      "aria-label": labelForAuthor(comment.authorName),
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
          sourcePath: "",
          comments: [],
          activeId: null,
          labelForAuthor: () => "",
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualCommentsKey) as VisualCommentsMeta | undefined;
          return meta
            ? {
                ...meta,
                decorations: visualCommentDecorations(
                  newState.doc,
                  meta.text,
                  meta.sourcePath,
                  meta.comments,
                  meta.activeId,
                  meta.labelForAuthor,
                ),
              }
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
          sourcePath: "",
          changes: [],
          decorations: DecorationSet.empty,
        }),
        apply: (transaction, current, _oldState, newState) => {
          const meta = transaction.getMeta(visualTrackChangesKey) as VisualTrackChangesMeta | undefined;
          return meta
            ? {
                ...meta,
                decorations: visualTrackChangeDecorations(
                  newState.doc,
                  meta.text,
                  meta.sourcePath,
                  meta.changes,
                ),
              }
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
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
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
  onViewInSource?: (
    sourceOffset: number,
    viewportY?: number,
    blockViewportY?: number,
  ) => void;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset?: (path: string) => Promise<string | null>;
  presenceCursors?: PresenceCursor[];
  onCaretChange?: (row: number, column: number) => void;
  onSourceCaretChange?: (sourceOffset: number) => void;
  onSelectionMarkdown?: (value: string) => void;
  overleafChanges?: TrackedChange[];
  /** Comments anchored in this file, painted as highlights over the prose. */
  editorComments?: EditorComment[];
  activeEditorCommentId?: string | null;
  onEditorCommentClick?: (id: string) => void;
  overleafTrackChangeActions?: TrackedChangeTooltipActions;
  onCreateComment?: (from: number, to: number, body: string) => void;
  editable?: boolean;
  /** Internal handoff from the passive block viewport to the complete editor. */
  initialHandoff?: PassiveEditorHandoff;
  onConsumeInitialHandoff?: () => void;
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
  const { nearViewport, viewportRef } = useNearViewport<HTMLSpanElement>();
  const src = useProjectImageSrc(
    typeof node.attrs.src === "string" ? node.attrs.src : undefined,
    nearViewport,
  );
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
  return (
    <NodeViewWrapper
      as="span"
      ref={viewportRef}
      data-image-inline-zoom
      data-clipboard-inline-leaf="image"
    >
      {nearViewport && src ? (
        <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
          <img src={src} alt={alt} title={title} loading="eager" decoding="async" />
        </Zoom>
      ) : (
        <img src={src} alt={alt} title={title} loading="eager" decoding="async" />
      )}
    </NodeViewWrapper>
  );
}

type PassiveVisualChunk = {
  id: string;
  blocks: VisualMarkdownBlock[];
  from: number;
  content: NonNullable<ReturnType<typeof parseVisualMarkdown>["content"]>;
  estimatedHeight: number;
};

type PassiveEditorHandoff = {
  sourceOffset: number;
  clientX?: number;
  clientY?: number;
  blockTop?: number;
  pointerId?: number;
  fragment?: string;
  navigationOnly?: boolean;
  command?: "find" | "selectAll";
};

function passiveVisualChunks(model: VisualMarkdownBlockModel): PassiveVisualChunk[] {
  const chunks: PassiveVisualChunk[] = [];
  let blocks: VisualMarkdownBlock[] = [];
  let estimatedHeight = 0;
  const flush = () => {
    if (!blocks.length) return;
    chunks.push({
      id: `${blocks[0]!.id}:${blocks.at(-1)!.id}`,
      blocks,
      from: blocks[0]!.from,
      content: blocks.flatMap((block) => block.content),
      estimatedHeight,
    });
    blocks = [];
    estimatedHeight = 0;
  };
  for (const block of model.blocks) {
    blocks.push(block);
    estimatedHeight += block.estimatedHeight;
    // Keep a heading with the block that follows it. Besides making passive
    // reading less visually fragmented, this preserves the generated Paper
    // Contents heading + list pair that the render-only decoration recognizes.
    const endsWithHeading = block.content.at(-1)?.type === "heading";
    if (!endsWithHeading && (estimatedHeight >= 720 || blocks.length >= 12)) flush();
  }
  flush();
  return chunks;
}

function sourceBlockAtPointer(
  chunk: PassiveVisualChunk,
  target: EventTarget | null,
): { sourceOffset: number; blockTop?: number } {
  if (!(target instanceof Node)) return { sourceOffset: chunk.from };
  const element = target instanceof HTMLElement ? target : target.parentElement;
  const proseMirror = element?.closest<HTMLElement>(".ProseMirror");
  if (!proseMirror) return { sourceOffset: chunk.from };
  if (element === proseMirror) return { sourceOffset: chunk.from };
  let topLevel: HTMLElement | null = element;
  while (topLevel?.parentElement && topLevel.parentElement !== proseMirror) {
    if (!proseMirror.contains(topLevel.parentElement)) return { sourceOffset: chunk.from };
    topLevel = topLevel.parentElement;
  }
  if (topLevel?.parentElement !== proseMirror) return { sourceOffset: chunk.from };
  const index = topLevel ? Array.from(proseMirror.children).indexOf(topLevel) : -1;
  const block = chunk.blocks[Math.max(0, index)] ?? chunk.blocks[0];
  return {
    sourceOffset: block?.from ?? chunk.from,
    ...(topLevel ? { blockTop: topLevel.getBoundingClientRect().top } : {}),
  };
}

function MountedPassiveVisualChunk({
  chunk,
  index,
  optimizeForReading,
  onActivate,
  onMeasure,
}: {
  chunk: PassiveVisualChunk;
  index: number;
  optimizeForReading: boolean;
  onActivate: (handoff: PassiveEditorHandoff) => void;
  onMeasure: (index: number, height: number, element: HTMLElement) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingLinkDragRef = useRef<{
    handoff: PassiveEditorHandoff;
    clientX: number;
    clientY: number;
  } | null>(null);
  const extensions = useMemo(() => visualEditorExtensions(ImageSrcFidelity.extend({
    addNodeView() {
      return ReactNodeViewRenderer(ProjectInlineImageView, { as: "span" });
    },
  })).concat(optimizeForReading ? [GeneratedPaperContents] : []), [optimizeForReading]);
  const editor = useEditor({
    editable: false,
    shouldRerenderOnTransaction: false,
    extensions,
    content: { type: "doc", content: chunk.content },
    editorProps: {
      attributes: {
        tabindex: "-1",
      },
    },
  }, [chunk.id]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) onMeasure(index, height, element);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  useEffect(() => {
    const clearPendingLinkDrag = () => {
      pendingLinkDragRef.current = null;
    };
    const continueLinkDrag = (event: PointerEvent) => {
      const pending = pendingLinkDragRef.current;
      if (!pending) return;
      if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < 4) return;
      pendingLinkDragRef.current = null;
      event.preventDefault();
      onActivate({
        ...pending.handoff,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };
    window.addEventListener("pointermove", continueLinkDrag, { passive: false });
    window.addEventListener("pointerup", clearPendingLinkDrag);
    window.addEventListener("pointercancel", clearPendingLinkDrag);
    return () => {
      window.removeEventListener("pointermove", continueLinkDrag);
      window.removeEventListener("pointerup", clearPendingLinkDrag);
      window.removeEventListener("pointercancel", clearPendingLinkDrag);
    };
  }, [onActivate]);

  if (!editor) return null;
  return (
    <div
      ref={contentRef}
      className="tiptap-editor visual-markdown-virtual-block-content"
      data-visual-chunk-id={chunk.id}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement
          && target.closest("button, input, textarea, select, summary, [role='button'], [data-image-inline-zoom]")
        ) return;
        const source = sourceBlockAtPointer(chunk, target);
        if (target instanceof HTMLElement && target.closest("a[href]")) {
          pendingLinkDragRef.current = {
            handoff: {
              ...source,
              pointerId: event.pointerId,
            },
            clientX: event.clientX,
            clientY: event.clientY,
          };
          return;
        }
        event.preventDefault();
        onActivate({
          ...source,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
        });
      }}
    >
      <EditorContent className="tiptap-editor-portal-content" editor={editor} />
    </div>
  );
}

function PassiveVisualMarkdownViewport({
  model,
  activePath,
  optimizeForReading,
  onActivate,
  onLoadAsset,
  onOpenProjectPath,
  workspaceIndex,
}: {
  model: VisualMarkdownBlockModel;
  activePath: string;
  optimizeForReading: boolean;
  onActivate: (handoff: PassiveEditorHandoff) => void;
  onLoadAsset?: (path: string) => Promise<string | null>;
  onOpenProjectPath?: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
}) {
  const chunks = useMemo(() => passiveVisualChunks(model), [model]);
  const headingItems = useMemo(() => documentHeadingItems({
    type: "doc",
    content: model.blocks.flatMap((block) => block.content),
  }, { hideGeneratedContents: optimizeForReading }), [model, optimizeForReading]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const scrollCompensationRef = useRef(0);
  const [heights, setHeights] = useState(() => chunks.map((chunk) => chunk.estimatedHeight));
  const [mountedRange, setMountedRange] = useState(() => ({
    from: 0,
    to: Math.min(chunks.length, 3),
  }));
  const updateMountedRange = useCallback(() => {
    const section = sectionRef.current;
    const scroller = scrollRef.current;
    if (!section || !scroller || !chunks.length) return;
    const sectionRect = section.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportFrom = Math.max(0, scrollerRect.top - sectionRect.top - 1_600);
    const viewportTo = Math.max(viewportFrom, scrollerRect.bottom - sectionRect.top + 1_600);
    let cursor = 0;
    let from = 0;
    while (from < heights.length && cursor + heights[from]! < viewportFrom) {
      cursor += heights[from]!;
      from += 1;
    }
    let to = from;
    while (to < heights.length && cursor < viewportTo) {
      cursor += heights[to]!;
      to += 1;
    }
    from = Math.max(0, from - 1);
    to = Math.min(chunks.length, Math.max(to + 1, from + 1));
    to = Math.min(to, from + 12);
    setMountedRange((current) => current.from === from && current.to === to ? current : { from, to });
  }, [chunks.length, heights]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const scroller = section.closest<HTMLElement>(".editor-doc-scroll");
    if (!scroller) return;
    scrollRef.current = scroller;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateMountedRange();
      });
    };
    updateMountedRange();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      scrollRef.current = null;
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updateMountedRange]);
  useLayoutEffect(() => {
    const compensation = scrollCompensationRef.current;
    const scroller = scrollRef.current;
    if (!compensation || !scroller) return;
    scrollCompensationRef.current = 0;
    scroller.scrollTop += compensation;
  }, [heights]);
  const measureChunk = useCallback((index: number, height: number, element: HTMLElement) => {
    setHeights((current) => {
      const previous = current[index];
      if (previous == null || previous === height) return current;
      const scroller = scrollRef.current;
      if (scroller && element.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top) {
        scrollCompensationRef.current += height - previous;
      }
      const next = [...current];
      next[index] = height;
      return next;
    });
  }, []);
  const topHeight = heights.slice(0, mountedRange.from).reduce((sum, height) => sum + height, 0);
  const bottomHeight = heights.slice(mountedRange.to).reduce((sum, height) => sum + height, 0);

  return (
    <section
      ref={sectionRef}
      className={`visual-markdown-editor visual-markdown-virtual-viewport${optimizeForReading ? " optimize-for-reading" : ""}`}
      data-active-path={activePath}
      data-virtualized="true"
      aria-label="Visual Markdown editor"
      role="document"
      tabIndex={0}
      onFocusCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest(".visual-heading-rail")) return;
        onActivate({ sourceOffset: model.blocks[0]?.from ?? 0 });
      }}
      onKeyDownCapture={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        const key = event.key.toLocaleLowerCase();
        if (key !== "f" && key !== "a") return;
        event.preventDefault();
        event.stopPropagation();
        onActivate({
          sourceOffset: model.blocks[0]?.from ?? 0,
          command: key === "f" ? "find" : "selectAll",
        });
      }}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        const href = anchor?.getAttribute("href");
        if (!anchor || !href) return;
        event.preventDefault();
        event.stopPropagation();
        const localFragment = localPaperFragment(activePath, href);
        if (localFragment) {
          onActivate({
            sourceOffset: model.blocks[0]?.from ?? 0,
            fragment: `#${encodeURIComponent(localFragment.id)}`,
            navigationOnly: true,
          });
          return;
        }
        openMarkdownLink(activePath, href, onOpenProjectPath, sectionRef.current ?? undefined);
      }}
    >
      <DocumentHeadingRail
        items={headingItems}
        virtualized
        onSelect={(item) => onActivate({
          sourceOffset: model.blocks[0]?.from ?? 0,
          fragment: `#${encodeURIComponent(item.id)}`,
          navigationOnly: true,
        })}
      />
      <button
        type="button"
        className="visual-markdown-virtual-edit"
        onClick={() => onActivate({ sourceOffset: model.blocks[0]?.from ?? 0 })}
      >Edit document</button>
      <ProjectImageHostProvider activePath={activePath} loadAsset={onLoadAsset}>
        <MirrorHostProvider workspaceIndex={workspaceIndex}>
          <TooltipProvider delayDuration={280} skipDelayDuration={400}>
            <div aria-hidden="true" style={{ height: `${topHeight}px` }} />
            {chunks.slice(mountedRange.from, mountedRange.to).map((chunk, offset) => (
              <MountedPassiveVisualChunk
                key={chunk.id}
                chunk={chunk}
                index={mountedRange.from + offset}
                optimizeForReading={optimizeForReading}
                onActivate={onActivate}
                onMeasure={measureChunk}
              />
            ))}
            <div aria-hidden="true" style={{ height: `${bottomHeight}px` }} />
          </TooltipProvider>
        </MirrorHostProvider>
      </ProjectImageHostProvider>
    </section>
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
// eslint-disable-next-line react-refresh/only-export-components -- exported for the corruption regression test
export function restoreUnchangedBlocks(
  serialized: string,
  expected: string,
  currentDoc: Editor["state"]["doc"],
  changedBlocks?: ReadonlySet<number>,
  sourcePath?: string,
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
      // inline-math atom or an image can be deleted without touching a
      // character of text, and that has to read as a change or the deletion
      // is restored away.
      if (child.type.name === "hardBreak") return;
      if (child.isLeaf || child.isAtom) semantics.push([child.type.name, child.attrs]);
    });
    return JSON.stringify(semantics);
  };
  let expectedDoc: Editor["state"]["doc"];
  try {
    expectedDoc = currentDoc.type.schema.nodeFromJSON(parseVisualMarkdown(expected, sourcePath));
  } catch {
    return serialized;
  }
  if (currentDoc.childCount !== expectedDoc.childCount) return serialized;
  // A leading BOM is envelope, not content: the parser reports offsets into the
  // body without it and preserveMarkdownEnvelope re-attaches it around whatever
  // we return, so every offset below — and the result — works on the body.
  const body = expected.startsWith("\uFEFF") ? expected.slice(1) : expected;
  const isUnchanged = (index: number) => {
    if (changedBlocks?.has(index)) return false;
    const current = currentDoc.child(index);
    const original = expectedDoc.child(index);
    return current.eq(original)
      || (current.isTextblock && current.sameMarkup(original) && (
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

  // Never splice source through visualSourceRanges' best-effort mapping. A
  // single MDAST node can expand into several ProseMirror roots; its repeated
  // fallback range is useful for approximate navigation but would copy the
  // same formula or container over later blocks during serialization. When
  // ownership is uncertain, canonical serialization is less faithful but it
  // cannot duplicate or replace unrelated document content.
  return serialized;
}

function serializeMarkdown(
  editor: Editor,
  expected: string,
  changedBlocks?: ReadonlySet<number>,
  sourcePath?: string,
): string {
  return restoreUnchangedBlocks(
    getMarkdownManager().serialize(editor.getJSON()),
    expected,
    editor.state.doc,
    changedBlocks,
    sourcePath,
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

function paperArxivIdFromPath(activePath: string): string | null {
  const prefix = ".research/papers/";
  const suffix = "/paper.md";
  const normalized = activePath.replace(/\\/g, "/");
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) return null;
  const id = normalized.slice(prefix.length, -suffix.length);
  return id && !id.startsWith("web-") ? id : null;
}

function baseArxivId(id: string): string {
  return id.replace(/v\d+$/i, "");
}

/** The fragment when an arXiv URL points back into the paper already open. */
function localPaperFragment(activePath: string, href: string): { id: string; fallbackUrl?: string } | null {
  const paperId = paperArxivIdFromPath(activePath);
  let fragment = href;
  let fallbackUrl = paperId ? `https://arxiv.org/html/${paperId}${href}` : undefined;
  if (!href.startsWith("#")) {
    if (!paperId) return null;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!/^(?:www\.)?arxiv\.org$/i.test(url.hostname) || !url.pathname.startsWith("/html/") || !url.hash) {
      return null;
    }
    let linkedId: string;
    try {
      linkedId = decodeURIComponent(url.pathname.slice("/html/".length));
    } catch {
      return null;
    }
    if (baseArxivId(linkedId).toLocaleLowerCase() !== baseArxivId(paperId).toLocaleLowerCase()) {
      return null;
    }
    fragment = url.hash;
    fallbackUrl = href;
  }
  if (fragment === "#") return null;
  try {
    return { id: decodeURIComponent(fragment.slice(1)), fallbackUrl };
  } catch {
    return null;
  }
}

function markdownAnchorTarget(editorElement: HTMLElement | undefined, id: string): HTMLElement | null {
  const elements = Array.from(editorElement?.querySelectorAll<HTMLElement>("[id]") ?? []);
  let candidate = id;
  while (candidate) {
    const target = elements.find((element) => element.id === candidate);
    if (target) return target;
    // LaTeXML gives subfigures ids such as S7.F10.sf1 while arxiv2md keeps
    // only the parent figure anchor. The parent is the closest honest local
    // destination and avoids sending an otherwise readable paper to the web.
    const separator = candidate.lastIndexOf(".");
    candidate = separator > 0 ? candidate.slice(0, separator) : "";
  }
  return null;
}

function openMarkdownLink(
  activePath: string,
  href: string,
  onOpenProjectPath?: (path: string) => void,
  editorElement?: HTMLElement,
) {
  const localFragment = localPaperFragment(activePath, href);
  if (localFragment) {
    const target = markdownAnchorTarget(editorElement, localFragment.id);
    if (target) target.scrollIntoView({ block: "start" });
    else if (localFragment.fallbackUrl) void openUrl(localFragment.fallbackUrl).catch(() => undefined);
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
              {editorViewMounted && <TableCellHandles editor={editor} />}
              {editorViewMounted && <TableSpanControls editor={editor} />}
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

function CompleteVisualMarkdownEditor({
  text,
  activePath,
  onChangeMarkdown,
  onFlushPendingChange,
  optimizeForReading = false,
  synchronizeSourceScroll = true,
  onRequestViewportLock,
  onOpenProjectPath,
  workspaceIndex,
  papers,
  onUndo,
  onRedo,
  onEditSource,
  onViewInSource,
  onImportAsset,
  onLoadAsset,
  presenceCursors = [],
  onCaretChange,
  onSourceCaretChange,
  onSelectionMarkdown,
  overleafChanges = [],
  editorComments = EMPTY_EDITOR_COMMENTS,
  activeEditorCommentId = null,
  onEditorCommentClick,
  overleafTrackChangeActions,
  onCreateComment,
  editable = true,
  initialHandoff,
  onConsumeInitialHandoff,
}: VisualMarkdownEditorProps): JSX.Element {
  const { i18n, t } = useLingui();
  const anonymousAuthor = t`Anonymous`;
  const headingItems = useMemo(() => documentHeadingItems(
    cachedVisualDocument(activePath, text).content,
    { hideGeneratedContents: optimizeForReading },
  ), [activePath, optimizeForReading, text]);
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [renderedPath, setRenderedPath] = useState(activePath);
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
  const selectionMarkdownRef = useRef(onSelectionMarkdown);
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
    // Resolved in the body rather than as a default parameter: the React
    // Compiler cannot reorder `??` expressions in default-value position.
    const focusAnchor = (requestedIds?: string[]) => {
      const ids = requestedIds ?? hoveredChangesRef.current?.changeIds ?? [];
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
    selectionMarkdownRef.current = onSelectionMarkdown;
  }, [onCaretChange, onSelectionMarkdown, onSourceCaretChange]);
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
  const caretReportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportVisualCaret = useCallback((currentEditor: Editor, expectedMarkdown: string) => {
    if (caretReportTimer.current) {
      clearTimeout(caretReportTimer.current);
      caretReportTimer.current = null;
    }
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
  // Selection updates arrive per keystroke, and recovering a caret's source
  // offset costs a serialization pass. Coalesce to one report per interaction
  // pause so editor transactions themselves stay cheap; explicit callers
  // (publication flush) still report synchronously and cancel a pending one.
  const scheduleVisualCaretReport = useCallback((currentEditor: Editor) => {
    if (caretReportTimer.current) clearTimeout(caretReportTimer.current);
    caretReportTimer.current = setTimeout(() => {
      caretReportTimer.current = null;
      if (currentEditor.isDestroyed) return;
      reportVisualCaret(currentEditor, acceptedMarkdown.current);
    }, 120);
  }, [reportVisualCaret]);
  useEffect(() => () => {
    if (caretReportTimer.current) clearTimeout(caretReportTimer.current);
  }, []);
  const refreshVisualPresence = useCallback((currentEditor: Editor, markdown: string) => {
    if (currentEditor.isDestroyed || !presenceWasActive.current) return;
    currentEditor.view.dispatch(currentEditor.state.tr.setMeta(visualPresenceKey, {
      text: markdown,
      sourcePath: activePathRef.current,
      cursors: presenceCursorsRef.current,
    } satisfies VisualPresenceMeta));
  }, []);
  const refreshVisualTrackChanges = useCallback((
    currentEditor: Editor,
    markdown: string,
    requestedChanges?: TrackedChange[],
  ) => {
    // Resolved in the body rather than as a default parameter: the React
    // Compiler cannot reorder member expressions in default-value position.
    const changes = requestedChanges ?? overleafChangesRef.current;
    if (currentEditor.isDestroyed || (!changes.length && !trackChangesWereActive.current)) return;
    currentEditor.view.dispatch(currentEditor.state.tr.setMeta(visualTrackChangesKey, {
      text: markdown,
      sourcePath: activePathRef.current,
      changes,
    } satisfies VisualTrackChangesMeta));
  }, []);
  const flushPendingLocalUpdate = useCallback(() => {
    // WebKit can deliver the final composition transaction during blur. Do
    // not hand document ownership to another path until compositionend has
    // made that transaction publishable by the current editor.
    if (conflictDraftRef.current != null || composing.current) return false;
    if (localUpdateTimer.current) clearTimeout(localUpdateTimer.current);
    if (localUpdateMaxTimer.current) clearTimeout(localUpdateMaxTimer.current);
    localUpdateTimer.current = null;
    localUpdateMaxTimer.current = null;
    const pending = pendingLocalUpdate.current;
    pendingLocalUpdate.current = null;
    if (!pending || pending.editor.isDestroyed) return true;
    const { editor: updatedEditor, explicitReplacement, changedBlocks, viewportAnchor } = pending;
    // Initialization and canonical-reconciliation transactions are not user
    // edits. In particular, never let opening a source-only paper normalize
    // and silently overwrite syntax that the visual editor cannot preserve.
    if (!explicitReplacement && (
      eligibilityText.current !== acceptedMarkdown.current
      || eligibilityRepresentedExactly.current !== true
    )) return true;
    const expected = acceptedMarkdown.current;
    const next = preserveMarkdownEnvelope(
      serializeMarkdown(updatedEditor, expected, changedBlocks, activePathRef.current),
      expected,
    );
    if (next === expected) return true;
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
      return true;
    }
    conflictDraftRef.current = next;
    setConflictDraft(next);
    return false;
  }, [refreshVisualPresence, reportVisualCaret]);
  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(flushPendingLocalUpdate);
    return () => onFlushPendingChange(null);
  }, [flushPendingLocalUpdate, onFlushPendingChange]);
  // `useEditor` only consumes `content` while creating the editor, but its
  // options object is evaluated on every React render. Parsing here lazily
  // avoids reparsing an entire Markdown document when editor chrome mounts or
  // local status changes; later source updates are reconciled below.
  const [initialContent] = useState(() => cachedVisualContent(activePath, text));
  const getActivePath = useCallback(() => activePathRef.current, []);
  const getWorkspaceIndex = useCallback(() => indexRef.current ?? null, []);
  const getPapers = useCallback(() => papersRef.current ?? [], []);
  const slashSources = useMemo(
    () => slashItemSources(onImportAsset, getActivePath),
    [getActivePath, onImportAsset],
  );
  const imageExtension = useMemo(() => ImageSrcFidelity.extend({
    addNodeView() {
      return ReactNodeViewRenderer(ProjectInlineImageView);
    },
  }).configure({ inline: true }), []);

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
    () => visualWikiLinkSuggestion(getWorkspaceIndex),
    [getWorkspaceIndex],
  );

  const paperCitationSuggestion = useMemo(
    () => visualPaperCitationSuggestion({
      getPapers,
      getActivePath,
    }),
    [getActivePath, getPapers],
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
    // The matching Markdown eligibility effect is the sole initial owner of
    // editability. Starting writable leaves a gap where onUpdate correctly
    // ignores initialization but a queued user key would be lost with it.
    editable: false,
    extensions: [
      ...visualEditorExtensions(imageExtension),
      SourceDirtyObserver,
      // Keep WebKit's native caret. The old fixed-height overlay listened to
      // every ancestor scroll and forced coordsAtPos/layout work per frame.
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
      ...(optimizeForReading ? [ChunkWrapperDecoration, GeneratedPaperContents] : []),
      ...(optimizeForReading ? [] : [TableInsertControls, LatticeFrozenTableHeaders]),
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
        if (!anchor) return false;
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
      if (localUpdateMaxTimer.current === null) {
        localUpdateMaxTimer.current = setTimeout(flushPendingLocalUpdate, policy.publicationMaxMs);
      }
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      const selection = currentEditor.state.selection;
      selectionMarkdownRef.current?.(
        selection.empty ? "" : serializeWysiwygSelection(currentEditor),
      );
      scheduleVisualCaretReport(currentEditor);
    },
    onFocus: ({ editor: currentEditor }) => {
      scheduleVisualCaretReport(currentEditor);
    },
  // Recreate only when reading-mode chrome changes. File switches reuse this
  // instance via the path-swap layout effect below — remounting TipTap is what
  // made .md navigation feel slow.
  }, [optimizeForReading]);
  const initialHandoffRef = useRef(initialHandoff);
  useLayoutEffect(() => {
    const requested = initialHandoffRef.current;
    if (!editor || editor.isDestroyed || !requested) return;
    initialHandoffRef.current = undefined;
    queueMicrotask(() => onConsumeInitialHandoff?.());
    if (requested.fragment) {
      openMarkdownLink(activePath, requested.fragment, onOpenProjectPath, editor.view.dom);
      if (requested.navigationOnly) return;
    }
    const position = proseMirrorPositionForSourceOffset(
      editor.state.doc,
      text,
      requested.sourceOffset,
      activePath,
    );
    if (position == null) return;
    if (requested.blockTop != null) {
      const resolved = editor.state.doc.resolve(position);
      const topLevelPosition = resolved.depth > 0 ? resolved.before(1) : position;
      const block = editor.view.nodeDOM(topLevelPosition);
      const scroller = editor.view.dom.closest<HTMLElement>(".editor-doc-scroll");
      if (block instanceof HTMLElement && scroller) {
        scroller.scrollTop += block.getBoundingClientRect().top - requested.blockTop;
      }
    }
    const pointerPosition = requested.clientX != null && requested.clientY != null
      ? editor.view.posAtCoords({ left: requested.clientX, top: requested.clientY })?.pos
      : undefined;
    const selection = TextSelection.near(editor.state.doc.resolve(pointerPosition ?? position), 1);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.commands.focus();
    if (requested.command === "selectAll") {
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      return;
    }
    if (requested.command === "find") {
      queueMicrotask(() => window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
      })));
      return;
    }
    if (requested.pointerId == null) return;
    const anchor = selection.head;
    const extendSelection = (event: PointerEvent) => {
      if (event.pointerId !== requested.pointerId) return;
      const head = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      if (head == null) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)));
    };
    const finishSelection = (event: PointerEvent) => {
      if (event.pointerId !== requested.pointerId) return;
      window.removeEventListener("pointermove", extendSelection, true);
      window.removeEventListener("pointerup", finishSelection, true);
      window.removeEventListener("pointercancel", finishSelection, true);
    };
    window.addEventListener("pointermove", extendSelection, true);
    window.addEventListener("pointerup", finishSelection, true);
    window.addEventListener("pointercancel", finishSelection, true);
    return () => {
      window.removeEventListener("pointermove", extendSelection, true);
      window.removeEventListener("pointerup", finishSelection, true);
      window.removeEventListener("pointercancel", finishSelection, true);
    };
  }, [activePath, editor, onConsumeInitialHandoff, onOpenProjectPath, text]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const wired = new WeakSet<HTMLAnchorElement>();
    const wireLinks = () => {
      editor.view.dom.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        if (wired.has(anchor)) return;
        wired.add(anchor);
        anchor.addEventListener("click", (event) => {
          const href = anchor.getAttribute("href");
          if (!href) return;
          event.preventDefault();
          event.stopPropagation();
          openMarkdownLink(activePathRef.current, href, openPathRef.current, editor.view.dom);
        });
      });
    };
    wireLinks();
    // Every transaction mutates the subtree, and each pass queries every
    // anchor in the document. Batch bursts of mutations into one pass; a
    // fresh link becoming clickable a beat late is imperceptible.
    let wireTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (wireTimer !== null) return;
      wireTimer = setTimeout(() => {
        wireTimer = null;
        wireLinks();
      }, 200);
    });
    observer.observe(editor.view.dom, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (wireTimer) clearTimeout(wireTimer);
    };
  }, [editor]);
  const reconcileCanonical = useCallback((canonical: string) => {
    if (!editor || editor.isDestroyed || canonical === acceptedMarkdown.current) return;
    const base = acceptedMarkdown.current;
    const draft = conflictDraftRef.current
      ?? preserveMarkdownEnvelope(
        serializeMarkdown(editor, base, undefined, activePathRef.current),
        base,
      );
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
    if (!editor) return;
    const canEdit = editable && editorReadyForChanges.current;
    if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
  }, [editable, editor]);

  // Flush edits against the old publisher before the passive ref refresh. The
  // actual ProseMirror replacement is scheduled as a task below: TipTap's
  // ReactNodeViewRenderer uses flushSync while constructing NodeViews, which
  // React explicitly forbids from inside a lifecycle method.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activePathRef.current === activePath) return;

    flushPendingLocalUpdate();
    // The App owner has already accepted the final old-path flush before it
    // commits a new activePath. Ignore any blur/NodeView bookkeeping emitted
    // while this old DOM is disabled and waiting for the painted handoff;
    // letting it repopulate pendingLocalUpdate would attach obsolete work to
    // the incoming document generation.
    editorReadyForChanges.current = false;
    editor.commands.blur();
    editor.setEditable(false);
    setHoveredChanges(null);
    setCommentComposer(null);
    setLinkPopoverOpen(false);

    const scroller = sectionRef.current?.closest<HTMLElement>("[data-testid='editor-scroll-container']");
    if (scroller) scroller.scrollTop = 0;
  }, [activePath, editor, flushPendingLocalUpdate]);

  // Swap TipTap content across .md files without tearing down the editor. A
  // A frame followed by a task gives WebKit a real paint opportunity for the
  // lightweight opening state. A zero-delay task alone can run before paint,
  // leaving the old document frozen on screen throughout a long parse.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activePathRef.current === activePath) {
      // A rapid A → B → A navigation can cancel B's scheduled replacement
      // after the layout effect disabled A. Restore the retained document
      // instead of leaving its TipTap surface permanently read-only.
      if (
        renderedPath === activePath
        && acceptedMarkdown.current === text
        && eligibilityText.current === text
      ) {
        editorReadyForChanges.current = true;
        const canEdit = editable && eligibilityRepresentedExactly.current === true;
        if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
      }
      return;
    }
    let timer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (editor.isDestroyed) return;

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
        const handoffStartedAt = performance.now();
        setMarkdownWithoutHistory(editor, text, activePath);
        const handoffEndedAt = performance.now();
        const handoffMs = handoffEndedAt - handoffStartedAt;
        try {
          performance.measure("lattice:visual-markdown-handoff", {
            start: handoffStartedAt,
            end: handoffEndedAt,
            detail: { path: activePath },
          });
        } catch {
          // Older WebKit builds do not support PerformanceMeasureOptions.detail.
        }
        if (handoffMs >= 50) {
          addAppLog({
            level: "info",
            source: "Navigation performance",
            title: "Visual Markdown handoff",
            detail: `${activePath}\nsetContentMs=${handoffMs.toFixed(1)}`,
            toast: false,
          });
        }
        // Fresh history so Undo cannot walk back into the previous file.
        editor.view.updateState(EditorState.create({
          doc: editor.state.doc,
          plugins: editor.state.plugins,
        }));
        // Eligibility still belongs to the outgoing document. Keep the new
        // tree inert until its round-trip check installs the matching owner;
        // otherwise a queued key can mutate ProseMirror while onUpdate is
        // intentionally ignoring initialization transactions.
        editor.setEditable(false);
        setRenderedPath(activePath);
      }, 0);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activePath, editable, editor, renderedPath, text]);

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
    if (renderedPath !== activePath || activePathRef.current !== activePath) return;
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
          undefined,
          activePath,
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
  }, [activePath, editable, editor, optimizeForReading, renderedPath, text]);

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
      sourcePath: activePath,
      cursors: presenceCursors,
    } satisfies VisualPresenceMeta));
  }, [activePath, editor, editorViewMounted, presenceCursors, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    if (text !== acceptedMarkdown.current) return;
    if (!overleafChanges.length && !trackChangesWereActive.current) return;
    trackChangesWereActive.current = overleafChanges.length > 0;
    editor.view.dispatch(editor.state.tr.setMeta(visualTrackChangesKey, {
      text,
      sourcePath: activePath,
      changes: overleafChanges,
    } satisfies VisualTrackChangesMeta));
  }, [activePath, editor, editorViewMounted, overleafChanges, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    // Anchors are resolved against the source this document was parsed from;
    // repainting while they disagree would place highlights by stale offsets.
    if (text !== acceptedMarkdown.current) return;
    if (!editorComments.length && !commentsWereActive.current) return;
    commentsWereActive.current = editorComments.length > 0;
    editor.view.dispatch(editor.state.tr.setMeta(visualCommentsKey, {
      text,
      sourcePath: activePath,
      comments: editorComments,
      activeId: activeEditorCommentId,
      labelForAuthor: (authorName) => {
        const author = editorCommentAuthorDisplayName(authorName, anonymousAuthor);
        return t({ message: `Comment by ${author}` });
      },
    } satisfies VisualCommentsMeta));
  }, [activeEditorCommentId, activePath, anonymousAuthor, editor, editorComments, editorViewMounted, i18n.locale, t, text]);

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
      // Non-null local so the pause callback below keeps TS's narrowing.
      const ranges = sourceRanges;
      // Source labels are synchronization metadata, not editable document
      // attributes. Keep ProseMirror's DOM observer from reparsing the whole
      // document when these data attributes change; reparsing destroys every
      // React NodeView and visibly reloads images, Mermaid, and HTML previews.
      withPausedDomObserver(editor.view, () => {
        let previousOffset = 0;
        let sourceLine = 1;
        for (const [index, element] of renderedBlocks.entries()) {
          if (!(element instanceof HTMLElement)) continue;
          const range = ranges[index];
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
      });
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
    if (!flushPendingLocalUpdate()) return;
    const selection = selectedEditor.state.selection;
    const blockIndex = selection.$from.index(0);
    const renderedBlock = selectedEditor.view.dom.children[blockIndex];
    let viewportY: number | undefined;
    let blockViewportY: number | undefined;
    try {
      const selectionCoords = selectedEditor.view.coordsAtPos(selection.from);
      const selectionCenter = (selectionCoords.top + selectionCoords.bottom) / 2;
      if (Number.isFinite(selectionCenter)) viewportY = selectionCenter;
    } catch {
      // The DOM selection can briefly be unavailable while a NodeView updates.
      // Source navigation still works; it falls back to centering the target.
    }
    const viewport = selectedEditor.view.dom.closest<HTMLElement>(".editor-doc-scroll");
    if (renderedBlock instanceof HTMLElement && viewport) {
      const offset = renderedBlock.getBoundingClientRect().top
        - viewport.getBoundingClientRect().top;
      if (Number.isFinite(offset)) blockViewportY = offset;
    }
    const blockSourceOffset = renderedBlock instanceof HTMLElement
      ? Number(renderedBlock.dataset.sourceOffset)
      : Number.NaN;
    const mapped = sourceOffsetForProseMirrorPosition(
      selectedEditor,
      selection.from,
      acceptedMarkdown.current,
    );
    const sourceOffset = mapped?.markdown === acceptedMarkdown.current
      ? mapped.offset
      : Number.isFinite(blockSourceOffset)
        ? blockSourceOffset
        : visualSourceRanges(
            acceptedMarkdown.current,
            selectedEditor.state.doc.childCount,
          )[blockIndex]?.from ?? 0;
    onViewInSource(
      sourceOffset,
      viewportY,
      blockViewportY,
    );
  }, [flushPendingLocalUpdate, onViewInSource]);

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
        error: t`The selected text changed. Select it again before commenting.`,
      } : current);
      return;
    }
    onCreateComment(range.from, range.to, commentComposer.body.trim());
    setCommentComposer(null);
    editor.commands.focus();
  };

  const documentPending = renderedPath !== activePath;
  return (
    <section
      ref={attachSectionRef}
      className={`visual-markdown-editor${optimizeForReading ? " optimize-for-reading" : ""}${documentPending ? " is-document-pending" : ""}`}
      data-active-path={activePath}
      aria-busy={documentPending}
      aria-label={t`Visual Markdown editor`}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.closest(".ok-drag-grip")) return;
        const selection = editor.state.selection;
        if (selection.empty) return;
        // Re-selecting the same block does not emit a ProseMirror selection
        // update, so publish it again after the host surface clears its context.
        selectionMarkdownRef.current?.(serializeWysiwygSelection(editor));
      }}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href");
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        openMarkdownLink(activePath, href, openPathRef.current, sectionRef.current ?? undefined);
      }}
    >
      <DocumentHeadingRail
        items={documentPending ? [] : headingItems}
        onSelect={(item) => openMarkdownLink(
          activePath,
          `#${encodeURIComponent(item.id)}`,
          openPathRef.current,
          sectionRef.current ?? undefined,
        )}
      />
      {documentPending && (
        // App already announces the complete file-opening operation. Keep the
        // same centered activity cue while TipTap finishes its handoff, but do
        // not present it as a second status or repeat “Opening document”.
        <div className="visual-markdown-loading" aria-hidden="true">
          <InfinityLoader size={16} />
        </div>
      )}
      {!documentPending && <VisualMarkdownFindReplace
        key={activePath}
        editor={editor}
        editable={editable && !eligibilityReason}
        editorRoot={sectionRef}
      />}
      {!documentPending && commentComposer && (
        <div
          className="visual-comment-composer"
          role="dialog"
          aria-label={t`Add comment`}
          style={{ left: commentComposer.left, top: commentComposer.top }}
        >
          <p className="editor-comment-quote">{commentComposer.quote}</p>
          <textarea
            autoFocus
            rows={3}
            aria-label={t`Comment`}
            placeholder={t`Leave a comment for collaborators…`}
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
            }}>{t`Cancel`}</button>
            <button
              type="button"
              className="primary"
              disabled={!commentComposer.body.trim()}
              onClick={submitVisualComment}
            >{t`Add comment`}</button>
          </div>
        </div>
      )}
      {!documentPending && hoveredChanges && activeHoveredChanges.length > 0 && overleafTrackChangeActions && (
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
      {!documentPending && eligibilityReason && (
        <InlineMessage level="warning" className="visual-markdown-eligibility">
          {eligibilityReason}
          {onEditSource && <button type="button" onClick={onEditSource}>Edit Markdown source</button>}
        </InlineMessage>
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
        activePath={renderedPath}
        onLoadAsset={onLoadAsset}
        workspaceIndex={workspaceIndex}
        viewInSource={viewInSource}
        editorViewMounted={editorViewMounted}
        openVisualCommentComposer={onCreateComment ? openVisualCommentComposer : null}
        bubbleMenuHidden={documentPending || linkPopoverOpen || Boolean(commentComposer)}
        editable={editable && !documentPending}
        onLinkPopoverOpenChange={setLinkPopoverOpen}
      />
    </section>
  );
}

/**
 * Large documents begin in a bounded, passive block viewport. The first
 * editing or native-selection gesture hands off once to the complete editor,
 * which remains the only writable surface until block-scoped editing owns all
 * cross-block commands. Uncertain source ownership always keeps the complete
 * editor.
 */
export function VisualMarkdownEditor(props: VisualMarkdownEditorProps): JSX.Element {
  // Publish before either passive chunks or the complete editor can construct
  // eager math NodeViews. The existing renderer seam is process-global.
  setHostKatexMacros(props.macros ?? EMPTY_MACROS);
  const [completeSession, setCompleteSession] = useState<{
    path: string;
    handoff: PassiveEditorHandoff | null;
  } | null>(null);
  const hasDocumentOverlays = (props.presenceCursors?.length ?? 0) > 0
    || (props.overleafChanges?.length ?? 0) > 0
    || (props.editorComments?.some((comment) => !comment.resolved) ?? false);
  // An editable document must keep one scroll geometry from opening through
  // the first click. Switching from estimated passive chunks to the complete
  // TipTap tree on pointer-down changes the scroll height (and therefore the
  // scrollbar thumb) before the clicked block can be anchored reliably.
  const mayUsePassiveViewport = props.editable === false
    && props.text.length >= VIRTUAL_BLOCK_MODEL_SOURCE_THRESHOLD
    && completeSession?.path !== props.activePath
    && !hasDocumentOverlays;
  const model = useMemo(
    () => mayUsePassiveViewport ? buildVisualMarkdownBlockModel(props.text, props.activePath) : null,
    [mayUsePassiveViewport, props.activePath, props.text],
  );
  const usePassiveViewport = model !== null
    && (
      props.text.length >= LARGE_MARKDOWN_PREVIEW_THRESHOLD
      || model.blocks.length >= VIRTUAL_BLOCK_COUNT_THRESHOLD
    );
  const consumeInitialHandoff = useCallback(() => {
    setCompleteSession((current) => current ? { ...current, handoff: null } : current);
  }, []);

  if (usePassiveViewport) {
    return (
      <PassiveVisualMarkdownViewport
        key={`${props.activePath}:${model.id}`}
        model={model}
        activePath={props.activePath}
        optimizeForReading={Boolean(props.optimizeForReading)}
        onLoadAsset={props.onLoadAsset}
        onOpenProjectPath={props.onOpenProjectPath}
        workspaceIndex={props.workspaceIndex}
        onActivate={(handoff) => setCompleteSession({
          path: props.activePath,
          handoff: {
            ...handoff,
            sourceOffset: handoff.sourceOffset + model.sourceOffsetBase,
          },
        })}
      />
    );
  }
  return (
    <CompleteVisualMarkdownEditor
      {...props}
      initialHandoff={completeSession?.path === props.activePath
        ? completeSession.handoff ?? undefined
        : undefined}
      onConsumeInitialHandoff={consumeInitialHandoff}
    />
  );
}
