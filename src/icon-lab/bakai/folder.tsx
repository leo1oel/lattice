"use client";

import { useId } from "react";

/* ── Folder ───────────────────────────────────────────────────────────────────
   Phosphor Folder ⇄ Phosphor FolderOpen, FILL weight, 256 viewBox.

   IT OPENS AND SHUTS, and both ends are Phosphor's own drawings. Bakai: "u can find
   folder open svg in phosphor… so basically open and close", then "just take the end
   one as the open folder icon, in same phosphor icon."

   THE ONLY THING THAT MOVES IS THE FRONT PANEL, and it does not transform — it travels
   between two authored shapes: `Folder`'s pocket and `FolderOpen`'S OWN SLAB, lifted
   out of that glyph verbatim (top edge y104, the wing out to x247.18, r8 base corners).
   An earlier pass approximated that pose with a skew and a scale and measured 2649px
   away from the real drawing: close, not it. A transform could never get there anyway —
   the slab's top edge is 162u wide against a 179u base, and no affine map narrows one
   end of a rectangle more than the other.

   THE WHITE IS NEVER DRAWN AND NEVER MOVES. Bakai: "the white is bad, it should be
   proper… no need to morph, just mask so it is always there, so white won't move." An
   earlier version morphed the whole glyph including its hole, so the gap was a
   different shape on every frame — at 40px that reads as a hairline slot cracking open,
   and the fold line fattens again on the way back. Here every white in the icon is just
   BACKGROUND between static parts:
     · the fold notch is a hole in the tab, exactly where Phosphor cut it, and it never
       moves because the tab never moves;
     · the open aperture is the gap the panel leaves when it travels off the back.
   Nothing interpolates the white. It is only ever covered or uncovered.

   THE PARTS. Three are static, painted first; the panel is painted last, which is what
   hides them at rest:
     · TAB — the source above y72, its fold notch knocked out with evenodd, carrying a
       6u skirt down to y78 so the cut is an OVERLAP, not a butted edge (butted edges
       composite 0.5 over 0.5 = 0.75 and show as a light hairline).
       THE NOTCH HOLE IS CUT 6u DEEPER THAN PHOSPHOR CUT IT, to y78, following its own
       45° edge. At rest that makes no difference — the panel covers y72 down, so the
       notch you see is Phosphor's exactly. Open, it is what stops the skirt becoming a
       random black bar across the aperture: Bakai, "there is a single line separating
       the tongue from the main one." With the hole deepened, the skirt only survives at
       x24-40 and x114.69-137.31, and both of those sit over back-panel ink, so the
       overlap is invisible in BOTH states instead of only one.
     · BACK — `FolderOpen` ITSELF, clipped to the pocket. What survives the clip is
       exactly the part of that glyph the slab does not cover: its left wall, its top
       bar and lip, and its own aperture. An earlier pass hand-built those out of rects
       held 2u clear of the silhouette, to avoid two shapes inking the same edge — and
       every one of those 2u gaps showed as a WHITE HAIRLINE the moment the panel moved
       off them. Bakai: "wtf the lines are weird, it is not filled." Parts of one filled
       glyph must OVERLAP, never clear each other; a doubled edge darkens by a quarter
       of a pixel, a gap is a visible line.
     · PANEL — the pocket, every arc verbatim from the source, written onto the same
       13-command list as the slab (M H A A L A H A V H L A Z) so `d` interpolates.
       Where the pocket has no counterpart for the wing, the segment is degenerate, so
       the wing unfolds out of the corner instead of popping.

   Rest is `Folder`: tab ∪ pocket, with the back clipped away underneath.
   Open is `FolderOpen`, except its tab strip is `Folder`'s, sitting 8u higher — the tab
   is what rests, and rest has to be exact.

   0.72s: thrown open in 216ms leaving fast, a beat, dropped shut in 245ms ACCELERATING
   because it falls rather than being placed, then one bounce.  */

type P = { size?: number; className?: string };

/* the icon itself, verbatim, kept for the verification harness */
export const FD_SRC =
    "M216,72H131.31L104,44.69A15.88,15.88,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.41,15.41,0,0,0,39.39,216h177.5A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40Z";

