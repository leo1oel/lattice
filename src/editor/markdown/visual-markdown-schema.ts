/*
 * Assembles the visual Markdown editor's schema from the vendored Open
 * Knowledge core (src/open-knowledge-core, inkeep/open-knowledge at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e, GPL-3.0-or-later).
 *
 * The editor's extensions and the MarkdownManager MUST share the exact same
 * schema. `visualEditorExtensions` therefore only attaches NodeViews (and
 * UI-only options such as KaTeX macros) onto the upstream extensions —
 * never new nodes, marks, or attrs.
 */
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockFidelity as AppCodeBlock } from "@ok-app/editor/extensions/code-block";
import { MathInline as AppMathInline } from "@ok-app/editor/extensions/math-inline";
import { JsxComponentView } from "@ok-app/editor/extensions/JsxComponentView";
import { JsxComponent } from "../../open-knowledge-core/extensions/jsx-component.ts";
import { RawMdxFallback } from "../../open-knowledge-core/extensions/raw-mdx-fallback.ts";
import { emptyMarkdownAnchorId } from "../../open-knowledge-core/extensions/html-block-fidelity.ts";
import { sharedExtensions } from "../../open-knowledge-core/extensions/shared.ts";
import {
  normalizeTableSpanLayout,
  type TableSpanLayout,
} from "../../open-knowledge-core/extensions/table-fidelity.ts";
import { MarkdownManager } from "../../open-knowledge-core/markdown/index.ts";
import { RawMdxFallbackView } from "@ok-app/editor/extensions/RawMdxFallbackCMView";

let manager: MarkdownManager | undefined;

/** Singleton parser/serializer sharing the editor schema (upstream pattern). */
export function getMarkdownManager(): MarkdownManager {
  manager ||= new MarkdownManager({ extensions: sharedExtensions });
  return manager;
}

/** Legacy Research Writer `rw-component <kind>` fence kinds → registry components. */
const LEGACY_COMPONENT_KINDS: Record<string, string> = {
  callout: "Callout",
};

/**
 * Upgrade a legacy ` ```rw-component callout `-fenced block into a pristine
 * `jsxComponent`. `sourceRaw` keeps the exact fence bytes, so untouched
 * documents serialize unchanged; the first visual edit flips `sourceDirty`
 * and migrates the block to canonical MDX.
 */
