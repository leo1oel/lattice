/**
 * Large read-only documents open in a passive view (spec R-PERF-1–6, R-BLK-14):
 * the document's exact blocks are grouped into chunks, and each chunk is
 * drawn by its own read-only engine only while it is near the viewport, so a
 * long paper opens without laying out every formula and figure. Nothing is
 * ever published from it.
 *
 * Heading ids and the hidden generated Contents are planned over the whole
 * document, so they hold across chunk boundaries. Links work in place; a link
 * into the paper itself (a fragment, or the paper's own arXiv page) switches
 * to the complete editor first, since its target may sit in a chunk not drawn
 * yet. "Edit document" switches too.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension, type AnyExtension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "../../../components/ui/button";
import { DocumentHeadingRail, type DocumentHeadingItem } from "../document-heading-rail";
import { localPaperFragment, openMarkdownLink } from "../markdown-link-routing";
import { useNearViewport } from "../use-near-viewport";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { HeadingAnchors, anchorMarks, documentHeadings, type AnchorMark } from "./heading-anchors";
import type { MarkdownBaseline } from "./markdown-document";
import { placements } from "./source-map";

/** A read-only document of at least this many blocks (or this much text) opens passive. */
export const PASSIVE_MIN_BLOCKS = 120;
export const PASSIVE_MIN_LENGTH = 150_000;
/** Blocks per chunk: a 180-block document is eight chunks. */
const CHUNK_BLOCKS = 24;
/** One block this large (a 900-item list, say) would defeat the bound on what is drawn: no passive view. */
const MAX_BLOCK_ITEMS = 400;
const MAX_BLOCK_LENGTH = 60_000;

type Label = { pos: number; line: number; from: number; to: number };

export type PassiveChunk = {
  id: string;
  nodes: PmNode[];
  /** Heading ids and hidden Contents, at positions in this chunk. */
  marks: AnchorMark[];
  /** Source labels of its blocks, for split-view scroll sync. */
  labels: Label[];
  /** Rough height before it is drawn. */
  estimate: number;
};

export type PassiveModel = { chunks: PassiveChunk[]; headings: DocumentHeadingItem[] };

/** The passive layout of a document, or null when it is small enough (or shaped so) to draw whole. */
export function passiveModel(doc: PmNode, baseline: MarkdownBaseline, textLength: number, paper: boolean): PassiveModel | null {
  const { entries } = baseline;
  if (entries.length < 2 || doc.childCount !== entries.length) return null;
  if (entries.length < PASSIVE_MIN_BLOCKS && textLength < PASSIVE_MIN_LENGTH) return null;
  if (entries.some((entry) => entry.source.length > MAX_BLOCK_LENGTH || entry.node.childCount > MAX_BLOCK_ITEMS)) return null;
  const places = placements(baseline);
  const marks = anchorMarks(doc, paper);
  const starts: number[] = [];
  doc.forEach((_node, offset) => starts.push(offset));
  const chunks: PassiveChunk[] = [];
  for (let first = 0; first < entries.length; first += CHUNK_BLOCKS) {
    const last = Math.min(entries.length, first + CHUNK_BLOCKS);
    const from = starts[first]!;
    const to = last < entries.length ? starts[last]! : doc.content.size;
    const nodes = entries.slice(first, last).map((_entry, index) => doc.child(first + index));
    chunks.push({
      id: `chunk-${first}`,
      nodes,
      marks: marks.filter((mark) => mark.pos >= from && mark.pos < to).map((mark) => ({ ...mark, pos: mark.pos - from })),
      labels: nodes.map((_node, index) => {
        const place = places[first + index]!;
        return { pos: starts[first + index]! - from, line: place.row + 1, from: place.textFrom, to: place.textTo };
      }),
      estimate: entries.slice(first, last).reduce((height, entry) => height + 18 + 26 * (1 + (entry.source.match(/\n/g)?.length ?? 0)), 0),
    });
  }
  const size = Math.max(1, doc.content.size);
  const headings = documentHeadings(doc, paper)
    .filter((heading) => heading.id && !heading.generatedContents)
    .map((heading) => ({ id: heading.id, label: heading.text, level: heading.level, position: heading.pos / size }));
  return { chunks, headings };
}

/** Source labels on a chunk's blocks, when the host scrolls by them (R-SRC-11). */
function chunkLabels(labels: readonly Label[]) {
  return Extension.create({
    name: "latticePassiveLabels",
    addProseMirrorPlugins: () => [new Plugin({
      props: {
        decorations: (state) => DecorationSet.create(state.doc, labels.flatMap((label) => {
          const node = state.doc.nodeAt(label.pos);
          return node ? [Decoration.node(label.pos, label.pos + node.nodeSize, {
            "data-source-line": String(label.line),
            "data-source-offset": String(label.from),
            "data-source-end-offset": String(label.to),
          })] : [];
        })),
      },
    })],
  });
}

