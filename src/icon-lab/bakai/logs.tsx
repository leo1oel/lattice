// Logs, from the Phosphor-derived set built for the /linear-app sidebar.
//
// Phosphor ships each icon as ONE compound path, so nothing inside it can be animated
// independently. This is rebuilt from Phosphor's own fill geometry — same 256 viewBox,
// same coordinates, read straight out of the package — split into the pieces the gesture
// needs. At rest it is meant to be indistinguishable from the original; only the seams
// are new. Where a gesture only ADDS something (a spark leaving a bolt), the Phosphor
// glyph is left completely untouched and the new element is drawn beside it — always the
// safer route, and preferred wherever it works.

import { useId } from "react";

type P = { size?: number; className?: string };

/* ── Logs: the tail scrolls ──────────────────────────────────────────────────
   The first version of this was invisible, and for a reason worth writing down:
   all four lines were Phosphor's identical full width, so sliding them past each
   other changed literally nothing on screen. A scroll you cannot see is not a
   scroll. Real log lines are ragged, and the raggedness IS the motion.

   So there are six lines on the same 32-unit pitch with widths

     64  64  40  64  64  40

   and the window steps THREE times instead of two. Period three against a
   two-line window is what lets the rest state stay Phosphor's — both lines full
   width — while every intermediate landing is visibly different:

     start  64 64   (Phosphor)      step2  40 64
     step1  64 40                   step3  64 64   (back to the start)

   Two steps could not do this. With a period-two pattern, matching Phosphor at
   rest forces every line to the same width, which is exactly the invisible
   version I started with. The third step is what buys both properties at once.  */
const CLIP_BODY =
    "M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Z";
const CLIP_TAB = "M128,32a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Z";
const LOG_PITCH = 32;
/* one line: y is the underside it sits on, w the width of its top edge. w=64 is
   Phosphor's own. The 8-radius caps are hers too. */
const logLine = (y: number, w: number) => `M${96 + w},${y}H96a8,8,0,0,1,0-16h${w}a8,8,0,0,1,0,16Z`;
const LOG_LINES = [64, 64, 40, 64, 64, 40];

export function ClipboardTextLive({ size = 16, className }: P) {
    /* This glyph is the ONE in the set rendered more than once — Production and
       Staging expand to the same PROJECT_SUBS array, so there are two Logs rows.
       With a hard-coded id both resolve url(#…) to whichever mask came first, so
       hovering the top row animated the bottom row's icon and the bottom row
       could never animate at all. */
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const win = `lgLogWindow-${uid}`;
    const msk = `lgLogMask-${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            <clipPath id={win}>
                <rect x="88" y="100" width="80" height="68" />
            </clipPath>
            <mask id={msk} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                <rect width="256" height="256" fill="#fff" />
                <path d={CLIP_TAB} fill="#000" />
                {/* everything past the first two is still queued below the window */}
                <g clipPath={`url(#${win})`}>
                    <g className="lgg-roll">
                        {LOG_LINES.map((w, i) => (
                            <path key={i} d={logLine(128 + i * LOG_PITCH, w)} fill="#000" />
                        ))}
                    </g>
                </g>
            </mask>
            <path d={CLIP_BODY} mask={`url(#${msk})`} />
        </svg>
    );
}

export const CLIPBOARDTEXT_CSS = `
/* The tail. THREE steps of one line pitch with a hold on each landing. Three,
   not two, because the line widths run on a period of three — that is what lets
   every landing differ while the first and last are both Phosphor's two full
   lines. Each hold is an arrival; without them it is one long slide. */
.lgg-roll { transform-box: view-box; }
@keyframes lg-tail {
  0%, 12%   { transform: translateY(0); animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1); }
  26%       { transform: translateY(-32px); }
  46%       { transform: translateY(-32px); animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1); }
  60%       { transform: translateY(-64px); }
  78%       { transform: translateY(-64px); animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1); }
  92%       { transform: translateY(-96px); }
  100%      { transform: translateY(-96px); }
}
`;