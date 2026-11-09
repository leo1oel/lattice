/**
 * A build stopped for making no progress would only stall again on the same
 * text, so automatic builds wait for a change. Build still runs on request.
 */
let stalledOn: string | null = null;

/** Remembers the text a finished build stalled on, or forgets it after any other result. */
export function noteBuildOutcome(diagnostics: readonly { code?: string | null }[], source: string): void {
  stalledOn = diagnostics.some((item) => item.code === "build-stalled") ? source : null;
}

export const automaticBuildWouldStall = (source: string) => stalledOn === source;

/** A project file changed or was saved, here or from outside: the next automatic build may differ. */
export function forgetBuildStall(): void {
  stalledOn = null;
}
