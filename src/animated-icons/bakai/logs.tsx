import { useId } from "react";

/* ── Logs (Phosphor ClipboardText, fill): the tail scrolls ─────────────────────
   Sliding identical full-width lines past each other changes nothing on screen;
   real log lines are ragged, and the raggedness IS the motion. So there are six
   lines on the same 32-unit pitch with widths

     64  64  40  64  64  40

   and the window steps THREE times. Period three against a two-line window lets
   the rest state stay Phosphor's (both lines full width) while every
   intermediate landing is visibly different:

     start  64 64   (Phosphor)      step2  40 64
     step1  64 40                   step3  64 64   (back to the start)

   A period-two pattern that matches Phosphor at rest forces every line to the
   same width, which makes the scroll invisible.  */
const CLIP_BODY =
    "M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Z";
const CLIP_TAB = "M128,32a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Z";
const LOG_PITCH = 32;
/* one line: y is the underside it sits on, w the width of its top edge. w=64 is
   Phosphor's own, as are the 8-radius caps. */
const logLine = (y: number, w: number) => `M${96 + w},${y}H96a8,8,0,0,1,0-16h${w}a8,8,0,0,1,0,16Z`;
const LOG_LINES = [64, 64, 40, 64, 64, 40];

export function ClipboardTextLive({ size = 16, className }: { size?: number; className?: string }) {
    /* Per-instance ids: url(#…) resolves document-wide, so with a hard-coded id
       every copy would animate the first copy's mask. */
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
                <g clipPath={`url(#${win})`}>
                    <g className="lgg-roll">
                        {LOG_LINES.map((w, i) => <path key={i} d={logLine(128 + i * LOG_PITCH, w)} fill="#000" />)}
                    </g>
                </g>
            </mask>
            <path d={CLIP_BODY} mask={`url(#${msk})`} />
        </svg>
    );
}
