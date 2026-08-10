import {
  type FromProseMirrorOptions,
  fromProseMirror,
  type RemarkProseMirrorOptions,
  remarkProseMirror,
} from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import type { Root as MdastRoot } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkGithubAlerts from 'remark-github-alerts';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { type Processor, unified } from 'unified';
import { VFile } from 'vfile';

import './mdast-augmentation.ts';
import { protectFromMdx, restoreFromMdx } from './autolink-void-html-guard.ts';
import { encodeBackslashEscapes, restoreBackslashEscapesPlugin } from './backslash-escape-guard.ts';
import { calloutTransformerPlugin, REMARK_GITHUB_ALERTS_OPTIONS } from './callout-transformer.ts';
import { commentPromoterPlugin, tableSpanLayoutPromoterPlugin } from './comment-promoter.ts';
import { dedentBlockJsxClose } from './dedent-block-jsx-close.ts';
import { detailsAccordionPromoterPlugin } from './details-accordion-promoter.ts';
import { divAlignPromoterPlugin } from './div-align-promoter.ts';
import { materializeDocEdgeBlankRuns } from './doc-edge-blank-runs.ts';
import { emptyTaskItemUnmintPlugin, mintEmptyTaskItemContent } from './empty-task-item.ts';
import { encodeEntityRefs, restoreEntityRefsPlugin } from './entity-ref-guard.ts';
import { highlightPromoterPlugin } from './highlight-promoter.ts';
import { imagePromoterPlugin } from './image-promoter.ts';
import { indentedCodePromoterPlugin } from './indented-code-promoter.ts';
import { insertInteriorBlankRunParagraphs } from './interior-blank-runs.ts';
import { latexMathPromoterPlugin, swapLatexDisplayMathDelimiters } from './latex-math-promoter.ts';
import { mathPromoterPlugin } from './math-promoter.ts';
import type { CommentBlockMdast, SourceDocBoundary } from './mdast-augmentation.ts';
import {
  normalizeTableSpanLayout,
  serializeTableSpanLayoutMarker,
} from '../extensions/table-fidelity.ts';
import { mergedPostParseWalkerPlugin } from './merged-walker.ts';
import { positionAwareBlankLineJoin } from './position-aware-join.ts';
import { positionSlicePlugin } from './position-slice.ts';
import { remarkMdxAgnostic } from './remark-mdx-agnostic.ts';
import { singleDollarMathPromoterPlugin } from './single-dollar-math-promoter.ts';
import { stripTrailingEdge } from './strip-trailing-edge.ts';
import { underlinePromoterPlugin } from './underline-promoter.ts';
import { voidBrPromoterPlugin } from './void-br-promoter.ts';
import { remarkWikiLink } from './wiki-link-micromark.ts';
import { pruneZeroEmissionBlocks } from './zero-emission-blocks.ts';

interface PipelineOptions {
  schema: Schema;
  handlers: RemarkProseMirrorOptions['handlers'];
  pmNodeHandlers: FromProseMirrorOptions<string, string>['nodeHandlers'];
  pmMarkHandlers: FromProseMirrorOptions<string, string>['markHandlers'];
  toMarkdownHandlers?: Record<string, unknown>;
}

/** Options needed by `serializeMd` for the PM→mdast pre-pass. Kept separate
 * from the (pre-baked) processor so one cached serialize processor can serve
 * calls that share schema/handler registrations. */
interface SerializeMdOptions {
  schema: Schema;
  pmNodeHandlers: FromProseMirrorOptions<string, string>['nodeHandlers'];
  pmMarkHandlers: FromProseMirrorOptions<string, string>['markHandlers'];
}

function ensureNonEmptyDoc(tree: MdastRoot): MdastRoot {
  const renderable = tree.children.some((n) => {
    const type = (n as { type: string }).type;
    return type !== 'yaml' && type !== 'toml';
  });
  if (renderable) return tree;
  return {
    ...tree,
    children: [...tree.children, { type: 'paragraph', children: [] } as never],
  };
}

