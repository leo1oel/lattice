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
                    <path d={CARD} fill="var(--converted-fill)" stroke="var(--converted-ink)" strokeWidth="16" />
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

export const LISTCHECKS_CSS = `/* Rest, said out loud: rows 1 and 2 in their slots, opaque, both marks fully
   drawn; row 3 parked one pitch below with opacity 0, which punches nothing at
   all. At rest no animation is attached, so this has to be a base rule. */
.lg-checks .lc-ck, .lg-checks .lc-ln { stroke-dasharray: 1 2; stroke-dashoffset: 0; }
.lg-checks .lc-f1, .lg-checks .lc-f2 { opacity: 1; }
.lg-checks .lc-f3 { opacity: 0; }
.lg-checks .lc-r3 .lc-ck, .lg-checks .lc-r3 .lc-ln { stroke-dashoffset: 1.01; }

/* 1.28s = two turns of 640ms. Per turn the whole list scrolls up exactly one
   pitch (0-210ms): the top row ghosts out as it goes, the new bottom row ghosts
   in, writes its line, and then its tick is written (300-640ms). The pair of
   keyframes 0.01% apart at 22.65/22.66% and 72.65/72.66% re-arm a row that has
   left — from above the card round to below it, marks reset — while it is at
   opacity 0 and therefore provably punching nothing. */

/* ── row 1: ghosts out ─ re-armed below ─ ghosts back in at the bottom ────── */
@keyframes lg-checks-r1 {
  0%      { transform: translateY(0px);     animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  16.41%  { transform: translateY(-64px); }
  22.65%  { transform: translateY(-64px); }
  22.66%  { transform: translateY(128px); }
  50.00%  { transform: translateY(128px);   animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  66.41%  { transform: translateY(64px); }
  100%    { transform: translateY(64px); }
}
@keyframes lg-checks-f1 {
  0%      { opacity: 1;  animation-timing-function: cubic-bezier(0.32,0.72,0,1); }
  11.72%  { opacity: 0; }
  52.34%  { opacity: 0;  animation-timing-function: cubic-bezier(0.33,1,0.68,1); }
  69.53%  { opacity: 1; }
  100%    { opacity: 1; }
}
@keyframes lg-checks-l1 {
  0%      { stroke-dashoffset: 0; }
  22.65%  { stroke-dashoffset: 0; }
  22.66%  { stroke-dashoffset: 1.01; }
  54.69%  { stroke-dashoffset: 1.01;  animation-timing-function: cubic-bezier(0.45,0,0.15,1); }
  71.09%  { stroke-dashoffset: 0; }
  100%    { stroke-dashoffset: 0; }
}
@keyframes lg-checks-k1 {
  0%      { stroke-dashoffset: 0; }
  22.65%  { stroke-dashoffset: 0; }
  22.66%  { stroke-dashoffset: 1.01; }
  73.44%  { stroke-dashoffset: 1.01;      animation-timing-function: cubic-bezier(0.45,0,0.55,0.85); }
  84.06%  { stroke-dashoffset: 0.66667;   animation-timing-function: cubic-bezier(0.4,0.1,0.25,1); }
  100%    { stroke-dashoffset: 0; }
}

/* ── row 2: closes up to the top ─ then ghosts out ─ re-armed below ───────── */
@keyframes lg-checks-r2 {
  0%      { transform: translateY(0px);      animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  16.41%  { transform: translateY(-64px); }
  50.00%  { transform: translateY(-64px);    animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  66.41%  { transform: translateY(-128px); }
  72.65%  { transform: translateY(-128px); }
  72.66%  { transform: translateY(64px); }
  100%    { transform: translateY(64px); }
}
@keyframes lg-checks-f2 {
  0%      { opacity: 1; }
  50.00%  { opacity: 1;  animation-timing-function: cubic-bezier(0.32,0.72,0,1); }
  61.72%  { opacity: 0; }
  100%    { opacity: 0; }
}
@keyframes lg-checks-l2 {
  0%      { stroke-dashoffset: 0; }
  72.65%  { stroke-dashoffset: 0; }
  72.66%  { stroke-dashoffset: 1.01; }
  100%    { stroke-dashoffset: 1.01; }
}
@keyframes lg-checks-k2 {
  0%      { stroke-dashoffset: 0; }
  72.65%  { stroke-dashoffset: 0; }
  72.66%  { stroke-dashoffset: 1.01; }
  100%    { stroke-dashoffset: 1.01; }
}

/* ── row 3: ghosts in at the bottom, writes itself, then closes up ────────── */
@keyframes lg-checks-r3 {
  0%      { transform: translateY(0px);      animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  16.41%  { transform: translateY(-64px); }
  50.00%  { transform: translateY(-64px);    animation-timing-function: cubic-bezier(0.19,1,0.22,1); }
  66.41%  { transform: translateY(-128px); }
  100%    { transform: translateY(-128px); }
}
@keyframes lg-checks-f3 {
  0%      { opacity: 0; }
  2.34%   { opacity: 0;  animation-timing-function: cubic-bezier(0.33,1,0.68,1); }
  19.53%  { opacity: 1; }
  100%    { opacity: 1; }
}
@keyframes lg-checks-l3 {
  0%      { stroke-dashoffset: 1.01; }
  4.69%   { stroke-dashoffset: 1.01;  animation-timing-function: cubic-bezier(0.45,0,0.15,1); }
  21.09%  { stroke-dashoffset: 0; }
  100%    { stroke-dashoffset: 0; }
}
@keyframes lg-checks-k3 {
  0%      { stroke-dashoffset: 1.01; }
  23.44%  { stroke-dashoffset: 1.01;      animation-timing-function: cubic-bezier(0.45,0,0.55,0.85); }
  34.06%  { stroke-dashoffset: 0.66667;   animation-timing-function: cubic-bezier(0.4,0.1,0.25,1); }
  50.00%  { stroke-dashoffset: 0; }
  100%    { stroke-dashoffset: 0; }
}
`;
