import { useLingui } from '@ok-app/shims/lingui-react-macro';
import { ImageOff } from 'lucide-react';
import type { CSSProperties, ImgHTMLAttributes, Ref } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OPT_OUT_ATTR } from '@ok-app/editor/clipboard/clipboard-sanitize';
import { cn } from '@ok-app/lib/utils';

type LoadingImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  width?: number | string;
  height?: number | string;
  loadingTestId?: string;
  slotTestId?: string;
  slotClassName?: string;
  slotRef?: Ref<HTMLSpanElement>;
  /** Inventory-known target state, distinct from whether the browser decoded it. */
  targetExistence?: 'unknown' | 'exists' | 'missing';
};

type ImageErrorKind = 'not-found' | 'undisplayable' | null;

// Project images now remount with the same resolved data URL. Retaining the
// terminal state for that exact URL prevents a fresh img element from showing
// the fallback slot while the browser revalidates its decoded-image cache.
const loadedImageSources = new Map<string, true>();
const LOADED_IMAGE_SOURCE_LIMIT = 128;

function rememberLoadedImageSource(src: string | undefined) {
  if (!src) return;
  const key = imageSourceCacheKey(src);
  loadedImageSources.delete(key);
  loadedImageSources.set(key, true);
  while (loadedImageSources.size > LOADED_IMAGE_SOURCE_LIMIT) {
    const oldest = loadedImageSources.keys().next().value;
    if (oldest === undefined) break;
    loadedImageSources.delete(oldest);
  }
}

function imageSourceCacheKey(src: string): string {
  if (!src.startsWith('data:') || src.length <= 256) return src;
  return `${src.slice(0, 72)}:${src.length}:${src.slice(-72)}`;
}

function hasIntrinsicDimensions(
  width: number | string | undefined,
  height: number | string | undefined,
): width is number {
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
}

function computeSlotStyle(
  width: number | string | undefined,
  height: number | string | undefined,
  inherited: CSSProperties | undefined,
): CSSProperties | undefined {
  if (hasIntrinsicDimensions(width, height)) {
    return {
      ...inherited,
      width: `${width}px`,
      aspectRatio: `${width} / ${height}`,
    };
  }
  return inherited;
}

