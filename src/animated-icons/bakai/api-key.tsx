// API Key, from the Phosphor-derived set built for the /linear-app sidebar.
//
// Phosphor ships each icon as ONE compound path, so nothing inside it can be animated
// independently. This is rebuilt from Phosphor's own fill geometry — same 256 viewBox,
// same coordinates, read straight out of the package — split into the pieces the gesture
// needs. At rest it is meant to be indistinguishable from the original; only the seams
// are new. Where a gesture only ADDS something (a spark leaving a bolt), the Phosphor
// glyph is left completely untouched and the new element is drawn beside it — always the
// safer route, and preferred wherever it works.

type P = { size?: number; className?: string };

/* ── API keys: the key is given real thickness ────────────────────────────────
   A flat plane seen edge-on is a LINE. That is geometry, not a tuning problem —
   no easing fixes it, and it is why a naive CSS coin flip always reads as a
   vertical squash rather than a tumble. Halfway through every half-turn the
   object simply has no area left.

   So the key stops being a plane. Phosphor's Key path is stacked LAYERS deep
   along Z inside a preserve-3d wrapper, which is the CSS equivalent of an
   extrusion: face-on the copies land on top of each other and you see one key,
   edge-on you see the stack side-by-side as a solid bar, and in between you see
   a genuine extruded edge. Every copy is Phosphor's path verbatim — the glyph
   is not redrawn, only repeated.

   DEPTH is 13% of the icon, which is a lie. A real key is about 1:25 thick to
   long, which at 16px is 0.6px: invisible. Exaggerated until the edge reads as
   an edge.

   THE COUNTER-SCALE is the part that is easy to get wrong. Under perspective a
   layer at +z projects larger by P/(P-z), so a naive stack is subtly BOLDER at
   rest than the original icon — the near copies spill outside the far ones.
   Pre-scaling each layer by (P-z)/P cancels that exactly, so at rest all seven
   project to precisely the same rectangle and the icon is indistinguishable
   from a single flat Key. The depth only appears once it turns.

   Perspective lives on this wrapper, not on the parent, so the component owns
   both P and the counter-scale that depends on it and they cannot drift apart. */
const KEY_D =
    "M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM180,92a16,16,0,1,1,16-16A16,16,0,0,1,180,92Z";
const KEY_LAYERS = 7;
const KEY_P = 90; // perspective, px

export function KeyLive({ size = 16, className }: P) {
    const step = (size * 0.13) / (KEY_LAYERS - 1);
    const mid = (KEY_LAYERS - 1) / 2;
    return (
        <span className={`lgk${className ? ` ${className}` : ""}`} style={{ width: size, height: size, perspective: `${KEY_P}px` }}>
            {/* Two nested wrappers, and the NESTING is the point. The key has to
                be levelled BEFORE it is flipped, and CSS applies a parent's
                transform after the child's — so the tilt must live inside the
                spin, not beside it. Flat on one element (rotateX() rotate())
                would also compose correctly, but then both share a single timing
                function per segment, and the flip has to stay linear while the
                tilt eases. Separate elements, separate clocks. */}
            <span className="lgk-spin">
                <span className="lgk-tilt">
                {Array.from({ length: KEY_LAYERS }, (_, i) => {
                    const z = (i - mid) * step;
                    // The side is LIGHTER than the faces, not darker. Darkening it
                    // was the obvious move and it was wrong: the faces are already
                    // dark on a light sidebar, so a dark edge merges with them and
                    // the whole turned key collapses into one fat black blob with
                    // no depth cue at all. Lifting the core toward white is what
                    // separates face from edge, and it is also what a real edge
                    // does — it is the surface that catches the light.
                    //
                    // SYMMETRIC about the middle rather than a front-to-back ramp.
                    // A ramp would make the far face the pale one, so every
                    // half-turn the key would change colour, which on an icon
                    // reads as a flicker rather than as lighting. Both outer faces
                    // staying full currentColor means whichever face you are shown
                    // is exactly the icon at rest, and only the core lifts: the
                    // part visible solely when it is turned, i.e. the EDGE.
                    //
                    // Falls off as a curve, not a line, so the pale core carries
                    // most of the way out and only tightens up near the faces —
                    // that reads as one rounded lit edge instead of a sandwich.
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