function upgradeLegacyComponentFence(node: JSONContent): JSONContent {
  if (node.type !== "codeBlock" || String(node.attrs?.language ?? "") !== "rw-component") return node;
  const componentName = LEGACY_COMPONENT_KINDS[String(node.attrs?.meta ?? "").trim().toLowerCase()];
  if (!componentName) return node;
  let data: unknown;
  try {
    data = JSON.parse((node.content ?? []).map((child) => child.text ?? "").join(""));
  } catch {
    return node;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return node;
  const { content: body, ...props } = data as Record<string, unknown>;
  return {
    type: "jsxComponent",
    attrs: {
      componentName,
      kind: "element",
      attributes: [],
      sourceRaw: getMarkdownManager().serialize({ type: "doc", content: [node] }).replace(/\n$/, ""),
      sourceDirty: false,
      props,
    },
    content: [{
      type: "paragraph",
      content: typeof body === "string" && body ? [{ type: "text", text: body }] : [],
    }],
  };
}

function prepareVisualNode(node: JSONContent): JSONContent {
  const upgraded = upgradeLegacyComponentFence(node);
  const anchorSource = upgraded.type === "paragraph"
    && upgraded.content?.length === 1
    && upgraded.content[0]?.type === "text"
    ? upgraded.content[0].text
    : null;
  if (emptyMarkdownAnchorId(anchorSource)) {
    // CommonMark parses a standalone empty <a> as inline HTML inside a
    // paragraph. Promote converter anchors to the existing lossless HTML atom
    // so visual mode can hide the source tag while retaining its fragment id.
    return { type: "htmlBlock", attrs: { content: anchorSource } };
  }
  const content = upgraded.content?.map(prepareVisualNode);
  if (
    upgraded.type === "jsxComponent"
    && upgraded.attrs?.componentName === "Callout"
    && !content?.length
  ) {
    // The Markdown parser represents an empty `<Callout>\n\n</Callout>`
    // with zero children. That leaves ProseMirror without a valid text
    // position; macOS IME can paint composition text into the DOM, then Enter
    // NodeSelects the empty component and it appears to collapse to its halo.
    // A real empty paragraph preserves the same Markdown while giving IME and
    // Enter a stable editable content hole.
    return { ...upgraded, content: [{ type: "paragraph" }] };
  }
  return content ? { ...upgraded, content } : upgraded;
}

function isExtractedPaperMarkdown(sourcePath?: string): boolean {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  return /(?:^|\/)\.research\/papers\/.+\/paper\.md$/i.test(normalized);
}

function visualNodeText(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(visualNodeText).join("");
}

/**
 * arxiv2md expands HTML rowspan/colspan cells by repeating their content in a
 * rectangular GFM table. Collapse only exact, label-like runs: numeric results
 * remain separate, and ordinary project Markdown never enters this heuristic.
 */
function repeatedPaperCellKey(cell: JSONContent): string | null {
  const text = visualNodeText(cell).trim();
  if (!/\p{L}/u.test(text)) return null;
  return JSON.stringify([
    cell.attrs?.align ?? null,
    cell.attrs?.sourcePadding ?? null,
    cell.content ?? [],
  ]);
}

function isNumericResultCell(cell: JSONContent): boolean {
  const text = visualNodeText(cell).trim();
  return /\d/.test(text) && !/\p{L}/u.test(text);
}

function visualTableCellIsEmpty(cell: JSONContent): boolean {
  return (cell.content ?? []).every((block) => !(block.content?.length ?? 0));
}

function applyExplicitTableSpanLayout(table: JSONContent, layout: TableSpanLayout): JSONContent {
  if (layout.length === 0) return table;
  const rows = table.content ?? [];
  const matrix = rows.map((row) => row.content ?? []);
  const width = matrix[0]?.length ?? 0;
  if (
    width === 0
    || matrix.some((row) => row.length !== width)
    || matrix.some((row) => row.some((cell) => (
      cell.type !== "tableCell" && cell.type !== "tableHeader"
    )))
  ) return table;

  const occupied = matrix.map(() => Array.from({ length: width }, () => false));
  const covered = matrix.map(() => Array.from({ length: width }, () => false));
  const origins = new Map<string, { rowspan: number; colspan: number }>();
  for (const [row, column, rowspan, colspan] of layout) {
    if (row + rowspan > matrix.length || column + colspan > width) return table;
    const origin = matrix[row]?.[column];
    if (!origin) return table;
    const originContent = JSON.stringify(origin.content ?? []);
    for (let coveredRow = row; coveredRow < row + rowspan; coveredRow++) {
      for (let coveredColumn = column; coveredColumn < column + colspan; coveredColumn++) {
        if (occupied[coveredRow]?.[coveredColumn]) return table;
        const cell = matrix[coveredRow]?.[coveredColumn];
        if (!cell) return table;
        if (
          JSON.stringify(cell.content ?? []) !== originContent
          && !visualTableCellIsEmpty(cell)
        ) return table;
        occupied[coveredRow]![coveredColumn] = true;
        if (coveredRow !== row || coveredColumn !== column) {
          covered[coveredRow]![coveredColumn] = true;
        }
      }
    }
    origins.set(`${row}:${column}`, { rowspan, colspan });
  }

  return {
    ...table,
    content: rows.map((rowNode, row) => ({
      ...rowNode,
      content: matrix[row]!.flatMap((cell, column) => {
        if (covered[row]?.[column]) return [];
        const span = origins.get(`${row}:${column}`);
        return [{
          ...cell,
          ...(span ? { attrs: { ...cell.attrs, ...span } } : {}),
        }];
      }),
    })),
  };
}

function collapseRepeatedPaperTableCells(table: JSONContent): JSONContent {
  const rows = table.content ?? [];
  if (
    rows.length === 0
    || rows.some((row) => row.type !== "tableRow" || !row.content?.length)
  ) return table;
  const matrix = rows.map((row) => row.content ?? []);
  const width = matrix[0]?.length ?? 0;
  if (
    width === 0
    || matrix.some((row) => row.length !== width)
    || matrix.some((row) => row.some((cell) => (
      cell.type !== "tableCell" && cell.type !== "tableHeader"
    )))
  ) return table;

  const mergeKeys = matrix.map((row) => row.map(repeatedPaperCellKey));
  const rowContentKeys = matrix.map((row) => JSON.stringify(
    row.map((cell) => cell.content ?? []),
  ));
  const firstDataRow = matrix.findIndex((row, rowIndex) => {
    if (rowIndex === 0) return false;
    const firstNumericColumn = row.findIndex(isNumericResultCell);
    return firstNumericColumn >= 0 && row
      .slice(firstNumericColumn)
      .filter(isNumericResultCell)
      .length >= Math.ceil((row.length - firstNumericColumn) / 2);
  });
  // arxiv2md always uses the first GFM row as a header. Additional rows before
  // the first predominantly numeric row are the multi-level header band.
  const headerRowCount = firstDataRow < 0 ? 1 : Math.max(1, firstDataRow);
  const stubColumnCount = firstDataRow < 0
    ? 0
    : matrix[firstDataRow]!.findIndex(isNumericResultCell);
  const covered = matrix.map(() => Array.from({ length: width }, () => false));
  const collapsedRows: JSONContent[] = [];
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const collapsedCells: JSONContent[] = [];
    for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
      if (covered[rowIndex]?.[columnIndex]) continue;
      const cell = matrix[rowIndex]?.[columnIndex];
      if (!cell) continue;
      const key = mergeKeys[rowIndex]?.[columnIndex];
      let colspan = 1;
      let ambiguousIntersection = false;
      while (
        key
        && rowIndex < headerRowCount
        && columnIndex + colspan < width
        && !covered[rowIndex]?.[columnIndex + colspan]
        && mergeKeys[rowIndex]?.[columnIndex + colspan] === key
      ) colspan += 1;
      if (colspan > 1) {
        const below = mergeKeys[rowIndex + 1]?.slice(columnIndex, columnIndex + colspan);
        const matchingBelow = below?.filter((belowKey) => belowKey === key).length ?? 0;
        const distinctBelow = new Set(
          matrix[rowIndex + 1]
            ?.slice(columnIndex, columnIndex + colspan)
            .map((belowCell) => JSON.stringify(belowCell.content ?? [])),
        ).size;
        const completeRectangle = matchingBelow === colspan
          && columnIndex + colspan <= stubColumnCount;
        const groupedSubheaders = rowIndex + 1 < headerRowCount
          && matchingBelow === 0
          && distinctBelow > 1;
        ambiguousIntersection = matchingBelow > 0 && matchingBelow < colspan;
        if (!completeRectangle && !groupedSubheaders) colspan = 1;
      }

      let rowspan = 1;
      const verticalLabelColumn = !ambiguousIntersection && stubColumnCount > 0 && (
        (rowIndex < headerRowCount && columnIndex < stubColumnCount)
        || (rowIndex >= headerRowCount && columnIndex === 0 && stubColumnCount >= 2)
      );
      while (
        key
        && verticalLabelColumn
        && columnIndex + colspan <= Math.max(1, stubColumnCount)
        && rowIndex + rowspan < matrix.length
        // Identical data rows can be intentional duplicates. Refuse to infer
        // that every matching label in one is a rowspan from the other.
        && rowContentKeys[rowIndex + rowspan - 1] !== rowContentKeys[rowIndex + rowspan]
        // A repeated first-column body label only denotes a hierarchy when a
        // subordinate stub changes at the same boundary. With one stub column
        // (or identical subordinate labels) the rows are independent records.
        && (
          rowIndex < headerRowCount
          || Array.from({ length: stubColumnCount - 1 }, (_, offset) => offset + 1).some(
            (column) => {
              const previous = mergeKeys[rowIndex + rowspan - 1]?.[column];
              const next = mergeKeys[rowIndex + rowspan]?.[column];
              return Boolean(previous && next && previous !== next);
            },
          )
        )
        && Array.from({ length: colspan }, (_, offset) => columnIndex + offset).every(
          (column) => (
            !covered[rowIndex + rowspan]?.[column]
            && mergeKeys[rowIndex + rowspan]?.[column] === key
          ),
        )
      ) rowspan += 1;

      if (colspan > 1 || rowspan > 1) {
        for (let coveredRow = rowIndex; coveredRow < rowIndex + rowspan; coveredRow += 1) {
          for (
            let coveredColumn = columnIndex;
            coveredColumn < columnIndex + colspan;
            coveredColumn += 1
          ) {
            if (coveredRow !== rowIndex || coveredColumn !== columnIndex) {
              covered[coveredRow]![coveredColumn] = true;
            }
          }
        }
        collapsedCells.push({
          ...cell,
          attrs: { ...cell.attrs, colspan, rowspan },
        });
      } else {
        collapsedCells.push(cell);
      }
    }
    collapsedRows.push({ ...rows[rowIndex], content: collapsedCells });
  }
  return { ...table, content: collapsedRows };
}

