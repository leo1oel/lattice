/* Chat — Phosphor "chat-dots" (FILL weight), first of the Phosphor picks.
   256 viewBox, path data verbatim from Bakai's pasted export.

   The gesture: the bubble deflates into its own tail tip, holds an ~80ms blind
   beat, inflates back from small (soft overshoot), and the three typing dots
   pop in left→right. Rest is the untouched glyph; frame 0 == final frame.

   In the fill weight the dots are HOLES knocked out of the solid bubble, so
   they cannot be separate <path>s (same fill = invisible). The bubble is his
   outline subpath masked by three black circles at the dot coordinates
   (84,128) (128,128) (172,128) r12; the pop animation scales the holes. The
   mask sits outside the .ct-pop group, so it is applied in user space first
   and the collapsing group carries the holes with it for free.

   The scale origin is the tail's outermost point, not a taste value: the
   bottom-left corner arc runs (24,224)→(33.25,238.5) about centre
   (39.84,224) r15.84, so the tip is (39.84−15.84/√2, 224+15.84/√2)
   = (28.64, 235.20).

   One clock (1s) for all four tracks — the holes ride the group during the
   collapse, snap to scale(0) only while the group itself is at scale(0)
   (16% sits inside the 14–22% blind window), and pop after the bubble has
   landed. Every rest value is the identity transform, so no base rules are
   needed and reduced-motion's flat animation:none is already correct. */

"use client";

import { useId } from "react";

const CT_BUBBLE =
    "M216,48H40A16,16,0,0,0,24,64V224a15.84,15.84,0,0,0,9.25,14.5A16.05,16.05,0,0,0,40,240a15.89,15.89,0,0,0,10.25-3.78l.09-.07L83,208H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48Z";

export function ChatLive({ size = 16, className, converted }: { size?: number; className?: string; converted?: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const m = `ctMask${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {converted ? (
                <g className="ct-pop" fill="none" stroke="var(--converted-ink)" strokeWidth="16" strokeLinejoin="round">
                    <path d={CT_BUBBLE} />
                    <g fill="var(--converted-ink)" stroke="none">
                        <circle className="ct-d1" cx="84" cy="128" r="12" />
                        <circle className="ct-d2" cx="128" cy="128" r="12" />
                        <circle className="ct-d3" cx="172" cy="128" r="12" />
                    </g>
                </g>
            ) : (
                <>
                    <mask id={m} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                        <rect x="0" y="0" width="256" height="256" fill="#fff" />
                        <circle className="ct-d1" cx="84" cy="128" r="12" fill="#000" />
                        <circle className="ct-d2" cx="128" cy="128" r="12" fill="#000" />
                        <circle className="ct-d3" cx="172" cy="128" r="12" fill="#000" />
                    </mask>
                    <g className="ct-pop"><path d={CT_BUBBLE} mask={`url(#${m})`} /></g>
                </>
            )}
        </svg>
    );
}
