import type { JSONContent } from "@tiptap/core";
import { getHeadingSlug } from "@ok-app/editor/extensions/wiki-link-helpers";
import type { DocumentHeadingItem } from "./document-heading-rail";

function jsonTextContent(node: JSONContent): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(jsonTextContent).join("");
}

function jsonHasInternalAnchor(node: JSONContent): boolean {
  return Boolean(node.marks?.some((mark) => mark.type === "link" && String(mark.attrs?.href ?? "").startsWith("#")))
    || (node.content ?? []).some(jsonHasInternalAnchor);
}

/**
 * The rail follows the same parsed document that TipTap renders rather than a
 * second Markdown regex.
 * Slugs are accumulated before presentation filtering so duplicate heading
 * IDs stay byte-identical to HeadingAnchorsStateful.
 */
export function documentHeadingItems(
  document: JSONContent,
  options: { hideGeneratedContents?: boolean } = {},
): DocumentHeadingItem[] {
  const roots = document.content ?? [];
  const slugCounts = new Map<string, number>();
  const headings: DocumentHeadingItem[] = [];
  const lastRootIndex = Math.max(1, roots.length - 1);
  // A generated table of contents is an H2 "Contents" followed by a list of
  // in-document anchor links; reading mode hides it from the rail.
  const generatedContentsHeadings = new Set(!options.hideGeneratedContents ? [] : roots.filter((heading, index) => {
    const list = roots[index + 1];
    return heading.type === "heading"
      && Number(heading.attrs?.level) === 2
      && jsonTextContent(heading).trim().toLocaleLowerCase() === "contents"
      && list?.type === "list"
      && jsonHasInternalAnchor(list);
  }));

  const visit = (node: JSONContent, rootIndex: number) => {
    if (node.type === "heading") {
      const label = jsonTextContent(node).replace(/\s+/g, " ").trim();
      const level = Number(node.attrs?.level);
      const id = getHeadingSlug(label, slugCounts);
      if (id && label && !generatedContentsHeadings.has(node)) {
        headings.push({
          id,
          label,
          level: Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 2,
          position: rootIndex / lastRootIndex,
        });
      }
    }
    for (const child of node.content ?? []) visit(child, rootIndex);
  };

  roots.forEach((root, index) => visit(root, index));
  return headings;
}
