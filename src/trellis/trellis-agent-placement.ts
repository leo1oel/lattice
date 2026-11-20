import { useLayoutEffect, type RefObject } from "react";

type Bounds = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;

const surfaceSelector = '[data-trellis-part="surface"]';
const coveringParts = '[data-trellis-part="panel"], [data-trellis-part="tabbar"][data-overlay]';

function intersect(a: Bounds, b: Bounds): Bounds | null {
  const intersection = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return intersection.left < intersection.right && intersection.top < intersection.bottom ? intersection : null;
}

/** Divide a visible rectangle into the strips around a covering panel. */
function subtract(rect: Bounds, occluder: Bounds): Bounds[] {
  const overlap = intersect(rect, occluder);
  if (!overlap) return [rect];
  return [
    { ...rect, bottom: overlap.top },
    { ...overlap, left: rect.left, right: overlap.left },
    { ...overlap, left: overlap.right, right: rect.right },
    { ...rect, top: overlap.bottom },
  ].filter((strip) => strip.left < strip.right && strip.top < strip.bottom);
}

/** The Trellis stage clips some floating surfaces with an inline px inset. */
function clippedBounds(node: HTMLElement): Bounds {
  const rect = node.getBoundingClientRect();
  const inset = /^inset\(([-.\d]+)px ([-.\d]+)px ([-.\d]+)px ([-.\d]+)px\)$/.exec(node.style.clipPath);
  if (!inset) return rect;
  const [, topInset, rightInset, bottomInset, leftInset] = inset.map(Number);
  return {
    left: rect.left + leftInset, top: rect.top + topInset,
    right: rect.right - rightInset, bottom: rect.bottom - bottomInset,
  };
}

function clipPath(rectangles: Bounds[], origin: Bounds) {
  const paths = rectangles.map((rectangle) => {
    const x1 = rectangle.left - origin.left;
    const y1 = rectangle.top - origin.top;
    const x2 = rectangle.right - origin.left;
    const y2 = rectangle.bottom - origin.top;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS path command
    return `M ${x1} ${y1} H ${x2} V ${y2} H ${x1} Z`;
  });
  // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS function syntax
  return `path("${paths.join(" ")}")`;
}

/**
 * Present the persistent Agent layer over Trellis's slot. A project switch
 * rebuilds the workspace and detaches every slot host. The iframe stays
 * in one connected document through that operation.
 */
export function useTrellisAgentPlacement(
  layerRef: RefObject<HTMLDivElement | null>, anchor?: HTMLElement,
) {
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || !anchor) return;
    const workspace = layer.parentElement;
    if (!workspace) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const surface = anchor.closest<HTMLElement>(surfaceSelector);
      const trellis = surface?.closest<HTMLElement>(".trellis");
      const rect = anchor.getBoundingClientRect();
      const slotShown = Boolean(surface && trellis && surface.style.visibility !== "hidden");
      const clipped = slotShown && surface && trellis
        && intersect(clippedBounds(surface), trellis.getBoundingClientRect());
      const bounds = clipped && intersect(rect, clipped);
      let visible = bounds ? [bounds] : [];
      if (trellis && surface && bounds) {
        const agentZ = Number(surface.style.zIndex);
        for (const panel of trellis.querySelectorAll<HTMLElement>(coveringParts)) {
          if (Number(panel.style.zIndex) <= agentZ || panel.style.display === "none") continue;
          const covered = clippedBounds(panel);
          visible = visible.flatMap((region) => subtract(region, covered));
        }
      }
      const positioned = visible.length > 0;
      layer.toggleAttribute("data-positioned", positioned);
      // CSS hides an unplaced layer. One whose slot is hidden, detached or
      // covered leaves focus and the accessibility tree too, or its loading
      // status sits beside the shown panel's. A shown slot without a size yet
      // is left to CSS: browsers keep `visibility: hidden` out of that tree.
      const away = !slotShown || (Boolean(bounds) && !positioned);
      layer.toggleAttribute("inert", away);
      if (away) layer.setAttribute("aria-hidden", "true");
      else layer.removeAttribute("aria-hidden");
      if (!positioned) return;

      // The shell's containing block is the viewport. Trellis content may
      // retain its old size during a drag; clip it to the actual surface.
      Object.assign(layer.style, {
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        opacity: surface?.style.opacity || "1",
        clipPath: clipPath(visible, rect),
        pointerEvents: trellis?.hasAttribute("data-busy") ? "none" : "",
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(place);
    };
    const changes = new MutationObserver((records) => {
      if (records.some(({ target }) => target === workspace || (target instanceof Element
        && target !== layer && target.matches(".lattice-trellis, .trellis, .trellis-layer, [data-trellis-part], .trellis-agent")))) {
        schedule();
      }
    });
    changes.observe(workspace, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["style", "data-busy", "data-dragging"],
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(workspace);
    resize?.observe(anchor);
    window.addEventListener("resize", schedule);
    place();
    return () => {
      for (const name of ["data-positioned", "inert", "aria-hidden"]) layer.removeAttribute(name);
      changes.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [anchor, layerRef]);
}