type ViewProps = {
  model: PassiveModel;
  props: VisualMarkdownEditorProps;
  /** The engine's reading extensions: its schema and block views. */
  reading: () => AnyExtension[];
  /** Switch to the complete editor, then follow `href` there when given. */
  onActivate: (href: string | null) => void;
};

export function PassiveView({ model, props, reading, onActivate }: ViewProps) {
  const { t } = useLingui();
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ props, onActivate });
  useLayoutEffect(() => {
    latest.current = { props, onActivate };
  });
  const follow = (href: string) => {
    const { props: current, onActivate: activate } = latest.current;
    // A target inside the paper may be in a chunk not drawn yet.
    if (localPaperFragment(current.activePath, href)) activate(href);
    else openMarkdownLink(current.activePath, href, current.onOpenProjectPath, root.current ?? undefined);
  };
  const openPage = (target: string) => {
    const { props: current } = latest.current;
    const page = current.workspaceIndex?.getDoc(target.split("#")[0]!);
    if (page) current.onOpenProjectPath?.(page.path);
  };
  return (
    <div ref={root} className="lx-md-passive" role="document" aria-label={t`Visual Markdown editor`} data-virtualized="true">
      <DocumentHeadingRail
        items={model.headings}
        virtualized
        onSelect={(item) => {
          const heading = root.current?.querySelector(`[id="${CSS.escape(item.id)}"]`);
          if (heading) heading.scrollIntoView({ block: "start" });
          else {
            const index = model.chunks.findIndex((chunk) => chunk.marks.some((mark) => mark.id === item.id));
            root.current?.querySelector(`[data-visual-chunk-id="${model.chunks[index]?.id ?? ""}"]`)?.scrollIntoView({ block: "start" });
          }
        }}
      />
      <div className="lx-md-passive-bar">
        <Button variant="ghost" size="compact" onClick={() => onActivate(null)}>{t`Edit document`}</Button>
      </div>
      {model.chunks.map((chunk) => (
        <PassiveChunkView
          key={chunk.id}
          chunk={chunk}
          labels={Boolean(props.synchronizeSourceScroll)}
          reading={reading}
          onLink={follow}
          onPage={openPage}
        />
      ))}
    </div>
  );
}

function PassiveChunkView({ chunk, labels, reading, onLink, onPage }: {
  chunk: PassiveChunk;
  labels: boolean;
  reading: () => AnyExtension[];
  onLink: (href: string) => void;
  onPage: (target: string) => void;
}) {
  const { nearViewport, viewportRef } = useNearViewport<HTMLElement>();
  const [section, setSection] = useState<HTMLElement | null>(null);
  const sectionRef = useCallback((element: HTMLElement | null) => {
    viewportRef(element);
    setSection(element);
  }, [viewportRef]);
  // Once drawn, a chunk keeps its measured height while it is away, so the page never jumps.
  const [height, setHeight] = useState(chunk.estimate);
  useEffect(() => {
    if (!section || !nearViewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (section.offsetHeight) setHeight(section.offsetHeight);
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [nearViewport, section]);
  return (
    <section
      ref={sectionRef}
      className="lx-md-passive-chunk"
      data-visual-chunk-id={chunk.id}
      style={nearViewport ? undefined : { minHeight: `${height}px` }}
    >
      {nearViewport && <ChunkEditor chunk={chunk} labels={labels} reading={reading} onLink={onLink} onPage={onPage} />}
    </section>
  );
}

function ChunkEditor({ chunk, labels, reading, onLink, onPage }: {
  chunk: PassiveChunk;
  labels: boolean;
  reading: () => AnyExtension[];
  onLink: (href: string) => void;
  onPage: (target: string) => void;
}) {
  const handlers = useRef({ onLink, onPage });
  useLayoutEffect(() => {
    handlers.current = { onLink, onPage };
  });
  const extensions = useMemo(() => [
    ...reading(),
    HeadingAnchors.configure({ marks: () => chunk.marks }),
    ...(labels ? [chunkLabels(chunk.labels)] : []),
  ], [chunk, labels, reading]);
  const editor = useEditor({
    extensions,
    content: { type: "doc", content: chunk.nodes.map((node) => node.toJSON()) },
    editable: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "lx-md-surface" },
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement | null;
          const wiki = target?.closest?.("[data-lattice-wiki]");
          const anchor = target?.closest?.("a[href]");
          if (!wiki && !anchor) return false;
          event.preventDefault();
          if (wiki) handlers.current.onPage(wiki.getAttribute("data-target") ?? "");
          else handlers.current.onLink(anchor!.getAttribute("href") ?? "");
          return true;
        },
      },
    },
  }, [extensions]);
  return <EditorContent editor={editor} />;
}
