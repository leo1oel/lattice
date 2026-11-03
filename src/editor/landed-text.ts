/**
 * The text an outside edit (the agent's, another app's) just put in the open
 * file, until the source editor takes it: the editor marks the lines that
 * changed as it applies that text (change-marks.ts). Kept apart from the
 * editor's own code because the disk check that notes it runs before any
 * editor has loaded.
 */
let landed: { text: string; at: number } | null = null;

/** How long a noted text waits for the editor; it waits out typing (codemirror-host.tsx) for far less. */
const LANDED_WAIT_MS = 10_000;

/** The open file now reads `text`, from outside the writer's own editing. */
export function noteLandedText(text: string): void {
  landed = { text, at: Date.now() };
}

/**
 * Whether `matches` says the editor's new text is the noted one; a match
 * takes it, so it marks one edit once.
 */
export function takeLandedText(matches: (text: string) => boolean): boolean {
  if (!landed) return false;
  if (Date.now() - landed.at > LANDED_WAIT_MS) {
    landed = null;
    return false;
  }
  if (!matches(landed.text)) return false;
  landed = null;
  return true;
}
