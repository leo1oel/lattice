/**
 * Image — DIY renderer for the lowercase `img` canonical.
 *
 * Renders the descriptor's 12-prop surface — 2 common (src + alt) + 10
 * advanced (width + height + srcset + sizes + loading + title + decoding +
 * fetchpriority + crossorigin + referrerpolicy) — wrapped in
 * `react-medium-image-zoom`'s `Zoom` always-on (no descriptor prop). Pixel
 * `width` / `height` are layout-shift specialists; most authors lay images
 * out via CSS or container width and don't pin pixel dimensions. When
 * Frame v2 lands as a compositional wrapper, `<Frame zoom={false}>` will be
 * the opt-out path; today there is no opt-out.
 *
 * `wrapElement="span"` is load-bearing: HTML spec forbids `<div>` inside
 * `<p>`, and MDX parsing often lands `<img>` inside a paragraph (tight image
 * links, markdown `![alt](src)` after autolink/CommonMark promotion).
 *
 * `zoomMargin={20}` matches the upstream-docs-lib default — the zoom-modal's
 * padding from the viewport edge when expanded. `zoomImg={{ sizes: undefined }}`
 * forces the zoom-view image to NOT inherit the authored `sizes` attribute
 * (which would constrain the zoomed rendering to the thumbnail's breakpoints).
 *
 * `loading` defaults to `'lazy'` when undefined — matches browser-default
 * behavior for images below the fold but avoids silently loading any image
 * eagerly on mount.
 *
 * `caption` is NOT a prop on this descriptor — Frame v2 (compositional
 * wrapper) is the canonical home for caption + border + decorations.
 *
 * HTML-attr lowercase ↔ React camelCase translation happens here at the JSX
 * boundary: `srcset → srcSet`, `fetchpriority → fetchPriority`,
 * `crossorigin → crossOrigin`, `referrerpolicy → referrerPolicy`. The
 * descriptor stores the HTML-spec spelling so emitted MDX matches the spec
 * exactly; React's intrinsic `<img>` type expects camelCase.
 */

import { toDesktopAssetHref } from '@ok-core';
import type { ImgHTMLAttributes } from 'react';
import { useEffect, useRef } from 'react';
import Zoom from 'react-medium-image-zoom';
import { LoadingImage } from '@ok-app/components/ui/loading-image';
import { useProjectImageSrc } from '../../../project-image-host';
import { useJsxComponentHost } from './jsx-host-context.tsx';
import { ResizeHandles } from './ResizeHandles.tsx';
import { useNearViewport } from '../../../use-near-viewport';

interface ImageProps {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
  title?: string;
  loading?: 'eager' | 'lazy';
  // advanced — HTML-native attrs, lowercase per the HTML spec
  srcset?: string;
  sizes?: string;
  decoding?: 'sync' | 'async' | 'auto';
  fetchpriority?: 'high' | 'low' | 'auto';
  crossorigin?: '' | 'anonymous' | 'use-credentials';
  referrerpolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
}

function resolveLoading(loading: 'eager' | 'lazy' | undefined): 'eager' | 'lazy' {
  return loading ?? 'lazy';
}

function coerceDimension(value: number | string | undefined): number | string | undefined {
  if (typeof value !== 'string') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : value;
}

/**
 * Bare `<img>` — the leaf rendered inside `<Zoom>`. Delegates to LoadingImage
 * so the rendered DOM reserves layout space and shows a Skeleton placeholder
 * until the inner `<img>.load` event fires, then swaps to the loaded image
 * without document reflow. Translates lowercase HTML-attr names to React's
 * camelCase at this JSX boundary.
 */
function BareImg(props: ImageProps) {
  const { nearViewport, viewportRef } = useNearViewport<HTMLSpanElement>();
  const src = useProjectImageSrc(props.src, nearViewport);
  const image = (
    <LoadingImage
      slotRef={viewportRef}
      src={src === undefined ? undefined : toDesktopAssetHref(src)}
      alt={props.alt ?? ''}
      width={coerceDimension(props.width)}
      height={coerceDimension(props.height)}
      title={props.title}
      loading={src && src !== props.src ? 'eager' : resolveLoading(props.loading)}
      srcSet={nearViewport ? props.srcset : undefined}
      sizes={props.sizes}
      decoding={props.decoding ?? 'async'}
      fetchPriority={props.fetchpriority}
      crossOrigin={props.crossorigin}
      referrerPolicy={props.referrerpolicy}
    />
  );
  return nearViewport && src ? (
    <Zoom wrapElement="span" zoomMargin={20} zoomImg={{ sizes: undefined }}>
      {image}
    </Zoom>
  ) : image;
}

/**
 * DIY Image. Descriptor-dispatched via `componentMap['img']`.
 *
 * The `Zoom` wrapper reads its child `<img>`'s `src` to build the zoom-view;
 * no manual `zoomImg.src` plumbing needed. We override `sizes` to `undefined`
 * so the zoom-view doesn't inherit a thumbnail-scoped sizes attribute.
 */
export function Image(props: ImageProps) {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const host = useJsxComponentHost();
  const width = coerceDimension(props.width);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.style.width = width === undefined ? '' : typeof width === 'number' ? `${width}px` : width;
  }, [width]);

  const writeSize = (next: { width: number; height: number }) => {
    if (!host) return;
    const pos = host.getPos();
    if (typeof pos !== 'number') return;
    try {
      const node = host.editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return;
      const currentProps = (node.attrs.props as Record<string, unknown>) ?? {};
      const { sourceUrl, height: _height, ...persistedProps } = currentProps;
      host.editor.view.dispatch(
        host.editor.state.tr.setNodeMarkup(pos, null, {
          ...node.attrs,
          // CommonMark image syntax has no dimensions. The first resize
          // upgrades it to the canonical HTML image while preserving all
          // existing image props.
          componentName: node.attrs.componentName === 'CommonMarkImage' ? 'img' : node.attrs.componentName,
          props: {
            ...persistedProps,
            // The parser may resolve a document-relative src for rendering
            // and retain its authored form in sourceUrl. The canonical img
            // descriptor has no sourceUrl prop, so restore that authored path
            // instead of leaking either internal field into saved MDX.
            ...(typeof sourceUrl === 'string' ? { src: sourceUrl } : {}),
            width: Math.round(next.width),
          },
          sourceDirty: true,
        }),
      );
    } catch (error) {
      // A collaborative edit can remove the node between pointer-down and
      // pointer-up. In that case there is no image left to resize.
      if (error instanceof RangeError) return;
      throw error;
    }
  };

  return (
    <span
      ref={wrapperRef}
      className="ok-image-resizable"
      style={{ width }}
      contentEditable={false}
    >
      <BareImg {...props} width={undefined} height={undefined} />
      {host ? (
        <ResizeHandles
          targetRef={wrapperRef}
          handles={['l', 'r']}
          bounds={{
            minWidth: 64,
            maxWidth: 2000,
          }}
          onResize={(next) => {
            const wrapper = wrapperRef.current;
            if (!wrapper) return;
            wrapper.style.width = `${next.width}px`;
          }}
          onResizeEnd={writeSize}
        />
      ) : null}
    </span>
  );
}
