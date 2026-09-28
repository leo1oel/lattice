/* Chat — Phosphor "chat-dots" (FILL weight), 256 viewBox, path data verbatim
   from Bakai's pasted export.

   The gesture: the bubble deflates into its own tail tip, holds an ~80ms blind
   beat, inflates back from small (soft overshoot), and the three typing dots
   pop in left→right. Rest is the untouched glyph; frame 0 == final frame.

   In the fill weight the dots are HOLES knocked out of the solid bubble, so
   they cannot be separate <path>s (same fill = invisible). The bubble is masked
   by three black r12 circles at (84,128) (128,128) (172,128); the pop animation
   scales the holes. The mask sits outside the .ct-pop group, so it is applied
   in user space first and the collapsing group carries the holes with it.

   The scale origin is the tail's outermost point: the bottom-left corner arc
   runs about centre (39.84,224) r15.84, so the tip is
   (39.84−15.84/√2, 224+15.84/√2) = (28.64, 235.20).

   One clock (1s) for all four tracks: the holes snap to scale(0) only while
   the group itself is at scale(0) (16% sits inside the 14–22% blind window).
   Every rest value is the identity transform, so no base rules are needed and
   reduced-motion's flat animation:none is already correct. */

import { useId } from "react";

const CT_DOT_X = [84, 128, 172];
const CT_BUBBLE =
    "M216,48H40A16,16,0,0,0,24,64V224a15.84,15.84,0,0,0,9.25,14.5A16.05,16.05,0,0,0,40,240a15.89,15.89,0,0,0,10.25-3.78l.09-.07L83,208H216a16,16,0,0,0,16-16V64A16,16,0,0,0,216,48Z";

export function ChatLive({ size = 16, className, converted }: { size?: number; className?: string; converted?: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const m = `ctMask${uid}`;
    const dots = (fill?: string) => CT_DOT_X.map((cx, i) => <circle key={cx} className={`ct-d${i + 1}`} cx={cx} cy="128" r="12" fill={fill} />);
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {converted ? (
                <g className="ct-pop" fill="none" stroke="var(--converted-ink)" strokeWidth="16" strokeLinejoin="round">
                    <path d={CT_BUBBLE} />
                    <g fill="var(--converted-ink)" stroke="none">{dots()}</g>
                </g>
            ) : (
                <>
                    <mask id={m} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                        <rect x="0" y="0" width="256" height="256" fill="#fff" />
                        {dots("#000")}
                    </mask>
                    <g className="ct-pop"><path d={CT_BUBBLE} mask={`url(#${m})`} /></g>
                </>
            )}
        </svg>
    );
}
