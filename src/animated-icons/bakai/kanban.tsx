"use client";

/* ── Kanban ───────────────────────────────────────────────────────────────────
   Phosphor `Kanban`, FILL weight, 256 viewBox. Source ships as 2 compound paths;
   split here into the 5 disjoint cards it actually draws. They share no edges
   (every column sits 16 from its neighbour, every card 16 from the one below),
   so the split is antialias-free and rest is byte-exact, not merely close.

     A  left top     x32-88   y48-112   (r8 top, r4 bottom)   ← the traveller
     B  left bottom  x32-88   y128-224  (r4 top, r16 bottom)  ← closes the gap
     C  middle       x104-160 y48-160   (r8 all round)        ← pushed down
     D  right top    x176-232 y48-112                         ← static
     E  right bottom x176-232 y128-188                        ← static

   TWO NUMBERS, BOTH READ OFF THE FILE, AND THEY ARE THE WHOLE GESTURE:

     72 = the column pitch (56 of card + the 16 gap). The card advances exactly
          one column, landing on x104-160 — the middle column's own footprint.
     80 = one slot (64 of card + the 16 gap). The distance the middle column must
          drop to open a place, and the distance the left column must rise to
          close the one left behind. Same 80, opposite signs, so the two halves
          read as a single event rather than two animations.

   Why left→middle rather than left→right: pushed down 80, the middle card lands
   on y128-240, which is inside the 256 box with 16 to spare. Nothing is shoved
   off the page and nothing gets cut by the frame. And the arrangement it lands in
   is the board's own grammar — card 48-112, gap 16, card 128-240.

   NO MASK ANYWHERE, AND THAT IS DELIBERATE. The obvious way to put a card in
   front of a column is a mask carrying the mover's silhouette; done with a
   stroked copy it punches OUTSIDE the object's own outline and shows as a white
   halo tracing it (handoff §9.3: "Occlusion is a FILL. Never put a stroke on a
   mask"). The better answer was to remove the need: the room opens before the
   card gets there, so the two never overlap. Swept at 1ms resolution across the
   whole approach, their minimum clearance is 16.0u — exactly the board's own gap,
   never less. Nothing has to occlude anything, so nothing can halo.

   Mechanism per part (SKILL § Choose the mechanism):
     - every card is RIGID. They travel. transform, never a morph.
     - x and y ride SEPARATE nested groups. One transform gets one timing function
       per segment (TECHNIQUE #3), so keeping them together would force the card
       to stop dead horizontally and only then drop. Split, the descent begins
       while it is still travelling and the two compose into a real arc.
     - the room opens BEFORE the card lands: the push finishes at 165ms, the card
       seats at 260ms. A column that reacts after the fact reads as coincidence;
       one that opens as the card comes in reads as a drop target.
     - zero opacity, and nothing leaves the frame.

   THE CARDS SWAP AND STAY SWAPPED. Nothing returns to where it came from.
   A goes left → middle → right in two hops; D goes right, off the frame, and
   back in from the left. A ends on D's resting slot and D ends on A's, and
   BECAUSE THEY ARE CONGRUENT that final picture is pixel-identical to rest — so
   when the animation is removed and both snap home, nothing visibly moves. The
   congruence is what buys a one-way gesture on an icon that must rest unchanged.
   (Checked on absolute points, not fingerprints: the two paths differ only in
   writing H84 vs h48, the same point absolute and relative. A shifted +144 gives
   (224,48)(184,48)(176,56)(176,108)(180,112)(228,112)(232,108)(232,56) = D.)

   D LAPS THE OUTSIDE instead of crossing. Sent head-on through the middle it
   would have to pass through A, and this icon is one row with no second lane —
   at fill weight two overlapping cards either fuse into one blob or need the
   dilated mask that was haloing. Going round means every move runs the same
   direction and nothing ever crosses. The reposition happens on a hundredth of a
   percent while D is genuinely off-frame at both ends (x264..320, then -72..-16).

   1s, one clock, so every keyframe percentage is the millisecond count over ten.
   Every curve has a high start slope
   (VERIFY § Snappiness: a bezier's start slope is y1/x1, and a flat start is what
   reads as lag) and a hard finish; returns run faster than the outbound.  */

const A = "M80,48H40a8,8,0,0,0-8,8v52a4,4,0,0,0,4,4H84a4,4,0,0,0,4-4V56A8,8,0,0,0,80,48Z";
const B = "M84,128H36a4,4,0,0,0-4,4v76a16,16,0,0,0,16,16H72a16,16,0,0,0,16-16V132A4,4,0,0,0,84,128Z";
const C = "M160,56v96a8,8,0,0,1-8,8H112a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8h40A8,8,0,0,1,160,56Z";
const D = "M224,48H184a8,8,0,0,0-8,8v52a4,4,0,0,0,4,4h48a4,4,0,0,0,4-4V56A8,8,0,0,0,224,48Z";
const E = "M228,128H180a4,4,0,0,0-4,4v44a16,16,0,0,0,16,16h24a16,16,0,0,0,16-16V132A4,4,0,0,0,228,128Z";

export function KanbanLive({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            <path d={E} />
            <g className="kb-push">
                <path d={C} />
            </g>
            <path d={B} />
            <g className="kb-ax">
                <g className="kb-ay">
                    <path d={A} />
                </g>
            </g>
            <g className="kb-dx">
                <g className="kb-dy">
                    <path d={D} />
                </g>
            </g>
        </svg>
    );
}
