import { colorSpans, type Phrasing } from "./inline-syntax";
import { parseMarkdownTree } from "./markdown-syntax";
import { MODELLED_COMPONENTS, findClosingTag, readOpenTag } from "./mdx-components";
import type { Segment } from "./source-map";

/** Align a colored block against the text between its tags, then restore the original source coordinates. */
export function colorSourceOffsets(source: string) {
  const skip = new Uint8Array(source.length);
  function visit(node: Phrasing, base: number) {
    // CommonMark groups a compact component as raw HTML. The editor reads
    // the component body as a separate Markdown document.
    if (node.type === "html" && /^<[A-Z]/.test(node.value ?? "")) {
      const from = base + node.position!.start.offset!;
      const open = readOpenTag(source, from);
      if (open && MODELLED_COMPONENTS.has(open.name) && !open.selfClosing && open.props.every((prop) => prop.kind !== "expression")) {
        const close = findClosingTag(source, open.name, open.end);
        if (close && close.end <= base + node.position!.end.offset!) {
          visit(parseMarkdownTree(source.slice(open.end, close.start)) as unknown as Phrasing, open.end);
        }
      }
    }
    if (!node.children) return;
    colorSpans(node.children, (open, close) => {
      for (const tag of [open, close]) skip.fill(1, base + tag.position!.start.offset!, base + tag.position!.end.offset!);
    });
    node.children.forEach((child) => visit(child, base));
  }
  visit(parseMarkdownTree(source) as unknown as Phrasing, 0);

  const original: number[] = [];
  let text = "";
  for (let index = 0; index < source.length; index += 1) {
    if (skip[index]) continue;
    original.push(index);
    text += source.charAt(index);
  }
  original.push(source.length);

  function restore(segments: Segment[]): Segment[] {
    const result: Segment[] = [];
    for (const part of segments) {
      // The editor merges identically marked neighbors. Keep their shared
      // editor boundary on both sides of the intervening Markdown tags.
      let from = part.from;
      if (part.exact) {
        for (let at = from + 1; at < part.to; at += 1) {
          if (original[at] === original[at - 1]! + 1) continue;
          result.push({ exact: true, pmFrom: part.pmFrom + from - part.from, pmTo: part.pmFrom + at - part.from, from: original[from]!, to: original[at - 1]! + 1 });
          from = at;
        }
      }
      const to = original[part.to - 1]! + 1;
      result.push({
        ...part, from: original[from]!, to, pmFrom: part.pmFrom + from - part.from,
        offsets: part.offsets?.map((offset) => offset === part.to ? to : original[offset]!),
      });
    }
    return result;
  }
  return { text, restore };
}
