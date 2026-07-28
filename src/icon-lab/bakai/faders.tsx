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

export const FADERS_CSS = `
@keyframes lg-fd-l-knob {
  0% { transform: translateY(0px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  19.101% { transform: translateY(-48px); }
  33.708% { transform: translateY(-48px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  52.809% { transform: translateY(32px); }
  67.416% { transform: translateY(32px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  86.517% { transform: translateY(0px); }
  100% { transform: translateY(0px); }
}

@keyframes lg-fd-l-up {
  0% { d: path("M56,40L56,112"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  19.101% { d: path("M56,40L56,64"); }
  33.708% { d: path("M56,40L56,64"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  52.809% { d: path("M56,40L56,144"); }
  67.416% { d: path("M56,40L56,144"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  86.517% { d: path("M56,40L56,112"); }
  100% { d: path("M56,40L56,112"); }
}

@keyframes lg-fd-l-lo {
  0% { d: path("M56,168L56,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  19.101% { d: path("M56,120L56,216"); }
  33.708% { d: path("M56,120L56,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  52.809% { d: path("M56,200L56,216"); }
  67.416% { d: path("M56,200L56,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  86.517% { d: path("M56,168L56,216"); }
  100% { d: path("M56,168L56,216"); }
}

@keyframes lg-fd-m-knob {
  0% { transform: translateY(0px); }
  6.742% { transform: translateY(0px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  25.843% { transform: translateY(80px); }
  40.449% { transform: translateY(80px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  59.551% { transform: translateY(48px); }
  74.157% { transform: translateY(48px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  93.258% { transform: translateY(0px); }
  100% { transform: translateY(0px); }
}

@keyframes lg-fd-m-up {
  0% { d: path("M128,40L128,64"); }
  6.742% { d: path("M128,40L128,64"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  25.843% { d: path("M128,40L128,144"); }
  40.449% { d: path("M128,40L128,144"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  59.551% { d: path("M128,40L128,112"); }
  74.157% { d: path("M128,40L128,112"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  93.258% { d: path("M128,40L128,64"); }
  100% { d: path("M128,40L128,64"); }
}

@keyframes lg-fd-m-lo {
  0% { d: path("M128,120L128,216"); }
  6.742% { d: path("M128,120L128,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  25.843% { d: path("M128,200L128,216"); }
  40.449% { d: path("M128,200L128,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  59.551% { d: path("M128,168L128,216"); }
  74.157% { d: path("M128,168L128,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  93.258% { d: path("M128,120L128,216"); }
  100% { d: path("M128,120L128,216"); }
}

@keyframes lg-fd-r-knob {
  0% { transform: translateY(0px); }
  13.483% { transform: translateY(0px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  32.584% { transform: translateY(-32px); }
  47.191% { transform: translateY(-32px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  66.292% { transform: translateY(-80px); }
  80.899% { transform: translateY(-80px); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  100% { transform: translateY(0px); }
}

@keyframes lg-fd-r-up {
  0% { d: path("M200,40L200,144"); }
  13.483% { d: path("M200,40L200,144"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  32.584% { d: path("M200,40L200,112"); }
  47.191% { d: path("M200,40L200,112"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  66.292% { d: path("M200,40L200,64"); }
  80.899% { d: path("M200,40L200,64"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  100% { d: path("M200,40L200,144"); }
}

@keyframes lg-fd-r-lo {
  0% { d: path("M200,200L200,216"); }
  13.483% { d: path("M200,200L200,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  32.584% { d: path("M200,168L200,216"); }
  47.191% { d: path("M200,168L200,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  66.292% { d: path("M200,120L200,216"); }
  80.899% { d: path("M200,120L200,216"); animation-timing-function: cubic-bezier(0.25,0.7,0.2,1); }
  100% { d: path("M200,200L200,216"); }
}
`;