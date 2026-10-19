/**
 * Autosave builds while the live preview is live.
 *
 * rtex already redraws the paragraph being typed, so the full latexmk build an
 * autosave asks for only brings page breaks, references, SyncTeX and the
 * exported PDF up to date. While the live preview is live on a .tex file, that
 * build waits for a pause in typing and runs quietly: no spinner on the Build
 * button and no "Updating…" over the PDF, whose live pages already show the
 * edit; the live preview's dot pulses instead. Its errors and warnings show as
 * any build's do. Build, export and SyncTeX jumps never wait and are never
 * quiet, and without a live preview autosave builds as it always has.
 */
import type { LivePreviewBuildHooks } from "./use-live-preview";

/** How long typing must pause before the full build runs (autosave itself saves after 1.2 s). */
export const QUIET_BUILD_IDLE_MS = 4_000;
/** However long the typing runs, the full PDF is never further behind the saved text than this. */
export const QUIET_BUILD_MAX_WAIT_MS = 30_000;

type Ref<T> = { readonly current: T };

export function createQuietBuilds({ livePreview, activeFileRef, sourceRef, savedSourceRef }: {
  livePreview: Ref<LivePreviewBuildHooks | null> | undefined;
  activeFileRef: Ref<string>;
  sourceRef: Ref<string>;
  savedSourceRef: Ref<string>;
}) {
  let timer: number | null = null;
  /** When the oldest save no build has compiled yet was made. */
  let since: number | null = null;
  // rtex draws .tex files only: a .bib or a figure the writer saves is seen in the next build alone.
  const live = () => livePreview?.current?.getSnapshot().phase === "live" && activeFileRef.current.toLowerCase().endsWith(".tex");
  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    since = null;
  };
  const due = () => since !== null && Date.now() - since >= QUIET_BUILD_MAX_WAIT_MS;
  return {
    /**
     * An autosave asks for a build. False when it should run now, as it does
     * without a live preview; otherwise `run` builds once typing has paused,
     * quietly if the live preview is still live then.
     */
    defer(run: (quiet: boolean) => void): boolean {
      if (!live()) {
        cancel();
        return false;
      }
      since ??= Date.now();
      const fire = () => {
        cancel();
        run(live());
      };
      if (due()) {
        fire();
        return true;
      }
      const wait = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          // Typed since the save: another save restarts the wait when they pause.
          // Re-check anyway, as a completion menu holds the save off.
          if (sourceRef.current !== savedSourceRef.current && live() && !due()) wait();
          else fire();
        }, QUIET_BUILD_IDLE_MS);
      };
      wait();
      return true;
    },
    /** Another build compiles what the waiting one would have. */
    cancel,
  };
}
