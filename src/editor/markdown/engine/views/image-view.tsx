/**
 * Images in the visual engine (spec R-BLK-3, R-FMT-7): project images load
 * through the host's asset reader, a click opens them larger, and a hover
 * toolbar aligns them. Dragging an edge resizes; a resized or aligned image is
 * written as an HTML `<img>` with an integer width and no height.
 *
 * An image alone in its paragraph is a figure: the paragraph is marked so the
 * stylesheet can align the image within the column.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
/* eslint-disable react-refresh/only-export-components -- the figure decoration belongs with the view */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { AlignCenter, AlignLeft, AlignRight, ImageOff, Settings2 } from "lucide-react";
import Zoom from "react-medium-image-zoom";
import { IconButton } from "../../../../components/ui/icon-button";
import { Input } from "../../../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover";
import { useProjectImage } from "../../project-image-host";
import { changedBlockRanges } from "../changed-ranges";
import { Field, setNodeAttrs, useCommitKeys } from "./view-chrome";

/** Schemes that never reach the DOM as an image source. */
const UNSAFE_SOURCE = /^\s*(?:javascript|vbscript|file|data:text\/html):/i;

const MIN_WIDTH = 48;

type Align = "left" | "center" | "right";

export function ImageView(props: NodeViewProps) {
  const { t } = useLingui();
  const { node, editor, getPos } = props;
  const authored = String(node.attrs.src ?? "");
  const safe = !UNSAFE_SOURCE.test(authored);
  const image = useProjectImage(safe && authored ? authored : undefined);
  const [loaded, setLoaded] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const frame = useRef<HTMLSpanElement>(null);
  const width = dragWidth ?? (typeof node.attrs.width === "number" ? node.attrs.width : null);
  const align = (node.attrs.align as Align | null) ?? "center";
  const editable = editor.isEditable;
  const alt = String(node.attrs.alt ?? "");
  const missing = !safe || !authored || image.targetExistence === "missing";

  const startResize = (side: "left" | "right", event: ReactPointerEvent) => {
    const element = frame.current;
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const available = element.closest(".lx-md-surface")?.getBoundingClientRect().width || Number.POSITIVE_INFINITY;
    let latest = startWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (side === "right" ? 1 : -1) * (align === "center" ? 2 : 1);
      latest = Math.round(Math.min(available, Math.max(MIN_WIDTH, startWidth + delta)));
      setDragWidth(latest);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      setDragWidth(null);
      if (Math.round(latest) !== Math.round(startWidth)) setNodeAttrs(editor, getPos, node, { width: latest });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const setAlign = (next: Align) => {
    const value = next === "center" && node.attrs.align !== "center" ? null : next;
    if (value !== node.attrs.align) setNodeAttrs(editor, getPos, node, { align: value });
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`lx-md-image${props.selected ? " is-selected" : ""}`}
      data-image-size={width ? "authored" : "auto"}
      data-align={align}
    >
      <span ref={frame} className="lx-md-image-frame" style={width ? { width: `${width}px` } : undefined} contentEditable={false}>
        {missing
          ? (
            <span className="lx-md-image-missing" role="img" aria-label={alt || authored}>
              <ImageOff aria-hidden="true" />
              <span>{alt || authored || t`Image`}</span>
            </span>
          )
          : image.src
            ? (
              <Zoom zoomMargin={32} a11yNameButtonZoom={t`Expand image`} a11yNameButtonUnzoom={t`Minimize image`}>
                <img
                  src={image.src}
                  alt={alt}
                  title={node.attrs.title ?? undefined}
                  decoding="async"
                  draggable={false}
                  className={loaded ? "is-loaded" : undefined}
                  onLoad={() => setLoaded(true)}
                />
              </Zoom>
            )
            : <span className="lx-md-image-loading" aria-hidden="true" />}
        {editable && (
          <>
            <span className="lx-md-image-toolbar">
              <span className="lx-md-image-toolbar-group" role="group" aria-label={t`Alignment`}>
                <IconButton size="compact" tooltip={false} label={t`Align left`} aria-pressed={align === "left"} onClick={() => setAlign("left")}>
                  <AlignLeft aria-hidden="true" />
                </IconButton>
                <IconButton size="compact" tooltip={false} label={t`Align center`} aria-pressed={align === "center"} onClick={() => setAlign("center")}>
                  <AlignCenter aria-hidden="true" />
                </IconButton>
                <IconButton size="compact" tooltip={false} label={t`Align right`} aria-pressed={align === "right"} onClick={() => setAlign("right")}>
                  <AlignRight aria-hidden="true" />
                </IconButton>
              </span>
              <ImageProperties {...props} />
            </span>
            <span className="lx-md-resize-handle" data-side="left" onPointerDown={(event) => startResize("left", event)} aria-hidden="true" />
            <span className="lx-md-resize-handle" data-side="right" onPointerDown={(event) => startResize("right", event)} aria-hidden="true" />
          </>
        )}
      </span>
    </NodeViewWrapper>
  );
}

