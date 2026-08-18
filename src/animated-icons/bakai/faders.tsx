"use client";

/* ── Faders ───────────────────────────────────────────────────────────────────
   Phosphor `Faders`, FILL weight, 256 viewBox. Nav word: "Filters".

   THE GESTURE: the three knobs take each other's settings, in a cycle, three
   times — and the third cycle puts every knob back where it started. This is the
   Kanban congruence trick generalised: a 3-cycle applied three times IS the
   identity, so nothing has to travel back and the gesture is one-way even though
   the icon must rest unchanged. An out-and-back on a fader would read as a
   spring-loaded control, which a fader is not.

   EVERY LANDING IS A MARK THE SOURCE ALREADY DRAWS. The knob centres are 128, 80
   and 160, and those three values are the only positions any knob ever visits:
     left    128 -> 80  -> 160 -> 128
     middle  80  -> 160 -> 128 -> 80
     right   160 -> 128 -> 80  -> 160
   No travel distance was chosen. They are the icon's own three settings being
   permuted, which is also why every intermediate frame is a real fader board and
   not a pose (FAMILIES #8: every landing must look different from the others,
   and the first and last must be the source glyph).

   THE RAILS ARE SPLIT THE WAY THE SOURCE SPLITS THEM. Each fader is an upper
   stem, a knob, and a lower stem, with a 16u break BELOW every knob — that break
   is in the source (left knob ends 144, lower stem ink starts 160) and it is
   what makes the knob read as sitting ON the rail rather than through it. Round
   caps reproduce it exactly: the lower stem's centreline starts 24 below the
   knob, so its cap lands the ink at 16. Rasterised at 512px against the
   untouched source path: ZERO pixels differ by more than 128.

   WHY THE STEMS MORPH RATHER THAN SCALE. A stem is an appendage welded at one
   end, so the instinct is scaleY from the anchor (TECHNIQUE, appendages). It is
   wrong here: scaling a vertical stroked line about its top cap squashes that
   cap into an ellipse and the rail's rounded top visibly deforms. The stems are
   two-point paths instead, so only the free end moves and the interpolation is
   exact — and they carry the same curve as the knob, so the weld never opens.

   0.89s. Steps of 300ms (170 moving, 130 landed — FAMILIES #8 wants the hold to
   be about as long as the step) with a 60ms stagger across the three faders, so
   they read as three independent controls rather than one object. The curve has
   a start slope of 2.8: a knob pushed by a hand leaves decisively and settles,
   and a flat start is what reads as lag.  */

const KNOB = { rx: 8, width: 64, height: 32 } as const;
const RAIL = { fill: "none", strokeWidth: 16, strokeLinecap: "round" } as const;

export function FadersLive({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" stroke="currentColor" className={className}>
            <path className="fd-l-up" d="M56,40L56,112" {...RAIL} />
            <path className="fd-l-lo" d="M56,168L56,216" {...RAIL} />
            <rect className="fd-l-knob" x="24" y="112" {...KNOB} stroke="none" />

            <path className="fd-m-up" d="M128,40L128,64" {...RAIL} />
            <path className="fd-m-lo" d="M128,120L128,216" {...RAIL} />
            <rect className="fd-m-knob" x="96" y="64" {...KNOB} stroke="none" />

            <path className="fd-r-up" d="M200,40L200,144" {...RAIL} />
            <path className="fd-r-lo" d="M200,200L200,216" {...RAIL} />
            <rect className="fd-r-knob" x="168" y="144" {...KNOB} stroke="none" />
        </svg>
    );
}
