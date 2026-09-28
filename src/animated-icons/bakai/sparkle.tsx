import { useId } from "react";

/* ── Sparkle (Phosphor Sparkle, fill): the star blooms and ripples ──────────────
   The compound path holds three subpaths, copied verbatim and only separated:

     the star     4-pointed, centred (112,144), 192 units across
     mark A       a plus centred (180,40)
     mark B       a plus centred (228,84)

   The star is 4-FOLD SYMMETRIC, so it can spin a half turn and hold there; when
   the animation is torn off it snaps back to 0°, which is invisible because
   180° and 0° are the same picture.

   Inside it, two rings: the star's OWN outline, stroked, living in a mask so
   they act on the star (correct against whatever the row is tinted to).

   THE STROKE IS TRANSLUCENT. Opaque black in a mask cuts a HOLE, which at this
   size turned the star into a thin hollow outline mid-gesture. At 0.6 the ring
   only DIMS the star along its path, so the silhouette is identical to rest on
   every frame and what travels outward is a band of light, not a cut — which
   also lets the band run all the way off the edge without severing the star's
   narrow waist.

   vector-effect="non-scaling-stroke" keeps the band one constant width as it
   grows. MIND THE UNITS: Chromium's non-scaling-stroke ignores the viewBox
   transform too, so stroke-width is in CSS PIXELS, not the 256 user units —
   hence size × 0.044 (0.7px at sidebar size). Thin matters as much as
   translucent: a wider band washed out the star's interior.                  */
const SPARK_STAR =
    "M208,144a15.78,15.78,0,0,1-10.42,14.94L146,178l-19,51.62a15.92,15.92,0,0,1-29.88,0L78,178l-51.62-19a15.92,15.92,0,0,1,0-29.88L78,110l19-51.62a15.92,15.92,0,0,1,29.88,0L146,110l51.62,19A15.78,15.78,0,0,1,208,144Z";
const SPARK_MARK_A = "M152,48h16V64a8,8,0,0,0,16,0V48h16a8,8,0,0,0,0-16H184V16a8,8,0,0,0-16,0V32H152a8,8,0,0,0,0,16Z";
const SPARK_MARK_B = "M240,80h-8V72a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8,8,0,0,0,16,0V96h8a8,8,0,0,0,0-16Z";

export function SparkleLive({ size = 16, className }: { size?: number; className?: string }) {
    /* per instance: url(#id) resolves document-wide, so a hardcoded id makes a
       second instance use the first one's mask */
    const sparkRingsId = "lg-spark-rings-" + useId().replace(/[^a-zA-Z0-9]/g, "");
    return (
        // overflow visible: the marks overshoot ~0.3px past the top edge on their
        // way back in, and clipping that would read as a bug
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
            {/* only the star is masked — the marks have their own beat */}
            <g mask={`url(#${sparkRingsId})`}>
                <path className="lgs-star" d={SPARK_STAR} />
            </g>
            <path className="lgs-mark lgs-m1" d={SPARK_MARK_A} />
            <path className="lgs-mark lgs-m2" d={SPARK_MARK_B} />
        </svg>
    );
}