export const ACTIVE_MDAST_PLUGINS = [
  { name: 'remark-parse', plugin: remarkParse },
  { name: 'remark-frontmatter', plugin: remarkFrontmatter, options: ['yaml', 'toml'] },
  { name: 'remark-mdx-agnostic', plugin: remarkMdxAgnostic },
  { name: 'remark-gfm', plugin: remarkGfm },
  { name: 'remark-math', plugin: remarkMath, options: { singleDollarTextMath: true } },
  { name: 'remark-wiki-link', plugin: remarkWikiLink },
  {
    name: 'remark-github-alerts',
    plugin: remarkGithubAlerts,
    options: REMARK_GITHUB_ALERTS_OPTIONS,
  },
  { name: 'callout-transformer', plugin: calloutTransformerPlugin },
  { name: 'restore-from-mdx', plugin: restoreFromMdx },
  { name: 'void-br-promoter', plugin: voidBrPromoterPlugin },
  { name: 'restore-entity-refs', plugin: restoreEntityRefsPlugin },
  { name: 'restore-backslash-escapes', plugin: restoreBackslashEscapesPlugin },
  { name: 'details-accordion-promoter', plugin: detailsAccordionPromoterPlugin },
  { name: 'div-align-promoter', plugin: divAlignPromoterPlugin },
  { name: 'image-promoter', plugin: imagePromoterPlugin },
  { name: 'indented-code-promoter', plugin: indentedCodePromoterPlugin },
  // Before math-promoter so promoted `\[ … \]` blocks ride the same
  // math → DollarMath conversion as dollar-delimited blocks.
  { name: 'latex-math-promoter', plugin: latexMathPromoterPlugin },
  { name: 'math-promoter', plugin: mathPromoterPlugin },
  { name: 'single-dollar-math-promoter', plugin: singleDollarMathPromoterPlugin },
  { name: 'highlight-promoter', plugin: highlightPromoterPlugin },
  { name: 'underline-promoter', plugin: underlinePromoterPlugin },
  { name: 'comment-promoter', plugin: commentPromoterPlugin },
  { name: 'table-span-layout-promoter', plugin: tableSpanLayoutPromoterPlugin },
  { name: 'merged-post-parse-walker', plugin: mergedPostParseWalkerPlugin },
  // Run once more after the merged walker because that walker can replace or
  // promote nodes while traversing them; final source fidelity belongs to the
  // resulting editor mdast shape.
  { name: 'position-slice', plugin: positionSlicePlugin },
  { name: 'empty-task-item-unmint', plugin: emptyTaskItemUnmintPlugin },
  { name: 'ensure-non-empty-doc', plugin: () => ensureNonEmptyDoc },
] as const;

export function createParseProcessor(opts: PipelineOptions): Processor {
  let processor = unified() as unknown as Processor;
  for (const entry of ACTIVE_MDAST_PLUGINS) {
    const hasOptions = 'options' in entry && entry.options !== undefined;
    processor = (
      hasOptions
        ? // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugin entries can't be narrowed in iteration
          (processor as any).use(entry.plugin, entry.options)
        : // biome-ignore lint/suspicious/noExplicitAny: same
          (processor as any).use(entry.plugin)
    ) as Processor;
  }
  processor = (
    processor as unknown as {
      use(plugin: typeof remarkProseMirror, opts: RemarkProseMirrorOptions): Processor;
    }
  ).use(remarkProseMirror, {
    schema: opts.schema,
    handlers: opts.handlers,
  } as RemarkProseMirrorOptions);
  processor.freeze();
  return processor;
}

export function createSerializeProcessor(
  opts: Pick<PipelineOptions, 'toMarkdownHandlers'>,
): Processor {
  const processor = unified()
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkMdxAgnostic)
    .use(remarkWikiLink)
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      rule: '-',
      join: [positionAwareBlankLineJoin],
      ...(opts.toMarkdownHandlers ? { handlers: opts.toMarkdownHandlers } : {}),
    });
  processor.freeze();
  return processor as unknown as Processor;
}

function splitDocumentHeadBom(source: string): { source: string; hadBom: boolean } {
  return source.charCodeAt(0) === 0xfeff
    ? { source: source.slice(1), hadBom: true }
    : { source, hadBom: false };
}

/**
 * Some arxiv2md versions emit checklist items as a bare ordinal, optionally
 * wrapped in a bullet, then put the item's prose on the next unindented line:
 *
 *   1.
 *   Description
 *
 *   - 1.
 *   Description
 *
 * CommonMark parses the first form as an empty list item followed by a regular
 * paragraph, escaping later ordinals as visible `2\.` text when serialized.
 * It parses the second as two nested list markers. Replace the optional wrapper,
 * an optional escaped delimiter, and the line ending with an equal-length
 * ordered marker and spacing before parsing. Source positions still address
 * the original bytes, while the editor receives the intended ordered list.
 */
