/* ── API keys (Phosphor Key, fill): the key is given real thickness ────────────
   A flat plane seen edge-on is a LINE, which is why a naive CSS coin flip reads
   as a vertical squash rather than a tumble. So Phosphor's Key path (verbatim)
   is stacked LAYERS deep along Z inside a preserve-3d wrapper — an extrusion:
   face-on the copies coincide into one key, edge-on they form a solid bar.

   DEPTH is 13% of the icon: a real key's ~1:25 thickness is invisible at 16px,
   so it is exaggerated until the edge reads as an edge.

   THE COUNTER-SCALE: under perspective a layer at +z projects larger by
   P/(P-z), so a naive stack is subtly BOLDER at rest than the original icon.
   Pre-scaling each layer by (P-z)/P cancels that exactly, so at rest all seven
   project to precisely the same rectangle. Perspective lives on this wrapper,
   not the parent, so the component owns both P and the counter-scale that
   depends on it and they cannot drift apart. */
const KEY_D =
    "M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM180,92a16,16,0,1,1,16-16A16,16,0,0,1,180,92Z";
const KEY_LAYERS = 7;
const KEY_P = 90; // perspective, px

export function KeyLive({ size = 16, className }: { size?: number; className?: string }) {
    const step = (size * 0.13) / (KEY_LAYERS - 1);
    const mid = (KEY_LAYERS - 1) / 2;
    return (
        <span className={`lgk${className ? ` ${className}` : ""}`} style={{ width: size, height: size, perspective: `${KEY_P}px` }}>
            {/* Two nested wrappers: the key must be levelled BEFORE it is flipped,
                and CSS applies a parent's transform after the child's, so the
                tilt lives inside the spin. Separate elements also give separate
                timing functions — the flip stays linear while the tilt eases. */}
            <span className="lgk-spin">
                <span className="lgk-tilt">
                {Array.from({ length: KEY_LAYERS }, (_, i) => {
                    const z = (i - mid) * step;
                    // The core is LIGHTER than the faces: a dark edge merges with
                    // dark faces on a light sidebar into one blob with no depth
                    // cue. Symmetric about the middle (not a front-to-back ramp)
                    // so both outer faces stay full currentColor — whichever face
                    // shows is exactly the icon at rest — and only the edge lifts.
                    // Falls off as a curve so it reads as one rounded lit edge.
                    const shade = Math.round(52 * (1 - Math.pow(Math.abs(i - mid) / mid, 1.6)));
                    return (
                        <svg
                            key={i}
                            className="lgk-l"
                            width={size}
                            height={size}
                            viewBox="0 0 256 256"
                            fill={shade ? `color-mix(in srgb, currentColor, #fff ${shade}%)` : "currentColor"}
                            style={{ transform: `translateZ(${z.toFixed(3)}px) scale(${((KEY_P - z) / KEY_P).toFixed(5)})` }}
                        >
                            <path d={KEY_D} />
                        </svg>
                    );
                })}
                </span>
            </span>
        </span>
    );
}
