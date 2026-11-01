/**
 * Writing the open edits when part of the UI crashes.
 *
 * Autosave waits for a pause in typing, and the visual Markdown editor hands
 * its edits to the document only after a debounce, so the last second of work
 * lives in components a render error is about to unmount. The project window
 * registers its save here (useSaveBeforeClose), and the error boundaries start
 * it as they catch, while the crashed tree is still mounted: by the time
 * `componentDidCatch` runs, React has already run that tree's layout cleanups,
 * and the visual editor's flush unregisters in one.
 */

type CrashEdits = {
  /** Publishes edits still held by an editor into the document (synchronous). */
  flush: () => boolean;
  /** Writes the document's unsaved buffers; resolves false when a write failed. */
  save: () => Promise<boolean>;
};

/** A crash save gives up waiting after this long: Restart must not hang on a write that never answers. */
export const CRASH_SAVE_TIMEOUT_MS = 3_000;

let registered: CrashEdits | null = null;
let pending: Promise<boolean> | null = null;

/** Register the window's open edits; the returned function unregisters them. */
export function registerCrashEdits(edits: CrashEdits): () => void {
  registered = edits;
  return () => {
    if (registered === edits) registered = null;
  };
}

/**
 * Flush and start writing the open edits, best effort: never throws, and
 * settles within CRASH_SAVE_TIMEOUT_MS. A crash save already running is
 * joined rather than started again (one error can reach several boundaries, and
 * React may retry a render that throws). Resolves true when there was nothing
 * to write or the write finished.
 */
export function saveOnCrash(): Promise<boolean> {
  if (pending) return pending;
  const edits = registered;
  if (!edits) return Promise.resolve(true);
  let saving: Promise<boolean>;
  try {
    // The crashed editor may be what fails to flush; its last published text is still worth writing.
    try { edits.flush(); } catch { /* best effort */ }
    saving = edits.save().catch(() => false);
  } catch {
    saving = Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CRASH_SAVE_TIMEOUT_MS); });
  const settled = Promise.race([saving, timeout]).finally(() => {
    clearTimeout(timer);
    if (pending === settled) pending = null;
  });
  pending = settled;
  return settled;
}

/** The crash save in flight, if any, settled (Restart waits for it before relaunching). */
export function crashSaveSettled(): Promise<unknown> {
  return pending ?? Promise.resolve();
}
