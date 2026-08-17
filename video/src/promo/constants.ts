/** Canvas. Render at --scale 1.5 for 1080p. */
export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 720;

/** All three captures are 3244x2160 @ 60fps, so one set of constants works for
 *  any of them. Part 1 is the tour, part 2 the paper library, part 3 the agent. */
export const RECORDING_SRC = "Research-writer.mp4";
export const RECORDING_2_SRC = "Research-writer-2.mp4";
export const RECORDING_3_SRC = "Research-writer-3.mp4";

/** Capture lengths in composition frames: 47.5s, 42.5s and 40.4s at 30fps. */
export const RECORDING_FRAMES = 1425;
export const RECORDING_2_FRAMES = 1275;
export const RECORDING_3_FRAMES = 1212;

/** Sampled from the app's own UI in the recording (buttons, callouts) rather
 *  than picked by eye — see the hue histogram in the setup notes. */
export const ACCENT = "#7165d6";
export const ACCENT_TEXT = "#b3a8f7";
/** Near-black with a trace of blue. Only the title and outro cards show it now
 *  that the footage is full bleed. */
export const BG = "#08080b";
export const FG = "#fafafa";
export const MUTED = "#9b9ba6";

/** Set to the real site to add a URL line to the outro. Left null on purpose —
 *  guessing a domain and shipping it in a promo is worse than having no URL. */
export const CTA_URL: string | null = null;

/** Source seconds -> composition frames. */
export const sec = (s: number) => Math.round(s * FPS);
