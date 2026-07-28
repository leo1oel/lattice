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

export const KEY_CSS = `
/* API keys: the key is flicked up, tumbles, and is caught.

   "Rotating" a key is the actual term for cycling an API credential, so a key
   that literally rotates is the one gesture here that is a pun a developer reads
   without being told it is one.

   It is TWO animations on two elements, and that split is the entire point.
   translateY and rotateX both live in the one transform property, so on a single
   element CSS forces them to share one timing function — and this gesture needs
   two opposite ones. So the arc goes on the span and the spin goes on the svg
   inside it.

   THE ARC is gravity, and gravity is a parabola, not a swing:
     up    p(t) = 2t - t²   decelerating into the apex
     down  p(t) = t²        accelerating out of it
   Those two curves are what the beziers below are fitted to (a bezier's start
   slope is y1/x1 and its end slope is (1-y2)/(1-x2); the rise wants 2 and 0, the
   fall wants 0 and 2). Rise and fall get the same 44% so the parabola is
   symmetric, which is the thing your eye actually checks.

   THE SPIN is linear, and it is the detail that separates a toss from a flip.
   Once the key leaves your thumb nothing torques it, so its angular velocity is
   constant. Easing the spin is the single most common tell of a fake coin flip.
   This is one of the very few places in UI where linear is not a mistake.

   Three full turns, so it lands on the face it left with and the end frame is
   the start frame. perspective() is what makes it a tumble rather than a
   vertical squash: the edge swinging toward you grows, the far edge shrinks. */
/* The transition is not decoration, it is the hover-OUT. Sweep off the row
   mid-flip and the animation is simply removed, which would snap the key from
   450deg to 0 in one frame. With a transition here the browser decomposes the
   two matrices and slerps the shortest way home instead, so an interrupted toss
   settles rather than teleports. The span gets this for free from .ln-ico; the
   svg is a separate element and needs its own. */
.lgk { position: relative; display: block; flex: none; }
.lgk-l { position: absolute; left: 0; top: 0; }
/* The transition is not decoration, it is the hover-OUT. Sweep off the row
   mid-flip and the animation is simply removed, which would snap the key from
   450deg to 0 in one frame. With a transition here the browser decomposes the
   two matrices and slerps the shortest way home instead, so an interrupted toss
   settles rather than teleports. The span gets its own from .ln-ico; this is the
   spin's. */
.lgk-tilt { position: absolute; inset: 0; transform-style: preserve-3d; }
.lgk-spin { position: absolute; inset: 0; transform-style: preserve-3d;
  transition: transform 0.19s cubic-bezier(0.19,1,0.22,1); }

@keyframes lg-toss-arc {
  /* the wind-up. 50ms and a pixel and a half, but a throw with no anticipation
     reads as an object teleporting upward — you need to see it loaded first. */
  0%   { transform: translateY(0); animation-timing-function: cubic-bezier(0.4, 0, 0.7, 1); }
  7%   { transform: translateY(1.5px); animation-timing-function: cubic-bezier(0.33, 0.66, 0.67, 1); }
  /* apex. rise 41%, fall 40% — near enough symmetric that the parabola reads */
  48%  { transform: translateY(-7px); animation-timing-function: cubic-bezier(0.33, 0, 0.67, 0.34); }
  /* caught, and the hand gives a pixel absorbing it */
  88%  { transform: translateY(0); animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); }
  93%  { transform: translateY(1px); animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); }
  100% { transform: translateY(0); }
}
/* The key levels itself, THEN flips. That order is the whole fix.

   Phosphor draws the key on an exact 45 degree diagonal — the shaft leaves the
   bow at (83.91,120.78) and runs to (28.69,176), which is dx -55.22, dy +55.22.
   So a plain rotateX was cutting across the key at 45 degrees to its own length,
   which is why it read as the picture being squashed rather than an object
   turning. rotate(45deg) is not a taste value, it is exactly that diagonal
   cancelled out, and it lands the shaft dead horizontal with the bow on the right.

   Once it is level, a vertical flip rolls it about its OWN LENGTH. That is the
   one view where the extruded stack pays off completely: instead of a hairline,
   edge-on is the pale edge running the entire length of the key. Levelling first
   is what turns the thickness from a detail into the point of the shot. */
@keyframes lg-toss-tilt {
  0%   { transform: rotate(0deg); animation-timing-function: cubic-bezier(0.25, 0.9, 0.3, 1); }
  /* level by the time it leaves the hand */
  11%  { transform: rotate(45deg); }
  76%  { transform: rotate(45deg); animation-timing-function: cubic-bezier(0.5, 0, 0.3, 1); }
  /* and back to its resting diagonal as it is caught */
  90%  { transform: rotate(0deg); }
  100% { transform: rotate(0deg); }
}

/* The flip itself: plain rotateX, now that the tilt has levelled the key for it.
   1080 is three whole turns, so it lands exactly on identity and the last frame
   is the resting frame. */
@keyframes lg-toss-spin {
  /* held, and compressed slightly, for exactly as long as the wind-up lasts. A
     key still in your hand is not rotating yet. */
  0%   { transform: rotateX(0deg) scaleY(1); }
  7%   { transform: rotateX(0deg) scaleY(0.9); animation-timing-function: linear; }
  /* released. 66.67deg is not a taste number: it is 1080 x 5/81, i.e. exactly
     where the linear ramp is at 12%. Stating it keeps the spin rate constant
     across this keyframe instead of kinking at it. */
  12%  { transform: rotateX(66.67deg) scaleY(1); animation-timing-function: linear; }
  /* caught. The spin stops dead here because a caught key does stop dead; the
     softness belongs in the squash that follows, not in the rotation. */
  88%  { transform: rotateX(1080deg) scaleY(1);
         animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); }
  93%  { transform: rotateX(1080deg) scaleY(0.84);
         animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); }
  100% { transform: rotateX(1080deg) scaleY(1); }
}
`;