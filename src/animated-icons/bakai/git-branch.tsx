// Git Branch, from the Phosphor-derived set built for the /linear-app sidebar.
//
// Phosphor ships each icon as ONE compound path, so nothing inside it can be animated
// independently. This is rebuilt from Phosphor's own fill geometry — same 256 viewBox,
// same coordinates, read straight out of the package — split into the pieces the gesture
// needs. At rest it is meant to be indistinguishable from the original; only the seams
// are new. Where a gesture only ADDS something (a spark leaving a bolt), the Phosphor
// glyph is left completely untouched and the new element is drawn beside it — always the
// safer route, and preferred wherever it works.

type P = { size?: number; className?: string };

/* ── Endpoints: the branch retracts into its head, then rewrites itself ───────
   Phosphor's GitBranch fill is one compound path. Decomposed against its own
   outline (every number below is read out of it, nothing is invented):

     node   c(200, 64) r32           SOLID — the only filled circle in the glyph
     ring A c( 80, 64) outer 32, inner 16
     ring B c( 80,192) outer 32, inner 16
     trunk  band x 72→88   (centre x=80), y 95→161 — ring edge to ring edge
     elbow  band y 120→136 (centre y=128), inner corner r8, outer r24

   Two rewrites turn that into something that can be WRITTEN rather than shown:

   1. Every band becomes a STROKE on its centreline instead of a filled outline.
      A 16-wide stroke down x=80 from y95 to y161 is the trunk to the pixel; the
      elbow's centreline is the r16 arc exactly between its r8 and r24 edges. Now
      each one has a path length, so stroke-dashoffset can draw it on.

   2. The solid node becomes ring(r24, w16) + a plug disc(r16) stacked on it.
      Those two together are a disc of radius 32 — bit for bit the original. But
      it means the fill→hollow morph is a plain scale on the plug: no crossfade
      between a dot and a ring, no animating `r`, and the outer edge never moves.
      That is the whole trick the gesture is built on.

   pathLength="1" everywhere so the CSS can talk in 0→1 instead of arc lengths. */
export function GitBranchLive({ size = 16, className }: P) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" className={className}>
            {/* connectors first, so a stroke can never sit on top of a node */}
            {/* Phosphor's trunk stops at y95/y161, where the band's corners just
                graze each ring. As one filled outline that is seamless; as
                separate strokes those tangent points leave an antialias hairline.

                So this runs ring CENTRELINE to ring centreline instead: y88 is
                exactly ringA's stroke centre (64+24), y168 exactly ringB's
                (192-24). That buries the seam at both ends, and — the reason it
                matters more than tidiness — it makes the drawn stroke continuous.
                The pen now finishes the trunk on the very point where ring B's
                arc begins, instead of stopping 4 units short and jumping the gap.
                Both endpoints stay inside the rings' bands (the holes do not
                start until y78 / y178), so nothing shows at rest. */}
            <path className="gbt" pathLength="1" d="M80,88V168" />
            {/* leaves the trunk at its midpoint, corners at r16, and runs up INTO
                the node — the last 24 units are buried under the disc, which is
                what lets the stroke arrive without a visible butt cap */}
            <path className="gbe" pathLength="1" d="M80,128H184A16,16,0,0,0,200,112V72" />
            <circle className="gbra" cx="80" cy="64" r="24" />
            {/* rotated -90° so the dash starts at 12 o'clock, where the trunk
                lands — invisible at rest, it is a circle */}
            <circle className="gbrb" pathLength="1" cx="80" cy="192" r="24" />
            <g className="gbn">
                <circle cx="200" cy="64" r="24" />
                {/* r17, not the exact r16 the ring's hole is: one unit of
                    overlap so the plug and the ring do not share an edge and
                    leave a hairline across the middle of the node */}
                <circle className="gbp" cx="200" cy="64" r="17" fill="currentColor" stroke="none" />
            </g>
        </svg>
    );
}