export function LoadingImage({
  width,
  height,
  loadingTestId = 'image-loading-skeleton',
  slotTestId = 'image-slot',
  slotClassName,
  slotRef,
  className,
  onLoad,
  onError,
  src,
  style,
  alt = '',
  targetExistence = 'unknown',
  ...imgProps
}: LoadingImageProps) {
  const { t } = useLingui();
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(() => Boolean(src && loadedImageSources.has(imageSourceCacheKey(src))));
  const [hasError, setHasError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const intrinsic = hasIntrinsicDimensions(width, height);
  const slotStyle = computeSlotStyle(width, height, style);

  // Cached or preloaded images may be `complete` at mount and never fire
  // onLoad after React commits — the skeleton would otherwise persist
  // forever and the <img> stay stuck at opacity-0. Treating `complete` as
  // the terminal-state signal dismisses the skeleton in that case.
  // Re-running on src change resets both flags when the same instance is
  // reused with a new src (e.g. AssetPreview switching assets).
  // biome-ignore lint/correctness/useExhaustiveDependencies: src drives the reactive trigger only; the effect body reads imgRef.current so biome flags src as unused.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (src && (loadedImageSources.has(imageSourceCacheKey(src)) || img?.complete)) {
      setLoaded(true);
    } else {
      setLoaded(false);
    }
    // NOTE: don't try to infer error from `complete && naturalWidth === 0`
    // — per the HTML spec that shape is also produced by a successful
    // load of a dimensionless resource (SVG with only a viewBox, images
    // sized by CSS). onError is the only unambiguous signal.
    setHasError(false);
  }, [src, reloadNonce]);

  // A previously missing target can be created without changing its authored
  // path. Remount the image when inventory truth changes so Chromium retries a
  // request it may otherwise retain as a failed load.
  const prevExistenceRef = useRef(targetExistence);
  useEffect(() => {
    const previous = prevExistenceRef.current;
    prevExistenceRef.current = targetExistence;
    if (previous === 'missing' && targetExistence !== 'missing') {
      setLoaded(false);
      setHasError(false);
      setReloadNonce((nonce) => nonce + 1);
    }
  }, [targetExistence]);

  const errorKind: ImageErrorKind =
    targetExistence === 'missing' ? 'not-found' : hasError ? 'undisplayable' : null;

  // A visible placeholder overlay replaces the browser's default 16x16
  // broken-image glyph so the reader can tell the asset is missing instead
  // of assuming the block rendered empty. The <img> stays mounted (hidden
  // via CSS) so consumers that inspect the DOM — clipboard walker, prop
  // panel, e2e tests reading img.src — still find it with the authored
  // src, matching the storage-layer fidelity contract (bytes land verbatim
  // in the CRDT even when the render layer shows a fallback).
  //
  // Always announce on error: `alt` at this layer conflates "author opted
  // in to decorative" with "no alt was authored" (Image.tsx coerces
  // `props.alt ?? ''`, and `![](/x.png)` markdown reaches here with
  // alt=''). Silencing the pill for alt='' would silence broken
  // no-alt-authored images too.
  const errorLabel = alt && alt.length > 0 ? alt : (src ?? '');
  const errorMessage =
    errorKind === 'not-found' ? t`Image not found` : t`Image couldn't be displayed`;
  const errorAriaLabel =
    errorKind === 'not-found'
      ? t`Image not found: ${errorLabel}`
      : t`Image couldn't be displayed: ${errorLabel}`;

  return (
    <span
      ref={slotRef}
      data-testid={slotTestId}
      data-image-error={errorKind ? 'true' : undefined}
      data-image-error-kind={errorKind ?? undefined}
      className={cn(
        'relative inline-block overflow-hidden',
        // Pre-load only: reserve a 16:9 slot to prevent the "0x0 box → reflow"
        // symptom. Post-load, release the constraint so a consumer's
        // object-contain / max-h-full styling can govern the image's
        // natural shape — otherwise sidebar previews would be locked at 16:9
        // forever, letterboxing portrait assets.
        !intrinsic && !loaded && !errorKind && 'aspect-[16/9] w-full max-w-full',
        slotClassName,
      )}
      style={slotStyle}
    >
      {!loaded && !errorKind && (
        // Inline-content the skeleton element directly rather than reaching for
        // shadcn `<Skeleton>` (which is a `<div>`). The slot is a `<span>`
        // because `Image.tsx`'s `<Zoom wrapElement="span">` constrains its
        // child to phrasing content (markdown often lands `<img>` inside `<p>`,
        // where `<div>` is forbidden). Reusing Skeleton's visual classes here
        // keeps the appearance identical while preserving the inline content
        // model.
        <span
          data-testid={loadingTestId}
          role="status"
          aria-busy="true"
          aria-label={t`Loading image`}
          className="absolute inset-0 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
        />
      )}
      <img
        {...imgProps}
        key={reloadNonce}
        ref={imgRef}
        src={src}
        alt={alt}
        width={width}
        height={height}
        // `hidden` keeps the img in the DOM (queryable by tests + the
        // clipboard walker) but out of the visual + a11y trees when the
        // error placeholder is showing.
        hidden={errorKind ? true : undefined}
        className={cn(
          'block max-w-full transition-opacity motion-reduce:transition-none',
          loaded ? 'opacity-100' : 'opacity-0',
          className,
        )}
        onLoad={(event) => {
          rememberLoadedImageSource(src);
          setLoaded(true);
          setHasError(false);
          onLoad?.(event);
        }}
        onError={(event) => {
          // Route into the placeholder overlay on next render — the
          // skeleton also dismisses so screen readers stop announcing
          // aria-busy="true" forever. Recording the src keeps a remount of
          // the same project image out of the skeleton state, which would
          // otherwise flash before this handler re-fires.
          rememberLoadedImageSource(src);
          setLoaded(true);
          setHasError(true);
          onError?.(event);
        }}
      />
      {errorKind && (
        <span
          role="img"
          aria-label={errorAriaLabel}
          // Render-layer chrome only: the clipboard walker strips opt-out
          // children from cross-app copies, so the pill text never pastes
          // as if it were document content. The hidden <img> sibling stays
          // in the clone and carries the authored src (the walker's
          // error-slot un-hide pass drops the hidden attr from the clone).
          {...{ [OPT_OUT_ATTR]: 'true' }}
          className="ok-image-error-placeholder box-border inline-grid max-w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 rounded-md border border-dashed border-border bg-muted/40 px-2 py-1 text-muted-foreground"
        >
          <ImageOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0">
            <span className="ok-image-error-message block text-xs font-medium">{errorMessage}</span>
            {src ? (
              <span
                className="ok-image-error-target block max-w-[24ch] truncate font-mono text-xs opacity-70"
                title={src}
              >
                {src}
              </span>
            ) : null}
          </span>
        </span>
      )}
    </span>
  );
}
