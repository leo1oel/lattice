// Plugs, from the Phosphor-derived set built for the /linear-app sidebar.
//
// Phosphor ships each icon as ONE compound path, so nothing inside it can be animated
// independently. This is rebuilt from Phosphor's own fill geometry — same 256 viewBox,
// same coordinates, read straight out of the package — split into the pieces the gesture
// needs. At rest it is meant to be indistinguishable from the original; only the seams
// are new. Where a gesture only ADDS something (a spark leaving a bolt), the Phosphor
// glyph is left completely untouched and the new element is drawn beside it — always the
// safer route, and preferred wherever it works.

type P = { size?: number; className?: string };

/* ── Sources: the plug disconnects and snaps back in ──────────────────────────
   Phosphor's PlugsConnected fill is one compound path holding six subpaths, and
   the split is already sitting there waiting: four short sparks, then the two
   plug halves. Copied verbatim, only separated — no coordinate is rewritten.

     spark  ~(100,42)   up and a little left
     spark  ~( 42,100)  left and a little up
     spark  ~(214,156)  right and a little down
     spark  ~(156,214)  down and a little right
     plug A  cord runs to (237,18)   — the top-right half
     plug B  cord runs to (18,237)   — the bottom-left half

   The important thing the geometry gives away: the seam where the two halves
   butt together runs along the (1,1) diagonal — plug A's flat edge goes
   (106,83)→(168,144), plug B's closing edge goes (166,170)→(86,90), the same
   line. So the halves part PERPENDICULAR to that, A up-right and B down-left,
   which is also the direction each one's own cord already points.

   And the four sparks sit on the seam line extended, two off each end of the
   joint. They are not decoration scattered around the icon, they are the
   contact arcing. That is what the gesture is built on: pull the halves apart
   and the sparks die, slam them back and the sparks burst back out.           */
const PLUG_SPARKS = [
    "M88.57,35A8,8,0,0,1,103.43,29l8,20A8,8,0,0,1,96.57,55Z",
    "M29,103.43l20,8A8,8,0,1,0,55,96.57l-20-8A8,8,0,0,0,29,103.43Z",
    "M227,152.57l-20-8A8,8,0,1,0,201,159.43l20,8A8,8,0,0,0,227,152.57Z",
    "M159.43,201A8,8,0,0,0,144.57,207l8,20A8,8,0,1,0,167.43,221Z",
];
const PLUG_A =
    "M237.91,18.52a8,8,0,0,0-11.5-.18L174,70.75l-5.38-5.38a32,32,0,0,0-45.28,0L106.14,82.54a4,4,0,0,0,0,5.66l61.7,61.66a4,4,0,0,0,5.66,0l16.74-16.74a32.76,32.76,0,0,0,9.81-22.52,31.82,31.82,0,0,0-9.37-23.17l-5.38-5.37,52.2-52.17A8.22,8.22,0,0,0,237.91,18.52Z";
const PLUG_B =
    "M85.64,90.34a8,8,0,0,0-11.49.18,8.22,8.22,0,0,0,.41,11.37L80.67,108,65.34,123.31A31.82,31.82,0,0,0,56,146.47,32.75,32.75,0,0,0,65.77,169l5,4.94L18.49,226.13a8.21,8.21,0,0,0-.61,11.1,8,8,0,0,0,11.72.43L82,185.25l5.37,5.38a32.1,32.1,0,0,0,45.29,0L148,175.31l6.34,6.35a8,8,0,0,0,11.32-11.32Z";

export function PlugsLive({ size = 16, className }: P) {
    return (
        // clipped, not overflow-visible: the cords are SUPPOSED to be cut off by
        // the tile as the halves pull apart, which is what sells them being
        // yanked out of frame rather than shrinking.
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {/* one group, scaled about the icon centre, so all four fly out
                along the joint together instead of each growing in place */}
            <g className="lgp-spark">
                {PLUG_SPARKS.map((d) => (
                    <path key={d} d={d} />
                ))}
            </g>
            <path className="lgp-a" d={PLUG_A} />
            <path className="lgp-b" d={PLUG_B} />
        </svg>
    );
}
