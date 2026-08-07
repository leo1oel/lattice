/**
 * Local seam — not upstream code.
 *
 * Upstream `Mirror.tsx` resolves a `<MirrorSource id="…">` from ANOTHER
 * document through a refcounted Hocuspocus/Yjs provider pool
 * (use-mirror-source.ts) — a cross-document collab runtime this host does
 * not have (canonical authority is one Y.Text("content") per document,
 * behind a plain-string editor boundary).
 *
 * This host resolves the source from MarkdownWorkspaceIndex, then follows
 * upstream's parse → MirrorSource lookup → sanitized static HTML pipeline.
 * It intentionally remains read-only and does not introduce another Y.Doc.
 */
import { Link2 } from "lucide-react";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Trans } from "@ok-app/shims/lingui-react-macro";
import { getSharedMarkdownManager } from "@ok-app/editor/utils/md-singleton";
import { mdastToHtml } from "../../../open-knowledge-core/markdown/mdast-to-html";
import type { MarkdownWorkspaceIndex } from "../../../markdown-workspace-index";

interface MirrorProps {
  src?: string;
  anchor?: string;
}

type MdastNode = {
  type: string;
  name?: string | null;
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
  children?: MdastNode[];
};

const MirrorWorkspaceContext = createContext<MarkdownWorkspaceIndex | null>(null);
const subscribeToNothing = () => () => undefined;
const getZeroRevision = () => 0;

export function MirrorHostProvider(props: {
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  children: ReactNode;
}) {
  return (
    <MirrorWorkspaceContext.Provider value={props.workspaceIndex ?? null}>
      {props.children}
    </MirrorWorkspaceContext.Provider>
  );
}

function findMirrorSource(node: MdastNode, anchor: string): MdastNode | null {
  if (node.type === "mdxJsxFlowElement" && node.name === "MirrorSource") {
    const id = node.attributes?.find((attribute) =>
      attribute.type === "mdxJsxAttribute" && attribute.name === "id"
    );
    if (id?.value === anchor) return node;
  }
  for (const child of node.children ?? []) {
    const match = findMirrorSource(child, anchor);
    if (match) return match;
  }
  return null;
}

function resolveMirror(index: MarkdownWorkspaceIndex, src: string, anchor: string) {
  const markdown = index.contentFor(src);
  if (markdown === undefined) return { kind: "missing-source" } as const;
  let tree: MdastNode;
  try {
    tree = getSharedMarkdownManager().parseToMdast(markdown) as MdastNode;
  } catch {
    // The raw mdast parser throws on broken MDX (an unclosed `{`); a source
    // document the mirror cannot parse reads as missing rather than
    // crashing the document that embeds the mirror.
    return { kind: "missing-anchor" } as const;
  }
  const source = findMirrorSource(tree, anchor);
  if (!source) return { kind: "missing-anchor" } as const;
  const root = { type: "root", children: source.children ?? [] };
  return {
    kind: "ready",
    html: mdastToHtml(root as Parameters<typeof mdastToHtml>[0]),
  } as const;
}

function StatusFrame(props: { children: ReactNode }) {
  return (
    <div className="ok-mirror-state flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
      <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

export function Mirror(props: MirrorProps) {
  const src = props.src ?? "";
  const anchor = props.anchor ?? "";
  const mirrorRef = src && anchor ? `${src}#${anchor}` : "";
  const workspaceIndex = useContext(MirrorWorkspaceContext);
  const revision = useSyncExternalStore(
    workspaceIndex ? (listener) => workspaceIndex.subscribe(listener) : subscribeToNothing,
    workspaceIndex ? () => workspaceIndex.revision : getZeroRevision,
    getZeroRevision,
  );
  // Reading the revision is what subscribes this render to index updates;
  // resolution itself is cheap and keeps no stale cross-document cache.
  void revision;
  const resolved = workspaceIndex && mirrorRef
    ? resolveMirror(workspaceIndex, src, anchor)
    : null;

  if (!mirrorRef) {
    return (
      <StatusFrame>
        <Trans>
          <span className="font-medium">Mirror — pick a source.</span> Set <code>src</code> +{" "}
          <code>anchor</code> via the property panel to point at a <code>{"<MirrorSource>"}</code>{" "}
          elsewhere.
        </Trans>
      </StatusFrame>
    );
  }

  if (!workspaceIndex) {
    return <StatusFrame>Mirror workspace index is unavailable.</StatusFrame>;
  }

  if (resolved?.kind === "missing-source") {
    return <StatusFrame>Mirror source <code>{src}</code> was not found.</StatusFrame>;
  }

  if (resolved?.kind === "missing-anchor") {
    return <StatusFrame>Mirror source <code>{src}</code> has no <code>{anchor}</code> anchor.</StatusFrame>;
  }

  return (
    <div
      className="ok-mirror-resolved"
      data-mirror-src={src}
      data-mirror-anchor={anchor}
      dangerouslySetInnerHTML={{ __html: resolved?.kind === "ready" ? resolved.html : "" }}
    />
  );
}
