/* ── Git Branch (Phosphor GitBranch, fill): the branch retracts into its head,
   then rewrites itself. Decomposed against Phosphor's own outline:

     node   c(200, 64) r32           SOLID — the only filled circle in the glyph
     ring A c( 80, 64) outer 32, inner 16
     ring B c( 80,192) outer 32, inner 16
     trunk  band x 72→88   (centre x=80), y 95→161 — ring edge to ring edge
     elbow  band y 120→136 (centre y=128), inner corner r8, outer r24

   1. Every band becomes a 16-wide STROKE on its centreline instead of a filled
      outline (the elbow's centreline is the r16 arc between its r8 and r24
      edges), so each one has a path length and stroke-dashoffset can draw it.
   2. The solid node becomes ring(r24, w16) + a plug disc(r16) stacked on it —
      together bit for bit the original r32 disc — so the fill→hollow morph is a
      plain scale on the plug and the outer edge never moves.

   pathLength="1" everywhere so the CSS can talk in 0→1 instead of arc lengths. */
export function GitBranchLive({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" className={className}>
            {/* connectors first, so a stroke can never sit on top of a node */}
            {/* Runs ring CENTRELINE to ring centreline (y88 = 64+24, y168 = 192-24)
                rather than Phosphor's y95/y161: separate strokes leave an
                antialias hairline at tangent points, and ending on ring B's
                stroke centre makes the drawn stroke continuous into ring B's
                arc. Both ends stay inside the ring bands, so nothing shows at rest. */}
            <path className="gbt" pathLength="1" d="M80,88V168" />
            {/* leaves the trunk at its midpoint, corners at r16, and runs up INTO
                the node — the last 24 units are buried under the disc, so the
                stroke arrives without a visible butt cap */}
            <path className="gbe" pathLength="1" d="M80,128H184A16,16,0,0,0,200,112V72" />
            <circle className="gbra" cx="80" cy="64" r="24" />
            {/* rotated -90° so the dash starts at 12 o'clock, where the trunk lands */}
            <circle className="gbrb" pathLength="1" cx="80" cy="192" r="24" />
            <g className="gbn">
                <circle cx="200" cy="64" r="24" />
                {/* r17, not the ring hole's exact r16: one unit of overlap so the
                    plug and ring do not share an edge and leave a hairline */}
                <circle className="gbp" cx="200" cy="64" r="17" fill="currentColor" stroke="none" />
            </g>
        </svg>
    );
}