/** Source and description, committed as typed; closing rests the caret right after the image. */
function ImageProperties(props: NodeViewProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState(String(props.node.attrs.src ?? ""));
  const [alt, setAlt] = useState(String(props.node.attrs.alt ?? ""));
  const close = () => {
    setOpen(false);
    const position = props.getPos();
    if (typeof position !== "number") return;
    const { state } = props.editor;
    const after = Math.min(position + props.node.nodeSize, state.doc.content.size);
    props.editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, after)));
    props.editor.view.focus();
  };
  const keys = useCommitKeys(close, close);
  const update = (attrs: Record<string, unknown>) => setNodeAttrs(props.editor, props.getPos, props.node, attrs);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSrc(String(props.node.attrs.src ?? ""));
          setAlt(String(props.node.attrs.alt ?? ""));
          setOpen(true);
        } else {
          close();
        }
      }}
    >
      <PopoverTrigger asChild>
        <IconButton size="compact" tooltip={false} label={t`Image properties`}>
          <Settings2 aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="lx-md-popover w-72" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div className="lx-md-properties" data-properties="image">
          <Field label={t`Source`}>
            <Input
              autoFocus
              controlSize="compact"
              aria-label={t`Image source`}
              value={src}
              spellCheck={false}
              onChange={(event) => {
                setSrc(event.target.value);
                update({ src: event.target.value });
              }}
              {...keys}
            />
          </Field>
          <Field label={t`Description`}>
            <Input
              controlSize="compact"
              aria-label={t`Alt text`}
              value={alt}
              onChange={(event) => {
                setAlt(event.target.value);
                update({ alt: event.target.value || null });
              }}
              {...keys}
            />
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const figureKey = new PluginKey<DecorationSet>("latticeImageFigures");

function figureDecorations(doc: PmNode, from = 0, to = doc.content.size): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== "paragraph") return !node.isTextblock;
    const only = node.childCount === 1 ? node.firstChild : null;
    if (only?.type.name === "image") {
      decorations.push(Decoration.node(position, position + node.nodeSize, {
        class: "lx-md-figure",
        "data-align": String(only.attrs.align ?? "center"),
      }));
    }
    return false;
  });
  return decorations;
}

/** Map the figure marks and look again only at the blocks the transaction touched. */
function updateFigures(set: DecorationSet, transaction: Transaction): DecorationSet {
  let next = set.map(transaction.mapping, transaction.doc);
  for (const range of changedBlockRanges(transaction)) {
    next = next.remove(next.find(range.from, range.to));
    next = next.add(transaction.doc, figureDecorations(transaction.doc, range.from, range.to));
  }
  return next;
}

/** Marks paragraphs that hold nothing but an image, so the image aligns as a figure. */
export const ImageFigures = Extension.create({
  name: "latticeImageFigures",
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key: figureKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, figureDecorations(state.doc)),
      apply: (transaction, set) => (transaction.docChanged ? updateFigures(set, transaction) : set),
    },
    props: { decorations: (state) => figureKey.getState(state) },
  })],
});
