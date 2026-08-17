/**
 * Every cut in the film is a plain opacity crossfade.
 *
 * Earlier versions used remocn's focus-pull and push-through, which defocus and
 * lift exposure through the cut. Against two white app windows that reads as a
 * blur followed by a flash — distracting rather than premium. A straight
 * dissolve draws no attention to itself, which is the point: the cut should be
 * the least interesting thing in the frame.
 *
 * Note what is NOT here: a transition between consecutive moments of the same
 * continuous take. Each recording plays as one unbroken run, because
 * cross-fading between overlapping slices of one shot shows the same action
 * twice, a beat apart. See partOne.tsx.
 */

/** Card to footage, and footage to card. */
export const CUT_FRAMES = 24;

/** Where the edit actually skips ahead within a recording. Short: the viewer
 *  should register a jump, not admire a dissolve. */
export const JUMP_FRAMES = 16;

/** Slightly longer where a card starts or ends a stretch, so the type has room
 *  to settle. Still the same plain dissolve — nothing special happens here. */
export const CARD_CUT_FRAMES = 30;
