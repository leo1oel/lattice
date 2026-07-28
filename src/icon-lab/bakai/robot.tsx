/* Robot — Phosphor "robot" (fill). 256 viewBox.

   The eyes are knockout holes in the solid face, so they move via the mask:
   the body path keeps its antenna and the three mouth-grille knockouts
   (re-anchored to absolute coordinates because the source's relative `m`
   subpaths chained off the removed eye subpaths), and the two r12 eyes at
   (84,108) and (172,108) become black circles in the mask.

   The gesture: the robot scans. Both eyes glance left 11u, hold, sweep
   right 11u, hold, recentre — discrete step-and-hold moves, an eye's own
   verb — then one quick blink (scaleY 1→0.12→1 about each eye's centre).
   Both eyes share one keyframe set; only the transform-origins differ. */

import { useId } from "react";

const RB_BODY =
    "M200,48H136V16a8,8,0,0,0-16,0V48H56A32,32,0,0,0,24,80V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V80A32,32,0,0,0,200,48ZM96,184H80a16,16,0,0,1,0-32H96Zm48,0H112V152h32Zm32,0H160V152h16a16,16,0,0,1,0,32Z";
const RB_OUTER = "M200,48H136V16a8,8,0,0,0-16,0V48H56A32,32,0,0,0,24,80V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V80A32,32,0,0,0,200,48Z";
const RB_GRILLE = ["M96,184H80a16,16,0,0,1,0-32H96Z", "M144,184H112V152h32Z", "M176,184H160V152h16a16,16,0,0,1,0,32Z"];

export function RobotLive({ size = 16, className, converted }: { size?: number; className?: string; converted?: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const m = `rbMask${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {converted ? (
                <>
                    <path d={RB_OUTER} fill="none" stroke="var(--converted-ink)" strokeWidth="16" strokeLinejoin="round" />
                    <g fill="var(--converted-ink)">
                        <circle className="rb-e1" cx="84" cy="108" r="12" />
                        <circle className="rb-e2" cx="172" cy="108" r="12" />
                        {RB_GRILLE.map((d) => <path key={d} d={d} />)}
                    </g>
                </>
            ) : (
                <>
                    <mask id={m} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                        <rect x="0" y="0" width="256" height="256" fill="#fff" />
                        <circle className="rb-e1" cx="84" cy="108" r="12" fill="#000" />
                        <circle className="rb-e2" cx="172" cy="108" r="12" fill="#000" />
                    </mask>
                    <path d={RB_BODY} mask={`url(#${m})`} />
                </>
            )}
        </svg>
    );
}

export const ROBOT_CSS = `
.rb-e1 { transform-box: view-box; transform-origin: 84px 108px; }
.rb-e2 { transform-box: view-box; transform-origin: 172px 108px; }

/* glance left, hold, sweep right, hold, recentre, blink once */
@keyframes lg-robot-eyes {
  0%   { transform: translateX(0) scaleY(1); }
  8%   { transform: translateX(0) scaleY(1); animation-timing-function: cubic-bezier(0.3,0.9,0.35,1); }
  16%  { transform: translateX(-11px) scaleY(1); }
  38%  { transform: translateX(-11px) scaleY(1); animation-timing-function: cubic-bezier(0.45,0,0.55,1); }
  50%  { transform: translateX(11px) scaleY(1); }
  68%  { transform: translateX(11px) scaleY(1); animation-timing-function: cubic-bezier(0.3,0.9,0.35,1); }
  78%  { transform: translateX(0) scaleY(1); }
  84%  { transform: translateX(0) scaleY(1); animation-timing-function: cubic-bezier(0.55,0,0.9,0.45); }
  88%  { transform: translateX(0) scaleY(0.12); animation-timing-function: cubic-bezier(0.25,0.9,0.3,1); }
  93%  { transform: translateX(0) scaleY(1); }
  100% { transform: translateX(0) scaleY(1); }
}
`;