function normalizeStandaloneOrderedListContinuations(source: string): string {
  const parts = source.split(/(\r?\n)/);
  let frontmatterFence = /^(---|\+\+\+)[ \t]*$/.exec(parts[0] ?? '')?.[1] ?? null;
  let codeFence: { marker: string; length: number } | null = null;
  let inDisplayMath = false;

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const lineEnding = parts[index + 1] ?? '';
    const trimmed = line.trimStart();
    if (frontmatterFence) {
      if (index > 0 && trimmed === frontmatterFence) frontmatterFence = null;
      continue;
    }

    if (codeFence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (
        closing?.[0] === codeFence.marker
        && closing.length >= codeFence.length
      ) codeFence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) {
      codeFence = { marker: opening[0]!, length: opening.length };
      continue;
    }
    if (trimmed === '$$') {
      inDisplayMath = !inDisplayMath;
      continue;
    }
    if (inDisplayMath) continue;

    const nextLine = parts[index + 2];
    const match = /^([ \t]{0,3})(?:[-+*][ \t]+)?(\d{1,9})\\?([.)])[ \t]*$/.exec(line);
    if (!match || !nextLine || !/^[\p{L}\p{N}]/u.test(nextLine)) continue;
    const marker = `${match[1]}${match[2]}${match[3]}`;
    const spacing = line.length + lineEnding.length - marker.length;
    // CommonMark permits at most four spaces after an ordered marker. The
    // converter emits either LF (three replacement spaces) or CRLF (four);
    // leave hand-authored outliers untouched rather than changing meaning.
    if (spacing < 1 || spacing > 4) continue;
    parts[index] = marker + ' '.repeat(spacing);
    parts[index + 1] = '';
  }
  return parts.join('');
}

const LEADING_BOUNDARY_SHAPE = /^\n+$/;
const TRAILING_BOUNDARY_SHAPE = /^\n{2,}$/;

function isLeadingBoundary(value: string): boolean {
  if (LEADING_BOUNDARY_SHAPE.test(value)) return true;
  const match = value.match(/^(---|\+\+\+)\r?\n[\s\S]*?\r?\n(---|\+\+\+)(\r?\n+)$/);
  return match !== null && match[1] === match[2];
}

function captureDocBoundary(
  root: MdastRoot,
  source: string,
  hadBom: boolean,
): SourceDocBoundary | undefined {
  let leading: string | undefined;
  let trailing: string | undefined;

  const children = root.children.filter((node) => {
    const type = (node as { type: string }).type;
    return type !== 'yaml' && type !== 'toml';
  });
  if (children.length > 0) {
    const firstStart = children[0]?.position?.start?.offset;
    if (typeof firstStart === 'number' && firstStart > 0) {
      const gap = source.slice(0, firstStart);
      if (isLeadingBoundary(gap)) leading = gap;
    }
    const lastEnd = children[children.length - 1]?.position?.end?.offset;
    if (typeof lastEnd === 'number' && lastEnd <= source.length) {
      const gap = source.slice(lastEnd);
      if (TRAILING_BOUNDARY_SHAPE.test(gap)) trailing = gap;
    }
  }

  if (!hadBom && leading === undefined && trailing === undefined) {
    return undefined;
  }
  const boundary: SourceDocBoundary = {
    ...(hadBom ? { bom: true as const } : {}),
    ...(leading !== undefined ? { leading } : {}),
    ...(trailing !== undefined ? { trailing } : {}),
  };
  root.data ??= {};
  root.data.sourceDocBoundary = boundary;
  return boundary;
}

function readDocBoundary(value: unknown): SourceDocBoundary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: { bom?: true; leading?: string; trailing?: string } = {};
  if (v.bom === true) out.bom = true;
  if (typeof v.leading === 'string' && isLeadingBoundary(v.leading)) {
    out.leading = v.leading;
  }
  if (typeof v.trailing === 'string' && TRAILING_BOUNDARY_SHAPE.test(v.trailing)) {
    out.trailing = v.trailing;
  }
  return out.bom || out.leading || out.trailing ? out : undefined;
}