function prepareTableSpanLayouts(node: JSONContent, inferPaperSpans: boolean): JSONContent {
  const content = node.content?.map((child) => prepareTableSpanLayouts(child, inferPaperSpans));
  const prepared = content ? { ...node, content } : node;
  if (prepared.type !== "table") return prepared;
  const explicitLayoutValue = prepared.attrs?.sourceSpanLayout;
  if (explicitLayoutValue !== null && explicitLayoutValue !== undefined) {
    const explicitLayout = normalizeTableSpanLayout(explicitLayoutValue);
    return explicitLayout === null ? prepared : applyExplicitTableSpanLayout(prepared, explicitLayout);
  }
  return inferPaperSpans ? collapseRepeatedPaperTableCells(prepared) : prepared;
}

/** Parse canonical Markdown for the visual editor (upstream parse + legacy fence upgrade). */
export function parseVisualMarkdown(markdown: string, sourcePath?: string): JSONContent {
  // A leading BOM is file envelope, not content: parsing it as text would make
  // serialize + preserveMarkdownEnvelope emit a doubled BOM and a spurious
  // write-back on mount. The envelope helper restores it from the canonical text.
  const doc = getMarkdownManager().parseWithFallback(
    markdown.replace(/^\uFEFF/, ""),
    sourcePath ? { sourcePath } : undefined,
  );
  const content = doc.content?.map(prepareVisualNode);
  const prepared = content ? { ...doc, content } : doc;
  return prepareTableSpanLayouts(prepared, isExtractedPaperMarkdown(sourcePath));
}

