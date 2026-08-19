/**
 * Canvas. Render at --scale 1.5 for 1080p.
 *
 * 60fps, not 30: every capture is a true constant 60fps screen recording with
 * smooth camera pans, and sampling that down to 30 threw away every second
 * frame. The pans juddered and read as "the framerate drops sometimes". The
 * output now matches the source cadence.
 */
export const FPS = 60;
export const WIDTH = 1280;
export const HEIGHT = 720;

/** Captures. The first three are 3244x2160; share.mp4 is 4:3 and Area.mp4 is
 *  wider, which is why ScreenCard takes a `focus` — see its notes. */
export const RECORDING_SRC = "Research-writer.mp4";
export const RECORDING_2_SRC = "Research-writer-2.mp4";
export const RECORDING_3_SRC = "Research-writer-3.mp4";
export const RECORDING_SHARE_SRC = "share.mp4";
export const RECORDING_OVERLEAF_SRC = "Area.mp4";

/** Capture lengths in frames, straight off ffprobe's nb_frames at 60fps. */
export const RECORDING_FRAMES = 2850;
export const RECORDING_2_FRAMES = 2550;
export const RECORDING_3_FRAMES = 2425;
export const RECORDING_SHARE_FRAMES = 385;
export const RECORDING_OVERLEAF_FRAMES = 1579;

/** Light theme. The app being demoed is a light UI, so a near-white stage lets
 *  the footage sit in the frame instead of being a bright panel punched out of
 *  a dark one. Not pure white: #fff leaves the white app window with no edge. */
export const BG = "#f1f1f4";
export const FG = "#111114";
export const MUTED = "#65656f";

/** App icon yarns (src-tauri/icons/app-icon.svg). The film's accent used to be
 *  the app UI purple; it now follows the mark so the title wash, captions and
 *  format icons sit in the same family as the lockup. */
export const ICON_BLUE = "#4568F6";
export const ICON_BLUE_LIGHT = "#6F8EFF";
export const ICON_CYAN = "#55D4C5";
export const ICON_CYAN_DEEP = "#25B4BB";

export const ACCENT = ICON_BLUE;
/** Darkened from ICON_BLUE so 18px caption labels still contrast on white. */
export const ACCENT_TEXT = "#2F4CC4";

/** Inter — captions, taglines, UI-like labels. */
export const FONT_SANS = "var(--font-geist-sans)";
/** Fraunces — brand word and section titles. Soft + wonk are set per use. */
export const FONT_DISPLAY = "var(--font-display)";
/** Fraunces axes. Must include `opsz` — `font-variation-settings` replaces
 *  the whole axis set, so leaving it out locks the caption cut (opsz 14)
 *  onto 96px type and reads as blown-up Times. */
export const displayVars = (opsz: number) =>
  `"opsz" ${opsz}, "SOFT" 30, "WONK" 1`;

/** Set to the real site to add a URL line to the outro. Left null on purpose —
 *  guessing a domain and shipping it in a promo is worse than having no URL. */
export const CTA_URL: string | null = null;

/** Seconds -> frames. */
export const sec = (s: number) => Math.round(s * FPS);
