/**
 * There is only one transition system in this film, and it is `SceneMotion`:
 * every scene eases its own whole screen in and out, and drifts continuously in
 * between so no frame is ever frozen.
 *
 * The `TransitionSeries` therefore uses `none()` — it is here purely to overlap
 * neighbouring scenes so their envelopes cross, not to draw anything. Layering
 * a real presentation (fade, focus-pull, whip-pan) on top would mean two
 * transitions running at once, which is exactly what the brief rules out.
 *
 * The overlap has to be at least as long as the longest `enter`/`exit` either
 * side of it, or a scene would still be fading when its neighbour unmounts and
 * the bare stage would flash through.
 */
export const OVERLAP_FRAMES = 30;
