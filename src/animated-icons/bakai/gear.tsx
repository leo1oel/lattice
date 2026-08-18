"use client";

/* ── Gear ─────────────────────────────────────────────────────────────────────
   Phosphor `GearSix`, FILL weight, 256 viewBox. Two subpaths: the six-toothed
   body, and a circle knocked out of its middle.

   THE AXIS IS GIVEN, NOT GUESSED. Fitting a circle to that knockout returns
   centre (128.0000, 128.0000) r 40.0000 — exact. Measured off the body outline
   about that axis: tips at 0/60/120/180/240/300 reaching r112.018, valleys at
   30/90/…/330 down to r86.150, so the tooth is 25.868 units tall and the pitch
   is 360/6 = 60. Every number below is one of those five.

   THREE TEETH, BECAUSE THIS DRAWING IS ONLY EXACT AT THREE. Rotating all 773
   sampled outline points about the axis and measuring each one's distance to the
   nearest original point:

     30 deg  -> 24.860 units out     (not a symmetry)
     60 deg  ->  2.113 units out     (the tooth pitch, and NOT exact)
     120 deg ->  2.131 units out
     180 deg ->  0.086 units out     <- the only exact one
     360 deg ->  0.000

   Phosphor draws this as a six-lobed rosette that is optically adjusted, not
   mechanically six-fold: the teeth at 0 and 180 stand 1.8 units prouder than the
   other four and the valleys at 90 and 270 cut 2.1 units deeper. So it is
   exactly TWO-fold and only approximately six-fold. A one-tooth index — what
   this icon used to do — lands 2.113 units off its own rest picture, which is a
   third of a pixel of permanent fringe on the gate that compares frame 0 with
   the final frame. Three teeth is 0.086 units, i.e. 0.013px at ship size: the
   gesture is pixel-exact for the first time, and it is three times as visible.

   THE VERB: a gear does not free-spin and it does not slide. It INDEXES — it is
   held, it breaks over one tooth, it seats, and it is held again. So this is
   FAMILIES #8, step-and-hold, and the holds are the whole point: an earlier build
   modulated a continuous 180 degrees (it slowed to about half speed at each
   crest, measured 2.03x then 1.86x) and Bakai read that as rotating, not ticking,
   because the velocity never actually reached zero. A ripple is not a click. It
   ticks three times, and between the ticks it is genuinely still.

   ONE TICK, and all three are identical because an escapement is regular:

     -3.274   recoil. Real recoil escapements do kick back before they release,
              and it is also the anticipation the house rules ask for. Stated in
              the only unit that means anything here: 1px of travel at the TOOTH
              TIP at ship size. 40px ship size and a 256 box is 6.40 units per
              pixel, and the tip radius is 112.018, so 1px = 3.274 degrees.
     +60      the impulse, one tooth pitch, 155ms.
     +4.911   the seat overshoots 1.5px and comes back through -0.982 (a hard 0.2
              decay), which is the click landing rather than a wobble.
     hold     87ms of nothing at all.

   WHY THE SNAP IS 155ms AND NOT FASTER. A six-fold gear aliases far earlier than
   a hand does: one pitch is only 60 degrees, so a frame step near 30 makes the
   direction ambiguous and at 60 the gear looks like it never moved at all. Keep
   the frame step under a third of a pitch, i.e. 1200 deg/s. Peak is (the curve's
   max slope) x travel / duration, and cubic-bezier(0.5,0,0.35,1) peaks at 2.38x,
   so 68.185 degrees needs 135ms minimum; at 155ms it delivers 17.5 deg/frame. The
   punchier curves are simply not available at this size: ease-out-expo peaks at
   5.26x and would need 299ms for the same snap.

   1.02s. Rest is the untouched source path carrying no transform, so source vs
   rest and hover before vs after are both zero by construction.  */

const GEAR =
    "M237.94,107.21a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A111.92,111.92,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.63a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z";

export function GearLive({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            <g className="gr-turn">
                <path d={GEAR} />
            </g>
        </svg>
    );
}
