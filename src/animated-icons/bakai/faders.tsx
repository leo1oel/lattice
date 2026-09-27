/* ── Faders ───────────────────────────────────────────────────────────────────
   Phosphor `Faders`, FILL weight, 256 viewBox.

   THE GESTURE: the three knobs take each other's settings, in a cycle, three
   times — a 3-cycle applied three times IS the identity, so every knob ends
   where it started without travelling back (an out-and-back would read as a
   spring-loaded control, which a fader is not). The knob centres 128, 80 and
   160 are the only positions any knob ever visits:
     left    128 -> 80  -> 160 -> 128
     middle  80  -> 160 -> 128 -> 80
     right   160 -> 128 -> 80  -> 160
   so every intermediate frame is a real fader board, not a pose.

   THE RAILS ARE SPLIT THE WAY THE SOURCE SPLITS THEM: an upper stem, a knob,
   and a lower stem with a 16u break BELOW every knob. Round caps reproduce the
   break exactly — the lower stem's centreline starts 24 below the knob, so its
   cap lands the ink at 16.

   The stems MORPH rather than scale: scaleY about the anchor would squash the
   rounded top cap into an ellipse. As two-point paths only the free end moves,
   and they carry the knob's curve so the weld never opens.

   0.89s: steps of 300ms (170 moving, 130 landed) with a 60ms stagger, so they
   read as three independent controls. The curve's start slope of 2.8 makes a
   knob leave decisively; a flat start reads as lag.  */

import { Fragment } from "react";

const KNOB = { rx: 8, width: 64, height: 32 } as const;
const RAIL = { fill: "none", strokeWidth: 16, strokeLinecap: "round" } as const;
/* rail x and resting knob top; the lower stem starts 56 below it (knob 32 + 24) */
const FADERS = [["l", 56, 112], ["m", 128, 64], ["r", 200, 144]] as const;

export function FadersLive({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" stroke="currentColor" className={className}>
            {FADERS.map(([id, x, knob]) => (
                <Fragment key={id}>
                    <path className={`fd-${id}-up`} d={`M${x},40L${x},${knob}`} {...RAIL} />
                    <path className={`fd-${id}-lo`} d={`M${x},${knob + 56}L${x},216`} {...RAIL} />
                    <rect className={`fd-${id}-knob`} x={x - 32} y={knob} {...KNOB} stroke="none" />
                </Fragment>
            ))}
        </svg>
    );
}
