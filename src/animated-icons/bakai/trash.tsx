// Trash glyph, rebuilt from Bakai's Figma prep on the "svg building" canvas
// (file 41t3L23xwUsiE4CPRBYe6M, frame "trash…" 1416:87). That frame holds the
// ORIGINAL closed bin on the left and Bakai's DIVIDED open version on the right.
//
//   1. The RIM LINE ("M64 54 H124") is the bin's mouth and stays put; only the
//      bar + handle arch lift off. At rest the wider lid bar covers the rim, so
//      the resting picture is the plain original bin.
//   2. The garbage goes IN. Bakai: "we shouldn't be able to see them after they
//      pass a certain line… it's inside the trash can."
//
// v3 (Bakai): the falling garbage was two tiny abstract bits; he wanted bigger,
// more MATERIAL, recognisable trash — "banana peels or something" — and four or
// five of them, one after another. So the bits are now five structured pieces
// (banana, paper wad, apple core, bottle, fish bone) that tumble in one at a
// time and are swallowed at the mouth.
//
// NO OPACITY (Bakai's hard rule): each piece is parked ABOVE the mouth where a
// clipPath hides it, drops through the visible chute (y 20–56), and is clipped
// again the instant it passes the rim — real motion + clip only, never a fade.
//
// Keyframes use the `lg-` prefix so the icon-lab driver picks them up; base rules
// live here; the [data-go] trigger map lives in tools/icon-lab/main.tsx.

import { useId } from "react";

type P = { size?: number; className?: string };

/* the fixed bin — two side walls (rim closes the top), the mouth/rim, two tines */
const TR_BODY =
    "M124 54L121.521 94.1004C120.888 104.346 120.571 109.468 118.003 113.152C116.733 114.972 115.099 116.509 113.203 117.664C109.368 120 104.236 120 93.9708 120C83.6925 120 78.5532 120 74.7162 117.66C72.8192 116.503 71.184 114.963 69.9147 113.139C67.3475 109.45 67.0378 104.32 66.4184 94.0608L64 54";
const TR_RIM = "M64 54H124";
const TR_TINE_1 = "M83.9999 98V74";
const TR_TINE_2 = "M104 98V74";
/* the lid = rim bar (a touch wider than the mouth) + the handle arch — the only
   part that hinges away */
const TR_BAR = "M58 54H130";
const TR_ARCH =
    "M110.223 54L107.492 48.367C105.678 44.6251 104.771 42.7541 103.207 41.5873C102.86 41.3284 102.492 41.0982 102.108 40.8988C100.376 40 98.2964 40 94.138 40C89.8752 40 87.744 40 85.9827 40.9365C85.5924 41.1441 85.2199 41.3836 84.8692 41.6527C83.2866 42.8668 82.4025 44.8062 80.6344 48.6851L78.2117 54";

/* the five pieces of garbage, each authored centred on its own local (0,0) so a
   wrapper <g transform> places it and the CSS transform (fall + tumble) rides the
   child — filled silhouettes except the fish bone, which is drawn as strokes. */
const TR_BANANA = "M-12,-4 C-9,7 9,7 12,-4 C11,-2.5 10,-1.5 8.6,-0.6 C5,-2.5 -5,-2.5 -8.6,-0.6 C-10,-1.5 -11,-2.5 -12,-4 Z";
const TR_PAPER = "M-10,-4 L-5,-10 L1,-9 L7,-11 L11,-4 L8,1 L10,8 L3,10 L-4,11 L-9,6 L-11,1 Z";
const TR_CORE =
    "M-7,-8 C-2,-10 2,-10 7,-8 C5,-4.5 2.5,-2.5 1.2,-1 C1.2,-0.3 1.2,0.3 1.2,1 C2.5,2.5 5,4.5 7,8 C2,10 -2,10 -7,8 C-5,4.5 -2.5,2.5 -1.2,1 C-1.2,0.3 -1.2,-0.3 -1.2,-1 C-2.5,-2.5 -5,-4.5 -7,-8 Z M-1.6,-8 L-1.6,-12 C-1.6,-13.3 1.6,-13.3 1.6,-12 L1.6,-8 Z";
const TR_BOTTLE =
    "M-4,-11 L4,-11 L4,-8 C4,-6 6,-5 6,-2 L6,9 C6,11 5,12 3,12 L-3,12 C-5,12 -6,11 -6,9 L-6,-2 C-6,-5 -4,-6 -4,-8 Z M-3,-14 L3,-14 L3,-11 L-3,-11 Z";
const TR_FISHBONE =
    "M-8,0 A2.2,2.2 0 1 0 -12.4,0 A2.2,2.2 0 1 0 -8,0 M-8,0 L7,0 M7,0 L12,-4 M7,0 L12,4 M-5,-4 L-5,4 M-1,-5 L-1,5 M3,-4 L3,4";

export function TrashLive({ size = 16, className }: P) {
    // per-instance clip id so two trash icons on one page don't share a mouth
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const clip = `trMouth-${uid}`;
    return (
        <svg
            width={size}
            height={size}
            viewBox="46 32 96 96"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            overflow="visible"
            className={className}
        >
            {/* the chute: pieces are only visible between y=20 (just above the bin)
                and y=56 (a hair under the mouth). Above it they are parked & hidden;
                below it they are inside the can and unseen — no opacity anywhere. */}
            <clipPath id={clip}>
                <rect x="46" y="20" width="96" height="36" />
            </clipPath>
            {/* the garbage — drawn before the bin so the rim reads in front of it.
                Each piece parks above the chute and tumbles in, one after another. */}
            <g clipPath={`url(#${clip})`} fill="currentColor" stroke="none">
                <g transform="translate(88,4)">
                    <path className="tr-i1" d={TR_BANANA} />
                </g>
                <g transform="translate(99,4)">
                    <path className="tr-i2" d={TR_PAPER} />
                </g>
                <g transform="translate(90,4)">
                    <path className="tr-i3" d={TR_CORE} />
                </g>
                <g transform="translate(101,4)">
                    <path className="tr-i4" d={TR_BOTTLE} />
                </g>
                <g transform="translate(85,4)">
                    <path
                        className="tr-i5"
                        d={TR_FISHBONE}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </g>
            </g>
            {/* the fixed bin: body, its mouth/rim, and the two tines */}
            <path d={TR_BODY} />
            <path d={TR_RIM} />
            <path d={TR_TINE_1} />
            <path d={TR_TINE_2} />
            {/* the lid lifts off (rim bar + handle), leaving the mouth behind */}
            <g className="tr-lid">
                <path d={TR_BAR} />
                <path d={TR_ARCH} />
            </g>
        </svg>
    );
}
