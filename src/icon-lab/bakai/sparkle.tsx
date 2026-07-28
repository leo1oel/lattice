// Sparkle, from the Phosphor-derived set built for the /linear-app sidebar.
//
// Phosphor ships each icon as ONE compound path, so nothing inside it can be animated
// independently. This is rebuilt from Phosphor's own fill geometry — same 256 viewBox,
// same coordinates, read straight out of the package — split into the pieces the gesture
// needs. At rest it is meant to be indistinguishable from the original; only the seams
// are new. Where a gesture only ADDS something (a spark leaving a bolt), the Phosphor
// glyph is left completely untouched and the new element is drawn beside it — always the
// safer route, and preferred wherever it works.

import { useId } from "react";

type P = { size?: number; className?: string };

/* ── Enrichments: the star blooms and ripples ─────────────────────────────────
   Phosphor's Sparkle fill is one compound path holding three subpaths, copied
   verbatim and only separated:

     the star     4-pointed, centred (112,144), 192 units across
     mark A       a plus centred (180,40)   — the big small one
     mark B       a plus centred (228,84)   — the little small one

   The number that makes the whole gesture possible: the star is 4-FOLD
   SYMMETRIC. 90°, 180° and 270° all map it onto itself exactly. So it can spin a
   half turn and hold there while hovered, and when you leave and the animation
   is torn off it snaps back to 0° — a snap you cannot see, because 180° and 0°
   are the same picture. A turn with no landing to hide.

   Inside it, two rings. They are the star's OWN outline, stroked instead of
   filled, and they live in a mask, so they act on the star rather than being
   drawn over it — which means they read correctly against whatever the row is
   tinted to, and a hardcoded colour would have been wrong.

   THE STROKE IS TRANSLUCENT, AND THAT IS THE WHOLE POINT. Opaque black in a
   mask cuts a HOLE, and at this size a hole wide enough to see turned the star
   into a thin hollow outline for a third of a second. The silhouette measured
   identical, but it stopped reading as the same glyph: at rest a solid spiky
   sparkle, mid-gesture a rounded hollow ring. Bakai caught it immediately.

   At 0.6 the ring only DIMS the star to ~40% along its path. Nothing is ever
   removed, so the shape is byte-identical to rest on every single frame, and
   what travels outward is a band of light rather than a cut. It also lifts the
   constraint the hole version was fighting: a cut had to stop short of the
   star's waist (tips are 96 units from centre, armpits only 48, so a hole near
   the outline severed the waist and left the corner floating as a detached
   hairline). A band that removes nothing can run all the way off the edge.

   vector-effect="non-scaling-stroke" keeps the band one constant width as it
   grows, instead of a stroke that fattens with the ring and reads as a shape
   inflating rather than a wave travelling.

   MIND THE UNITS. Chromium's non-scaling-stroke ignores the viewBox transform
   too, not just the element's own — so stroke-width is read in CSS PIXELS, not
   in the 256 user units everything else here is written in. Written as 20 (the
   number that would be right if viewBox scaling still applied) it came out a
   20px stroke on a 16px icon and ate the entire glyph. Hence size × 0.044:
   0.7px at sidebar size, stated in the only units this attribute listens to,
   and still proportional if the glyph is ever drawn larger. Thin matters as
   much as translucent — at 1.1px the band covered most of the star's interior
   at once and washed the middle out even without cutting it.                  */
const SPARK_STAR =
    "M208,144a15.78,15.78,0,0,1-10.42,14.94L146,178l-19,51.62a15.92,15.92,0,0,1-29.88,0L78,178l-51.62-19a15.92,15.92,0,0,1,0-29.88L78,110l19-51.62a15.92,15.92,0,0,1,29.88,0L146,110l51.62,19A15.78,15.78,0,0,1,208,144Z";
const SPARK_MARK_A = "M152,48h16V64a8,8,0,0,0,16,0V48h16a8,8,0,0,0,0-16H184V16a8,8,0,0,0-16,0V32H152a8,8,0,0,0,0,16Z";
const SPARK_MARK_B = "M240,80h-8V72a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8,8,0,0,0,16,0V96h8a8,8,0,0,0,0-16Z";

