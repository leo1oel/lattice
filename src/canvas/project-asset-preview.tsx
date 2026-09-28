import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { FileText, Image } from "lucide-react";
import { ScrollArea } from "../components/ui/scroll-area";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { pdfBase64ToBytes } from "../pdf/pdf-bytes";
import type { AssetPreview, FileViewState, ImageFileViewState } from "../app-types";
import { useLatest } from "../app/effect-helpers";
import { PdfPreview, PdfPreviewLoading } from "./canvas-lazy-editors";
import { useZoomScale } from "./use-zoom-scale";
import { ZoomControls } from "./zoom-controls";

const IMAGE_MIN_SCALE = 0.3;
const IMAGE_MAX_SCALE = 5;

function imageViewState(viewport: HTMLElement | null, scale: number): ImageFileViewState {
  return { scale, scrollTop: viewport?.scrollTop ?? 0, scrollLeft: viewport?.scrollLeft ?? 0 };
}

/** A project image or PDF figure, with its zoom and scroll position kept as per-file view state. */
export function ProjectAssetPreview({ asset, viewState, onViewState }: {
  asset: AssetPreview;
  viewState?: FileViewState;
  onViewState?: (update: Partial<FileViewState>) => void;
}) {
  const { t } = useLingui();
  const url = `data:${asset.mimeType};base64,${asset.base64}`;
  const [initialImageViewState] = useState(viewState?.image);
  const [scale, updateScale] = useZoomScale(initialImageViewState?.scale ?? 1, IMAGE_MIN_SCALE, IMAGE_MAX_SCALE);
  const scaleRef = useLatest(scale);
  const onViewStateRef = useLatest(onViewState);
  const stageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageViewRestoredRef = useRef(false);
  const isPdf = asset.mimeType === "application/pdf";
  useLayoutEffect(() => {
    if (isPdf) return;
    const viewport = stageViewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(() => {
      if (initialImageViewState) {
        viewport.scrollTop = initialImageViewState.scrollTop;
        viewport.scrollLeft = initialImageViewState.scrollLeft ?? 0;
      }
      imageViewRestoredRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isPdf, initialImageViewState]);
  useEffect(() => {
    if (!imageViewRestoredRef.current || isPdf) return;
    onViewStateRef.current?.({ image: imageViewState(stageViewportRef.current, scale) });
  }, [isPdf, onViewStateRef, scale]);
  useEffect(() => () => {
    const viewport = stageViewportRef.current;
    if (!imageViewRestoredRef.current || isPdf) return;
    onViewStateRef.current?.({ image: imageViewState(viewport, scaleRef.current) });
  }, [isPdf, onViewStateRef, scaleRef]);
  useNonPassiveWheel(stageViewportRef, (event) => {
    if (!(event.metaKey || event.ctrlKey) || !event.deltaY) return;
    event.preventDefault();
    updateScale((current) => Number((current * Math.exp(-event.deltaY * 0.01)).toFixed(3)));
  });
  if (isPdf) {
    return (
      <Suspense fallback={<PdfPreviewLoading />}>
        <PdfPreview
          key={url}
          url={url}
          pdfBase64={asset.base64}
          pdfBytes={pdfBase64ToBytes(asset.base64).buffer}
          fileName={asset.path.split("/").pop() ?? "figure.pdf"}
          initialViewState={viewState?.pdf}
          onViewState={(pdf) => onViewStateRef.current?.({ pdf })}
        />
      </Suspense>
    );
  }
  const image = asset.mimeType.startsWith("image/");
  return (
    <div className="asset-preview">
      <div className="asset-preview-heading">
        <Image size={14} />
        <span>{asset.path}</span>
        <small>{t`Drop project files here to open them, or drag this into a TeX or Markdown editor to insert it`}</small>
        {image && (
          <ZoomControls
            className="asset-preview-zoom-controls"
            scale={scale}
            min={IMAGE_MIN_SCALE}
            max={IMAGE_MAX_SCALE}
            onScale={updateScale}
            inputLabel={t`Image zoom percentage`}
          />
        )}
      </div>
      <ScrollArea
        className="asset-preview-stage"
        orientation="both"
        contentClassName="asset-preview-stage-content"
        viewportRef={stageViewportRef}
        viewportProps={{
          onScroll: (event) => {
            if (imageViewRestoredRef.current) {
              onViewStateRef.current?.({ image: imageViewState(event.currentTarget, scaleRef.current) });
            }
          },
        }}
      >
        {image
          ? <img src={url} alt={t({ message: `Preview of ${{ path: asset.path }}` })} style={{ zoom: scale }} />
          : <div className="asset-preview-unsupported"><FileText size={28} /><p>{t`This format cannot be rendered in the preview`}</p></div>}
      </ScrollArea>
    </div>
  );
}
