/**
 * Large read-only documents begin in a bounded, passive block viewport: the
 * Markdown is split into chunks, each rendered by its own non-editable TipTap
 * instance, and only chunks near the scroll viewport stay mounted. The first
 * editing or native-selection gesture hands off once to the complete editor.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import Zoom from "react-medium-image-zoom";
import { MirrorHostProvider } from "@ok-app/editor/components/Mirror-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImageSrcFidelity } from "../../open-knowledge-core/extensions/image-src-fidelity";
import { listen } from "../dom-utils";
import { DocumentHeadingRail } from "./document-heading-rail";
import { documentHeadingItems } from "./document-heading-items";
import { localPaperFragment, openMarkdownLink } from "./markdown-link-routing";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { ProjectImageHostProvider, useProjectImageSrc } from "./project-image-host";
import { useNearViewport } from "./use-near-viewport";
import { GeneratedPaperContents } from "./visual-editor-extensions";
import type { VisualMarkdownBlock, VisualMarkdownBlockModel } from "./visual-markdown-block-model";
import { visualEditorExtensions } from "./visual-markdown-schema";

export type PassiveEditorHandoff = {
  sourceOffset: number;
  clientX?: number;
  clientY?: number;
  blockTop?: number;
  pointerId?: number;
  fragment?: string;
  navigationOnly?: boolean;
  command?: "find" | "selectAll";
};

type PassiveVisualChunk = {
  id: string;
  blocks: VisualMarkdownBlock[];
  from: number;
  content: VisualMarkdownBlock["content"];
  estimatedHeight: number;
};

export function ProjectInlineImageView({ node }: NodeViewProps) {
  const { nearViewport, viewportRef } = useNearViewport<HTMLSpanElement>();
  const src = useProjectImageSrc(typeof node.attrs.src === "string" ? node.attrs.src : undefined, nearViewport);
  const image = (
    <img
      src={src}
      alt={typeof node.attrs.alt === "string" ? node.attrs.alt : ""}
      title={typeof node.attrs.title === "string" ? node.attrs.title : undefined}
      loading="eager"
      decoding="async"
    />
  );
  return (
    <NodeViewWrapper as="span" ref={viewportRef} data-image-inline-zoom data-clipboard-inline-leaf="image">
      {nearViewport && src ? <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ src, sizes: undefined }}>{image}</Zoom> : image}
    </NodeViewWrapper>
  );
}

/** Context every rendered Markdown surface needs: project images, mirrors, and tooltips. */
export function EditorHostProviders({ activePath, onLoadAsset, assetRevision, workspaceIndex, children }: {
  activePath: string;
  onLoadAsset?: (path: string) => Promise<string | null>;
  assetRevision: number;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  children: ReactNode;
}) {
  return (
    <ProjectImageHostProvider activePath={activePath} loadAsset={onLoadAsset} revision={assetRevision}>
      <MirrorHostProvider workspaceIndex={workspaceIndex}>
        <TooltipProvider delayDuration={280} skipDelayDuration={400}>{children}</TooltipProvider>
      </MirrorHostProvider>
    </ProjectImageHostProvider>
  );
}

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
    // Keep a heading with the block that follows it. Besides reading less
    // fragmented, this preserves the generated paper Contents heading + list
    // pair that the render-only decoration recognizes.
    const endsWithHeading = block.content.at(-1)?.type === "heading";
    if (!endsWithHeading && (estimatedHeight >= 720 || blocks.length >= 12)) flush();
  }
  flush();
  return chunks;
}

function sourceBlockAtPointer(chunk: PassiveVisualChunk, target: EventTarget | null): { sourceOffset: number; blockTop?: number } {
  const element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  const proseMirror = element?.closest<HTMLElement>(".ProseMirror");
  if (!element || !proseMirror || element === proseMirror) return { sourceOffset: chunk.from };
  let topLevel = element;
  while (topLevel.parentElement && topLevel.parentElement !== proseMirror) topLevel = topLevel.parentElement;
  if (topLevel.parentElement !== proseMirror) return { sourceOffset: chunk.from };
  const block = chunk.blocks[Math.max(0, Array.from(proseMirror.children).indexOf(topLevel))] ?? chunk.blocks[0];
  return { sourceOffset: block?.from ?? chunk.from, blockTop: topLevel.getBoundingClientRect().top };
}

