import type { JSONContent } from "@tiptap/core";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";

const MAX_PASSIVE_ROOT_SOURCE_LENGTH = 200_000;
const MAX_PASSIVE_ROOT_DESCENDANTS = 800;

export type VisualMarkdownBlock = {
  id: string;
  from: number;
  to: number;
  source: string;
  content: JSONContent[];
  estimatedHeight: number;
};

export type VisualMarkdownBlockModel = {
  id: string;
  sourceOffsetBase: number;
  body: string;
  blocks: VisualMarkdownBlock[];
  leading: string;
  gaps: string[];
  trailing: string;
};

function sourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** [minimum height, height per visual line] by root node type. */
const HEIGHT_ESTIMATES: Record<string, [number, number]> = { table: [96, 38], codeBlock: [88, 28], list: [48, 32], jsxComponent: [96, 36] };

function estimatedBlockHeight(source: string, type: string | undefined): number {
  const visualLines = Math.max(1, source.split("\n").length, Math.ceil(source.length / 76));
  const [minimum, lineHeight] = HEIGHT_ESTIMATES[type ?? ""] ?? [40, 32];
  return Math.max(minimum, visualLines * lineHeight);
}

function descendantCount(content: JSONContent): number {
  return 1 + (content.content ?? []).reduce((count, child) => count + descendantCount(child), 0);
}

/**
 * Builds source-owning top-level blocks only when the parser proves a
 * one-to-one, monotonic mapping between Markdown root nodes and ProseMirror
 * root nodes. Virtual rendering is an optimization, so uncertain ownership is
 * represented by `null` and the caller keeps the complete editor.
 */
export function buildVisualMarkdownBlockModel(
  markdown: string,
  activePath?: string,
): VisualMarkdownBlockModel | null {
  const sourceOffsetBase = markdown.startsWith("\uFEFF") ? 1 : 0;
  const body = sourceOffsetBase ? markdown.slice(sourceOffsetBase) : markdown;
  if (!body.trim()) return null;

  let mdast;
  let parsed: JSONContent;
  try {
    mdast = getMarkdownManager().parseToEditorMdast(body);
    parsed = parseVisualMarkdown(body, activePath);
  } catch {
    return null;
  }

  const pmBlocks = parsed.content ?? [];
  if (mdast.children.length !== pmBlocks.length || pmBlocks.length < 2) return null;

  const occurrences = new Map<string, number>();
  const blocks: VisualMarkdownBlock[] = [];
  let previousEnd = 0;
  for (let index = 0; index < mdast.children.length; index += 1) {
    const node = mdast.children[index];
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (typeof from !== "number" || typeof to !== "number" || from < previousEnd || to < from || to > body.length) return null;

    const source = body.slice(from, to);
    const pmBlock = pmBlocks[index]!;
    // The viewport can bound root blocks, not an arbitrarily large subtree
    // inside one block. Fall back to the complete editor's nested containment
    // and near-viewport media policy for pathological lists/tables/containers.
    if (source.length > MAX_PASSIVE_ROOT_SOURCE_LENGTH || descendantCount(pmBlock) > MAX_PASSIVE_ROOT_DESCENDANTS) return null;
    const fingerprint = `${pmBlock.type ?? "unknown"}:${sourceHash(source)}`;
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    blocks.push({
      id: `${fingerprint}:${occurrence}`,
      from,
      to,
      source,
      content: [pmBlock],
      estimatedHeight: estimatedBlockHeight(source, pmBlock.type),
    });
    previousEnd = to;
  }

  // Blocks are ordered, non-overlapping slices of `body`, so leading + blocks
  // interleaved with gaps + trailing reproduces it byte for byte.
  return {
    id: sourceHash(body),
    sourceOffsetBase,
    body,
    blocks,
    leading: body.slice(0, blocks[0]!.from),
    gaps: blocks.slice(1).map((block, index) => body.slice(blocks[index]!.to, block.from)),
    trailing: body.slice(blocks.at(-1)!.to),
  };
}
