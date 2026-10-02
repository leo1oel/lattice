/**
 * Source the visual engine keeps verbatim (spec R-BLK-16, R-RT-17): unknown
 * components, block HTML, link definitions, frontmatter. The source is the
 * block's own editable text, so editing it edits the file; a small label says
 * what it is. A converter anchor is an invisible scroll target (R-RT-14).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useLingui } from "@lingui/react/macro";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { rawAnchorId } from "../block-anchors";
import type { RawBlockKind } from "../engine-schema";

export function RawBlockView({ node }: NodeViewProps) {
  const { t } = useLingui();
  const kind = node.attrs.kind as RawBlockKind;
  if (kind === "anchor") {
    return (
      <NodeViewWrapper className="lx-md-anchor" id={rawAnchorId(node)} aria-hidden="true">
        <NodeViewContent<"pre"> as="pre" hidden />
      </NodeViewWrapper>
    );
  }
  const componentName = kind === "component" ? node.textContent.match(/^<([A-Za-z][\w.:-]*)/)?.[1] ?? "" : "";
  const labels: Record<Exclude<RawBlockKind, "anchor">, string> = {
    html: t`HTML`,
    component: componentName,
    definition: t`Link definition`,
    frontmatter: t`Frontmatter`,
    unsupported: t`Markdown source`,
  };
  const groupLabel = kind === "component" ? t`Unknown component: ${componentName}` : labels[kind];
  return (
    <NodeViewWrapper className="lx-md-raw" data-kind={kind} role="group" aria-label={groupLabel}>
      <span className="lx-md-raw-label" contentEditable={false}>{labels[kind]}</span>
      <NodeViewContent<"pre"> as="pre" className="lx-md-raw-source" spellCheck={false} />
    </NodeViewWrapper>
  );
}
