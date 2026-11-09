/**
 * A build stopped because TeX made no progress (build-stalled) would only
 * stall again on the same inputs, so automatic builds wait for any input to
 * change: a save, or the agent, Overleaf or another editor through the
 * watcher, in whichever file. Keyed on the pipeline's input revision, which
 * moves on each of those and on a project switch, not on the open file's
 * text. Build still runs on request.
 */
export function createStallHold() {
  let stalledOn: number | null = null;
  return {
    /** Remembers the input revision a finished build stalled on, or forgets it after any other result. */
    note(diagnostics: readonly { code?: string | null }[], revision: number): void {
      stalledOn = diagnostics.some((item) => item.code === "build-stalled") ? revision : null;
    },
    holds: (revision: number) => stalledOn === revision,
  };
}
