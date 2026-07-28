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

export const GITBRANCH_CSS = `
/* The branch rewrites itself.

   One clock, six parts, and a single sleight of hand in the middle. The glyph's
   only solid circle is the branch HEAD, so that is the piece that survives: the
   rest goes out, the head slides across into the root's slot and hollows out
   into it, and from there the whole branch is written back on with the pen.

   The handoff at 46% is the trick. At that instant the travelling head is
   sitting exactly where ring A lives and — because a solid node is just
   ring(r24,w16) with a plug disc inside it, and the plug has scaled to nothing —
   it is drawing pixel-for-pixel the same shape ring A draws. So ring A switches
   on and the head switches off ON THE SAME FRAME. Nothing crossfades, nothing
   moves; you cannot see the swap because there is no visual difference to see.
   The head then snaps home to the right, invisible, and waits for the pen.

   Same idea as the rocket's off-frame reposition: do the impossible bit where
   nobody is looking.

   The exit is deliberately cheap — 84ms of flat opacity — because it is not the
   point. The only exit that gets any craft is the elbow, which drains INTO the
   head (dashoffset toward -1 erases from the START of the path, so the visible
   remainder shrinks up toward the node). The one piece physically attached to
   the survivor is the one piece that looks like it was absorbed.

   Then the writing, in the order a hand would actually draw a git graph:
   trunk down → loop the bottom ring → back out along the branch → set the dot.
   Each stroke gets cubic-bezier(0.45,0,0.15,1): a pen leaves fast and eases into
   its stop, which is what separates writing from a progress bar. */
/* 1.02, not 1. Each of these carries pathLength="1", so a dash of 1 is exactly
   one lap — and on ring B, which is closed, that lands the dash's two butt caps
   on the same point and leaves a hairline seam at 12 o'clock IN THE REST STATE.
   Two percent of overlap runs the dash past its own start so the caps bury each
   other. Everything below therefore hides at 1.02, not 1. */
.gbt, .gbe, .gbrb { stroke-dasharray: 1.02; stroke-dashoffset: 0; }
.gbrb { transform-box: view-box; transform-origin: 80px 192px; transform: rotate(-90deg); }
.gbn { transform-box: view-box; transform-origin: 200px 64px; }
.gbp { transform-box: fill-box; transform-origin: 50% 50%; }

/* ring A: out, then straight back on at the handoff frame */
@keyframes lg-gb-ringa {
  0%     { opacity: 1; animation-timing-function: cubic-bezier(0.55,0,1,0.45); }
  10%    { opacity: 0; }
  45.99% { opacity: 0; }
  46%    { opacity: 1; }
  100%   { opacity: 1; }
}
/* trunk and ring B: fade out, get re-armed to hidden while nobody can see it
   (opacity is 0 at 10%, dashoffset jumps at 10.01%), then draw */
@keyframes lg-gb-trunk {
  0%     { opacity: 1; stroke-dashoffset: 0; animation-timing-function: cubic-bezier(0.55,0,1,0.45); }
  10%    { opacity: 0; stroke-dashoffset: 0; }
  10.01% { opacity: 1; stroke-dashoffset: 1.02; }
  46%    { opacity: 1; stroke-dashoffset: 1.02; animation-timing-function: cubic-bezier(0.45,0,0.15,1); }
  64%    { opacity: 1; stroke-dashoffset: 0; }
  100%   { opacity: 1; stroke-dashoffset: 0; }
}
@keyframes lg-gb-ringb {
  0%     { opacity: 1; stroke-dashoffset: 0; animation-timing-function: cubic-bezier(0.55,0,1,0.45); }
  10%    { opacity: 0; stroke-dashoffset: 0; }
  10.01% { opacity: 1; stroke-dashoffset: 1.02; }
  62%    { opacity: 1; stroke-dashoffset: 1.02; animation-timing-function: cubic-bezier(0.45,0,0.15,1); }
  78%    { opacity: 1; stroke-dashoffset: 0; }
  100%   { opacity: 1; stroke-dashoffset: 0; }
}
/* the elbow drains into the head (0 → -1), is re-armed on the far side of the
   dash pattern one frame later, and is written back on last */
@keyframes lg-gb-elbow {
  0%    { stroke-dashoffset: 0; animation-timing-function: cubic-bezier(0.55,0,1,0.45); }
  9%    { stroke-dashoffset: -1.02; }
  9.01% { stroke-dashoffset: 1.02; }
  78%   { stroke-dashoffset: 1.02; animation-timing-function: cubic-bezier(0.45,0,0.15,1); }
  93%   { stroke-dashoffset: 0; }
  100%  { stroke-dashoffset: 0; }
}
/* the head: slide 120 units left (7.5px at icon size), hold a beat so you can
   read that it has BECOME the root, hand off, snap home unseen, then get set
   back down by the pen — the 1.4 in that last curve is the nib pressing */
@keyframes lg-gb-node {
  0%     { opacity: 1; transform: translateX(0) scale(1); }
  10%    { opacity: 1; transform: translateX(0) scale(1); animation-timing-function: cubic-bezier(0.77,0,0.175,1); }
  34%    { opacity: 1; transform: translateX(-120px) scale(1); }
  45.99% { opacity: 1; transform: translateX(-120px) scale(1); }
  46%    { opacity: 0; transform: translateX(-120px) scale(1); }
  46.01% { opacity: 0; transform: translateX(0) scale(0.5); }
  91%    { opacity: 0; transform: translateX(0) scale(0.5); animation-timing-function: cubic-bezier(0.34,1.4,0.5,1); }
  100%   { opacity: 1; transform: translateX(0) scale(1); }
}
/* the hole opens. Starts at 30%, four frames before the head lands, so the
   hollowing and the arrival are one move rather than two. */
@keyframes lg-gb-plug {
  0%     { transform: scale(1); }
  30%    { transform: scale(1); animation-timing-function: cubic-bezier(0.32,0,0.28,1); }
  45%    { transform: scale(0); }
  46.01% { transform: scale(1); }
  100%   { transform: scale(1); }
}
`;