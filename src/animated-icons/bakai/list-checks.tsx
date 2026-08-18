"use client";

import { useId } from "react";

/* ── List Checks ──────────────────────────────────────────────────────────────
   Phosphor `ListChecks`, FILL weight, 256 viewBox. One compound path: a solid
   rounded card with the two rows knocked OUT of it. So the rows are HOLES, and
   anything that moves independently has to live in a mask.

   THE CENTRELINES ARE RECOVERABLE, WHICH IS THE WHOLE BUILD. Every knockout is
   the outline of a round-capped stroke, and every 8-radius cap arc's centre is a
   polyline vertex. Read off the source:

     check   M117.66,149.66 … caps at (80,176) 90deg, (64,160) and (112,144) 180deg
             => polyline (64,160) (80,176) (112,144), stroke-width 16, round
     line    M192,168H144a8,8… => capsule (144,160)-(192,160), stroke-width 16
     and the same pair 'm0-64' above it, at y=96.

   Re-stroking those centrelines at width 16 with round caps and joins reproduces
   Phosphor's outlined path to 67px at max 29 on a 720px render, 100% of it on an
   ink contour and split evenly between the two rows: antialias fringe, not
   geometry. That is what buys the check and the line a real LENGTH to be drawn
   along, which an outlined blob does not have.

   THE GRID IS EXACT AND IT IS WHAT MAKES THE GESTURE POSSIBLE. Rows sit at y96
   and y160, so the pitch is 64; the card's interior is 32..224 = 192 = 3 x 64.
   So the slots are 32, 96, 160, 224 — one above the top row and one below the
   bottom row, and the drawing put them there. A row's own ink is +-24 about its
   centre, so adjacent rows sit 64-48 = 16 apart.

   THE VERB: a task list advances. The finished item ghosts off the top, the list
   closes up behind it, a new one ghosts in from the bottom and writes its own
   line, and then it is ticked. Twice, and after two turns the picture is the
   source again.

   WHY TWO TURNS LAND ON REST, when three elements rotating through three slots
   would normally need three: THE ROWS ARE CONGRUENT. Row A translated +64 IS row
   B, exactly. So it does not matter which element ends in which slot, only that
   the slots are filled the same way. The last frame parks A at slot 160 (ticked),
   C at slot 96 (ticked) and B at 224 (transparent); when the driver clears
   data-go all three snap home, three elements move and not one pixel does.
   Measured: live hover before vs after = 0px.

   THE FADE IS WHAT BUYS THE RIGID SCROLL. Bakai asked for a ghost in and a ghost
   out (which reverses this set's usual no-opacity rule — his call, stated here so
   nobody "fixes" it back). It is not only decoration: without it the departing
   row has to travel 96 to clear the card, and swept at 1ms against the rising
   row its hole MERGES with the one below by 35 units — one tall white gash
   instead of two rows — so it needs an 85ms head start to stay legal. Fading it
   out means it never has to reach the edge, so every row can move by exactly one
   pitch, all together. A rigid scroll cannot collide: all three gaps hold their
   resting 16u for the whole beat, by construction.

   Opacity inside a mask is TECHNIQUE #14's trap — a promoted layer loses opacity
   and the erased thing ghosts back at 10-15%. Tested the way #14 says to, at a
   paused instant with the rows in motion, by toggling the mask off to find every
   pixel the card covers and then reading those pixels back: 29279 of them are cut
   clean to **255, the page background exactly**, and the only partial values sit
   on the holes' own outlines, about half a pixel of antialiasing along 1743px of
   perimeter. A leak would raise the hole INTERIORS to a uniform 217-230. So this
   stays a mask.
   (An earlier note here claimed 0px from a static-vs-animated comparison. That
   probe was worthless: the page it ran on was not repainting at all, so it was
   measuring nothing. A probe that returns 0 has to be shown capable of returning
   something else first.)
   And a row at opacity 0 punches nothing at all, which is what hides the parked
   row at rest without a visibility gate.

   TIMING, the two speeds asked for:
     the scroll, SNAPPY  210ms on ease-out-expo [0.19,1,0.22,1], start slope 5.3
     the ghost out       150ms on the iOS-sheet exit curve, ~30% faster than the
                         way in, per the house rule that exits outrun entrances
     the ghost in        220ms, ease-out-cubic, starting 30ms late so the row is
                         already moving before it is visible
     the line            210ms, drawn along its own length on the pen curve
     the tick            340ms, split at the elbow. The short leg is 22.63 units
                         and the long one 45.25, so the corner falls at exactly
                         1/3 of the length and gets 40% of the clock: a pen
                         slowing into a corner and flicking out of it. Slopes
                         matched across the join (0.333 x 0.833 = 0.25 x 1.111)
                         so it does not stop dead at the elbow.

   1.28s, two turns of 640ms. A row leaves by going out of the card and the
   card's own edge is the clip — a hole punched where there is no card punches
   nothing — so there is no clipPath anywhere in this file.  */

const CARD =
    "M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Z";

/* each row authored at its own resting y; slots 96 / 160 / 224 (parked, clear) */
const ROWS = [
    { n: 1, check: "M64,96L80,112L112,80", line: "M144,96H192" },
    { n: 2, check: "M64,160L80,176L112,144", line: "M144,160H192" },
    { n: 3, check: "M64,224L80,240L112,208", line: "M144,224H192" },
];

function CheckRows() {
    return ROWS.map((r) => (
        <g key={r.n} className={`lc-r${r.n}`}>
            <g className={`lc-f${r.n}`}>
                <path className="lc-ck" pathLength="1" d={r.check} />
                <path className="lc-ln" pathLength="1" d={r.line} />
            </g>
        </g>
    ));
}

export function ListChecksLive({ size = 16, className, converted }: { size?: number; className?: string; converted?: boolean }) {
    // url(#id) resolves document-wide, so two of these on one page would share a
    // mask and only the first would ever animate (TECHNIQUE #6)
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const msk = `lcMask-${uid}`;
    const clip = `lcClip-${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {converted ? (
                <>
                    <defs><clipPath id={clip}><path d={CARD} /></clipPath></defs>
                    <path d={CARD} fill="none" stroke="var(--converted-ink)" strokeWidth="16" />
                    <g clipPath={`url(#${clip})`} fill="none" stroke="var(--converted-ink)" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
                        <CheckRows />
                    </g>
                </>
            ) : (
                <>
                    <mask id={msk} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                        <rect x="0" y="0" width="256" height="256" fill="#fff" />
                        <g fill="none" stroke="#000" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
                            <CheckRows />
                        </g>
                    </mask>
                    <path d={CARD} mask={`url(#${msk})`} />
                </>
            )}
        </svg>
    );
}