export function parseMd(rawSource: string, processor: Processor): PmNode {
  const { source: rawAfterBom, hadBom } = splitDocumentHeadBom(rawSource);
  const source = dedentBlockJsxClose(rawAfterBom);
  // Length-preserving, so the original-source `file.value` swap below keeps
  // every position honest; see latex-math-promoter.ts for the contract.
  const structuralSource = normalizeStandaloneOrderedListContinuations(source);
  const protectedFr14 = encodeBackslashEscapes(swapLatexDisplayMathDelimiters(structuralSource));
  const protectedR23 = protectFromMdx(protectedFr14);
  const protected_ = encodeEntityRefs(protectedR23);

  const file = new VFile(protected_);
  const tree = processor.parse(file);
  file.value = source;
  const transformed = processor.runSync(tree, file) as MdastRoot;
  insertInteriorBlankRunParagraphs(transformed, source);
  const captured = captureDocBoundary(transformed, source, hadBom);
  const boundary = captured ? materializeDocEdgeBlankRuns(transformed, captured) : undefined;
  const doc = (processor as unknown as { stringify(tree: unknown): PmNode }).stringify(transformed);
  if (!boundary) return doc;
  return doc.type.create({ ...doc.attrs, sourceDocBoundary: boundary }, doc.content, doc.marks);
}

export function parseMdToMdast(rawSource: string, processor: Processor): MdastRoot {
  return parseToMdast(rawSource, processor, false);
}

export function parseMdToEditorMdast(rawSource: string, processor: Processor): MdastRoot {
  return parseToMdast(rawSource, processor, true);
}

function parseToMdast(
  rawSource: string,
  processor: Processor,
  materializeBlankRuns: boolean,
): MdastRoot {
  const { source: rawAfterBom, hadBom } = splitDocumentHeadBom(rawSource);
  const source = dedentBlockJsxClose(rawAfterBom);
  const structuralSource = normalizeStandaloneOrderedListContinuations(source);
  const protected_ = encodeEntityRefs(
    protectFromMdx(encodeBackslashEscapes(swapLatexDisplayMathDelimiters(structuralSource))),
  );
  const file = new VFile(protected_);
  const tree = processor.parse(file);
  file.value = source;
  const transformed = processor.runSync(tree, file) as MdastRoot;
  if (materializeBlankRuns) insertInteriorBlankRunParagraphs(transformed, source);
  const captured = captureDocBoundary(transformed, source, hadBom);
  if (materializeBlankRuns && captured) materializeDocEdgeBlankRuns(transformed, captured);
  return transformed;
}

interface MdastChildContainer {
  children: unknown[];
}

function insertTableSpanLayoutMarkers(parent: MdastChildContainer): void {
  const children: unknown[] = [];
  for (const child of parent.children) {
    const node = child as {
      type?: string;
      data?: { sourceSpanLayout?: unknown };
      children?: unknown[];
    };
    if (node.type !== 'table' && Array.isArray(node.children)) {
      insertTableSpanLayoutMarkers(node as MdastChildContainer);
    }
    if (node.type !== 'table') {
      children.push(child);
      continue;
    }
    const layout = normalizeTableSpanLayout(node.data?.sourceSpanLayout);
    if (layout === null) {
      children.push(child);
      continue;
    }
    const comment: CommentBlockMdast = {
      type: 'commentBlock',
      children: [{
        type: 'paragraph',
        children: [{ type: 'text', value: serializeTableSpanLayoutMarker(layout) }],
      }],
      data: { sourceForm: 'html', sourceLayout: 'inline' },
    };
    children.push(comment, child);
  }
  parent.children = children;
}

export function serializeMd(doc: PmNode, processor: Processor, opts: SerializeMdOptions): string {
  const mdast: MdastRoot = fromProseMirror(doc, {
    schema: opts.schema,
    nodeHandlers: opts.pmNodeHandlers,
    markHandlers: opts.pmMarkHandlers,
  });
  insertTableSpanLayoutMarkers(mdast as MdastChildContainer);

  mintEmptyTaskItemContent(mdast);

  stripTrailingEdge(mdast);

  pruneZeroEmissionBlocks(mdast);

  const boundary = readDocBoundary(doc.attrs?.sourceDocBoundary);

  let out = String(processor.stringify(mdast));
  if (boundary?.leading) out = boundary.leading + out;
  if (boundary?.trailing) {
    out = out.replace(/\n+$/, '') + boundary.trailing;
  }
  if (boundary?.bom) out = `\uFEFF${out}`;
  return out;
}