export function SparkleLive({ size = 16, className }: P) {
    /* per instance: this glyph renders on the board AND in the lab gallery,
       and url(#id) resolves document-wide, so a hardcoded id makes the second
       instance use the first one's mask (TECHNIQUE #6). */
    const sparkRingsId = "lgSparkRings-" + useId().replace(/[^a-zA-Z0-9]/g, "");
    return (
        // overflow visible: the marks overshoot ~0.3px past the top edge on their
        // way back in, and clipping that is the one thing that would read as a bug
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" overflow="visible" className={className}>
            {/* userSpaceOnUse with a generous region — the default is the bounding
                box plus 10%, which the outer ring would run straight through. */}
            <mask id={sparkRingsId} maskUnits="userSpaceOnUse" x="-32" y="-32" width="320" height="320">
                <rect x="-32" y="-32" width="320" height="320" fill="#fff" />
                {[1, 2].map((n) => (
                    <path
                        key={n}
                        className={`lgs-ring lgs-r${n}`}
                        d={SPARK_STAR}
                        fill="none"
                        stroke="#000"
                        strokeOpacity="0.6"
                        strokeWidth={size * 0.044}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
            </mask>
            {/* only the star is masked — the marks have their own beat and should
                not be dimmed by a wave that belongs to the star */}
            <g mask={`url(#${sparkRingsId})`}>
                <path className="lgs-star" d={SPARK_STAR} />
            </g>
            <path className="lgs-mark lgs-m1" d={SPARK_MARK_A} />
            <path className="lgs-mark lgs-m2" d={SPARK_MARK_B} />
        </svg>
    );
}

export const SPARKLE_CSS = `
/* Enrichments: the star implodes, blooms back through a half turn, and rings
   travel out of its core.

   THE TURN IS FREE. The star is 4-fold symmetric, so it holds at 180° while you
   hover and snaps to 0° when you leave — and 180° and 0° are the same picture,
   so there is no landing to hide. That is the only reason a rotation this big is
   allowed on a row hovered this often: it costs nothing to leave.

   Three tracks, all counted off the same wind-up:

   1  the star. Collapses to half size and winds 22° BACKWARDS first — the
      anticipation, and the one place ease-IN is right, because a thing gathering
      itself accelerates inward. Then it throws itself out through 200° of turn
      to 1.07 and settles. 78ms in, 168ms out; the whole read is over in 246ms.

   2  the rings, from 250ms. The core keeps going after the star has stopped —
      two star-shaped hairlines swelling out of the centre, 80ms apart, each
      dissolving at 0.94 before it reaches the edge. They stop short on purpose:
      a ring that reached 1.0 would land exactly on the star's own contour and
      eat it in one frame, which blinks. Fading them out inside the body is what
      makes the star read as filling back in solid.

   3  the two small marks. Sucked in on the star's own wind-up curve — same
      curve, so they read as part of one collapse rather than a second event —
      and they scale about the STAR's centre, not their own, so they genuinely
      fall inward rather than shrinking in place. They come back last, 288ms,
      overshooting 12% along that same radial: an outward pop, not a fade-in. */
.lgs-star, .lgs-ring, .lgs-mark { transform-box: view-box; transform-origin: 112px 144px; }
/* THE RING NEEDS ITS OWN RESTING STATE, and leaving this out is what made the
   star look a different size before and after hover.

   A keyframe's 0% only exists while the animation is attached. At rest nothing
   is hovered, so there is no animation at all — and with no declaration of its
   own the ring fell back to opacity 1, transform none. Which is scale 1: both
   bands parked exactly on the star's outline, permanently dimming its rim by
   60%. The resting star was quietly thinner and sharper than the hovered one,
   and the hover appeared to fatten it. Same lesson as .lgz on the bolt, which
   does declare this. Fill-mode covers the DELAY; only this covers rest. */
.lgs-ring { opacity: 0; }
@keyframes lg-sp-bloom {
  0%   { transform: rotate(0deg) scale(1); animation-timing-function: cubic-bezier(0.5, 0, 0.85, 0.25); }
  14%  { transform: rotate(-22deg) scale(0.5); animation-timing-function: cubic-bezier(0.14, 0.9, 0.24, 1); }
  44%  { transform: rotate(174deg) scale(1.07); animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); }
  62%  { transform: rotate(180deg) scale(1); }
  100% { transform: rotate(180deg) scale(1); }
}
/* 0% is opacity 0, matching the resting rule above, so the backwards fill
   during the hover-intent delay leaves the icon untouched like every other
   gesture — and so hovering never changes the star's weight on frame one.

   IT RUNS THE FULL DISTANCE, 0.12 → 1.04, because the band is translucent and
   removes nothing (see the mask notes in the component above). An opaque version had to stop at 0.66:
   a star's tips are 96 units from the centre but its armpits only 48, so a HOLE
   approaching the outline severed the waist and left the corner floating. A
   band has no such limit — it can cross the contour and leave, which is what
   "grows big and fills the star" actually wants.

   The tail fade is the honest physics: a ripple loses amplitude as it spreads.
   Combined with the ease-out on scale, the ring covers most of its ground early
   and then dissolves slowly at the rim, so the star closes up rather than
   blinking clear. */
@keyframes lg-sp-ripple {
  0%   { opacity: 0; transform: scale(0.12); animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); }
  16%  { opacity: 1; }
  55%  { opacity: 1; }
  100% { opacity: 0; transform: scale(1.04); }
}
@keyframes lg-sp-mark {
  0%   { opacity: 1; transform: scale(1); animation-timing-function: cubic-bezier(0.5, 0, 0.85, 0.25); }
  12%  { opacity: 0; transform: scale(0.4); }
  /* gone for the whole bloom — they cannot come back before the star lands */
  48%  { opacity: 0; transform: scale(0.4); animation-timing-function: cubic-bezier(0.2, 1, 0.3, 1); }
  72%  { opacity: 1; transform: scale(1.12); animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1); }
  90%  { opacity: 1; transform: scale(1); }
  100% { opacity: 1; transform: scale(1); }
}
`;