export function visualEditorExtensions(imageExtension?: AnyExtension): AnyExtension[] {
  const replacements: Record<string, AnyExtension> = {
    // Upstream app code block: same core schema (no attr changes), plus the
    // upstream NodeView (language dropdown, copy, preview), lowlight
    // decorations, tab indentation, and the bare-fence input rule.
    codeBlock: AppCodeBlock,
    // Upstream app jsxComponent NodeView: full component pack (Callout,
    // Accordion, Tabs, media, Math, Mermaid, …) + PropPanel editing chrome.
    // Host KaTeX macros reach its Math renderer through the same
    // @ok-app/shims/katex-macros seam as inline math; `options.macros` is
    // no longer plumbed through extension options.
    jsxComponent: JsxComponent.extend({
      addNodeView: () => ReactNodeViewRenderer(JsxComponentView),
    }),
    // Upstream app inline math: same core schema, plus the upstream KaTeX
    // NodeView (click → PropPanel popover). Host KaTeX macros reach the
    // renderer through the @ok-app/shims/katex-macros seam, published by
    // VisualMarkdownEditor — not through extension options.
    mathInline: AppMathInline,
    ...(imageExtension ? { image: imageExtension } : {}),
    rawMdxFallback: RawMdxFallback.extend({
      addNodeView: () => ReactNodeViewRenderer(RawMdxFallbackView),
    }),
    // footnoteDefinition intentionally has NO NodeView override: the core
    // extension's renderHTML already emits the upstream UI — the
    // auto-numbered `.footnote-def` aside with `id="fn-{id}"` (the anchor
    // FootnoteAnchorScroll jumps to) and the `.footnote-backref` ↩ arrow.
  };
  return sharedExtensions.map((extension): AnyExtension => replacements[extension.name] ?? extension);
}