/* FolderOpen itself, verbatim. It is the back panel: clipped to the pocket, what
   survives is exactly the part of that glyph the slab is not covering — wall, bar, lip
   and its own aperture. No hand-built pieces, so there are no seams to show. */
const FD_SRC_OPEN =
    "M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Z";

/* above y72 plus the 6u skirt; the fold notch stays a hole via evenodd */
const FD_TAB =
    "M131.31,72L104,44.69A15.88,15.88,0,0,0,92.69,40H40A16,16,0,0,0,24,56V78H137.31ZM40,56H92.69l16,16l6,6H40Z";

/* the panel, shut: the source's pocket, arcs verbatim, on the slab's command list */
const FD_PANEL =
    "M24,72H216A16,16,0,0,1,232,88A16,16,0,0,1,232,88L232,200.89A15.13,15.13,0,0,1,216.89,216H39.39A15.41,15.41,0,0,1,24,200.62V72H24L24,72A16,16,0,0,1,24,72Z";
/* the panel, open: FolderOpen's slab, lifted out of that glyph */
const FD_SLAB =
    "M69.77,104H232A16,16,0,0,1,245,110.64A16.05,16.05,0,0,1,247.18,125.06L218.69,210.53A8,8,0,0,1,211.1,216H32A8,8,0,0,1,24,208V158.7H40L54.59,114.94A16,16,0,0,1,69.77,104Z";
/* lerp(panel, slab, 1.08) — thrown a little past open; and 0.08 — the bounce off shut */
const FD_OVER =
    "M73.43,106.56H233.28A16,16,0,0,1,246.04,112.45A16.05,16.05,0,0,1,248.39,128.02L217.63,211.3A7.43,7.43,0,0,1,210.64,216H31.41A7.41,7.41,0,0,1,24,208.59V165.64H41.28L57.04,118.38A16,16,0,0,1,73.43,106.56Z";
const FD_BOUNCE =
    "M27.66,74.56H217.28A16,16,0,0,1,233.04,89.81A16,16,0,0,1,233.21,90.96L230.94,201.66A14.56,14.56,0,0,1,216.43,216H38.8A14.82,14.82,0,0,1,24,201.21V78.94H25.28L26.45,75.44A16,16,0,0,1,27.66,74.56Z";

export function FolderLive({ size = 16, className }: P) {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const clip = `fdc-${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {/* clipped to the pocket: below y72 and inside the closed silhouette, which
                is exactly the region the panel covers at rest */}
            <clipPath id={clip}>
                <path d={FD_PANEL} />
            </clipPath>
            <g clipPath={`url(#${clip})`}>
                <path d={FD_SRC_OPEN} />
            </g>
            <path d={FD_TAB} fillRule="evenodd" />
            {/* painted last, so at rest it hides the back completely */}
            <path className="fd-lid" d={FD_PANEL} />
        </svg>
    );
}

export const FOLDER_CSS = `
/* REST, declared here and not only at 0%: shut */
.lg-folder .fd-lid { d: path("${FD_PANEL}"); }

/* The panel travels between the pocket and FolderOpen's slab. 30% goes a little past
   open and rocks back, because a lid thrown open does not stop dead on the mark; 88%
   is the bounce off shut. */
@keyframes lg-folder-open {
  0%   { d: path("${FD_PANEL}");  animation-timing-function: cubic-bezier(0.3,0.62,0.36,1); }
  30%  { d: path("${FD_OVER}");   animation-timing-function: cubic-bezier(0.4,0,0.35,1); }
  42%  { d: path("${FD_SLAB}"); }
  46%  { d: path("${FD_SLAB}");   animation-timing-function: cubic-bezier(0.45,0,0.8,0.5); }
  78%  { d: path("${FD_PANEL}");  animation-timing-function: cubic-bezier(0.3,0,0.45,1); }
  87%  { d: path("${FD_BOUNCE}"); animation-timing-function: cubic-bezier(0.4,0,0.3,1); }
  100% { d: path("${FD_PANEL}"); }
}
`;