function MountedPassiveVisualChunk({ chunk, index, optimizeForReading, onActivate, onMeasure }: {
  chunk: PassiveVisualChunk;
  index: number;
  optimizeForReading: boolean;
  onActivate: (handoff: PassiveEditorHandoff) => void;
  onMeasure: (index: number, height: number, element: HTMLElement) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingLinkDragRef = useRef<{ handoff: PassiveEditorHandoff; clientX: number; clientY: number } | null>(null);
  const extensions = useMemo(() => visualEditorExtensions(ImageSrcFidelity.extend({
    addNodeView: () => ReactNodeViewRenderer(ProjectInlineImageView, { as: "span" }),
  })).concat(optimizeForReading ? [GeneratedPaperContents] : []), [optimizeForReading]);
  const editor = useEditor({
    editable: false,
    shouldRerenderOnTransaction: false,
    extensions,
    content: { type: "doc", content: chunk.content },
    editorProps: { attributes: { tabindex: "-1" } },
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

  // A pointer-down on a link waits to see whether it becomes a drag: a click
  // opens the link, a drag hands off to the complete editor as a selection.
  useEffect(() => {
    const clearPendingLinkDrag = () => {
      pendingLinkDragRef.current = null;
    };
    const continueLinkDrag = (event: PointerEvent) => {
      const pending = pendingLinkDragRef.current;
      if (!pending || Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < 4) return;
      pendingLinkDragRef.current = null;
      event.preventDefault();
      onActivate({ ...pending.handoff, clientX: event.clientX, clientY: event.clientY });
    };
    return listen(window, [
      ["pointermove", continueLinkDrag, { passive: false }],
      ["pointerup", clearPendingLinkDrag],
      ["pointercancel", clearPendingLinkDrag],
    ]);
  }, [onActivate]);

  if (!editor) return null;
  return (
    <div
      ref={contentRef}
      className="tiptap-editor visual-markdown-virtual-block-content"
      data-visual-chunk-id={chunk.id}
      onPointerDownCapture={(event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("button, input, textarea, select, summary, [role='button'], [data-image-inline-zoom]")) return;
        const handoff = { ...sourceBlockAtPointer(chunk, event.target), pointerId: event.pointerId };
        if (target?.closest("a[href]")) {
          pendingLinkDragRef.current = { handoff, clientX: event.clientX, clientY: event.clientY };
          return;
        }
        event.preventDefault();
        onActivate({ ...handoff, clientX: event.clientX, clientY: event.clientY });
      }}
    >
      <EditorContent className="tiptap-editor-portal-content" editor={editor} />
    </div>
  );
}

export function PassiveVisualMarkdownViewport({
  model,
  activePath,
  optimizeForReading,
  onActivate,
  onLoadAsset,
  assetRevision,
  onOpenProjectPath,
  workspaceIndex,
}: {
  model: VisualMarkdownBlockModel;
  activePath: string;
  optimizeForReading: boolean;
  onActivate: (handoff: PassiveEditorHandoff) => void;
  onLoadAsset?: (path: string) => Promise<string | null>;
  assetRevision: number;
  onOpenProjectPath?: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
}) {
  const chunks = useMemo(() => passiveVisualChunks(model), [model]);
  const headingItems = useMemo(() => documentHeadingItems({
    type: "doc",
    content: model.blocks.flatMap((block) => block.content),
  }, { hideGeneratedContents: optimizeForReading }), [model, optimizeForReading]);
  const documentStart = model.blocks[0]?.from ?? 0;
  const sectionRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const scrollCompensationRef = useRef(0);
  const [heights, setHeights] = useState(() => chunks.map((chunk) => chunk.estimatedHeight));
  const [mountedRange, setMountedRange] = useState(() => ({ from: 0, to: Math.min(chunks.length, 3) }));
  const updateMountedRange = useCallback(() => {
    const section = sectionRef.current;
    const scroller = scrollRef.current;
    if (!section || !scroller || !chunks.length) return;
    const sectionTop = section.getBoundingClientRect().top;
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportFrom = Math.max(0, scrollerRect.top - sectionTop - 1_600);
    const viewportTo = Math.max(viewportFrom, scrollerRect.bottom - sectionTop + 1_600);
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
    to = Math.min(chunks.length, Math.max(to + 1, from + 1), from + 12);
    setMountedRange((current) => current.from === from && current.to === to ? current : { from, to });
  }, [chunks.length, heights]);

  useLayoutEffect(() => {
    const scroller = sectionRef.current?.closest<HTMLElement>(".editor-doc-scroll");
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
    const stops = [listen(scroller, [["scroll", schedule, { passive: true }]]), listen(window, [["resize", schedule]])];
    return () => {
      scrollRef.current = null;
      stops.forEach((stop) => stop());
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updateMountedRange]);
  // A chunk above the viewport that grows or shrinks once measured would push
  // the visible content; scroll by the same amount so the reader stays put.
  useLayoutEffect(() => {
    const compensation = scrollCompensationRef.current;
    if (!compensation || !scrollRef.current) return;
    scrollCompensationRef.current = 0;
    scrollRef.current.scrollTop += compensation;
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
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const activateAt = (fragment?: string) => onActivate(fragment
    ? { sourceOffset: documentStart, fragment, navigationOnly: true }
    : { sourceOffset: documentStart });

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
        if (!(event.target instanceof HTMLElement && event.target.closest(".visual-heading-rail"))) activateAt();
      }}
      onKeyDownCapture={(event) => {
        const key = event.key.toLocaleLowerCase();
        if ((!event.metaKey && !event.ctrlKey) || (key !== "f" && key !== "a")) return;
        event.preventDefault();
        event.stopPropagation();
        onActivate({ sourceOffset: documentStart, command: key === "f" ? "find" : "selectAll" });
      }}
      onClickCapture={(event) => {
        const href = event.target instanceof HTMLElement
          ? event.target.closest("a[href]")?.getAttribute("href")
          : null;
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        const localFragment = localPaperFragment(activePath, href);
        if (localFragment) activateAt(`#${encodeURIComponent(localFragment.id)}`);
        else openMarkdownLink(activePath, href, onOpenProjectPath, sectionRef.current ?? undefined);
      }}
    >
      <DocumentHeadingRail items={headingItems} virtualized onSelect={(item) => activateAt(`#${encodeURIComponent(item.id)}`)} />
      <button type="button" className="visual-markdown-virtual-edit" onClick={() => activateAt()}>Edit document</button>
      <EditorHostProviders activePath={activePath} onLoadAsset={onLoadAsset} assetRevision={assetRevision} workspaceIndex={workspaceIndex}>
        <div aria-hidden="true" style={{ height: `${sum(heights.slice(0, mountedRange.from))}px` }} />
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
        <div aria-hidden="true" style={{ height: `${sum(heights.slice(mountedRange.to))}px` }} />
      </EditorHostProviders>
    </section>
  );
}
