/**
 * Live mode's poll: "has your history moved?" is a small JSON call every few
 * seconds (`overleaf_probe`); the full sync follows only on a yes. The
 * workspace (use-overleaf-workspace.ts) starts one per linked project in live
 * mode and owns the refs it reads.
 */
import { invoke } from "@tauri-apps/api/core";
import type { OverleafProbe } from "../app-types";
import { toMessage } from "../app-utils";
import { isOverleafProjectRefusal, OVERLEAF_REFUSAL_RETRIES } from "../overleaf/overleaf-realtime-model";
import { clearTimer, onWindowShown, restartTimer, windowHidden, type TimerRef } from "./effect-helpers";

/** How often live mode asks Overleaf whether anything changed. */
const OVERLEAF_LIVE_POLL_MS = 3_000;
/** Cadence when Overleaf gives us no cheap way to detect a change. */
const OVERLEAF_BLIND_POLL_MS = 120_000;
/** Cadence once the channel carries documents: only figures and new files remain, and each "yes" is a full download. */
const OVERLEAF_CHANNEL_POLL_MS = 45_000;
/**
 * Floor between full syncs: Overleaf answers 429 past ten project downloads a
 * minute, and a collaborator typing moves the version on every poll.
 */
export const minimumSyncGap = (channelLive: boolean) => (channelLive ? 30_000 : 12_000);

type Ref<T> = { current: T };

export type OverleafLivePoll = {
  projectRoot: string;
  /** Run an automatic sync (it stamps `lastAutoSync`). */
  autoSync: (options?: { observedRemoteVersion?: number | null }) => Promise<unknown>;
  /** The live channel carries documents. */
  channelLive: Ref<boolean>;
  syncing: Ref<boolean>;
  /** A sync failed in transit and is owed again. */
  transportRetry: Ref<boolean>;
  /** Disk writes still to send. */
  externalChanges: Ref<ReadonlyMap<string, symbol>>;
  refusals: Ref<number>;
  lastAutoSync: Ref<number>;
};

/** Poll until the returned stop runs. */
export function startOverleafLivePoll(poll: OverleafLivePoll): () => void {
  const { projectRoot, autoSync, channelLive, syncing, transportRetry, externalChanges, refusals, lastAutoSync } = poll;
  let stopped = false;
  const timer: TimerRef = { current: null };
  let running = false;
  // Backs off when Overleaf pushes back, and stays slow without a version to compare.
  const baseWait = () => channelLive.current ? OVERLEAF_CHANNEL_POLL_MS : OVERLEAF_LIVE_POLL_MS;
  let wait = baseWait();
  const tick = async () => {
    if (stopped || running) return;
    clearTimer(timer);
    const owed = transportRetry.current || externalChanges.current.size > 0;
    // Off screen the loop rests: no probe until the window is shown again,
    // which ticks at once (as focus does). Without this an idle window behind
    // others asked Overleaf every 3 s while its live channel was down, for as
    // long as it stayed open. Our own unsent work is the exception: a sync
    // owed for a failed transfer or a disk write keeps its retries going, so
    // collaborators still get it. The timer stays armed while resting, only
    // to look at those refs, so work that becomes owed off screen (a sync
    // that fails in transit after an agent's write) is still retried.
    if (windowHidden() && !owed) {
      restartTimer(timer, wait, () => void tick());
      return;
    }
    running = true;
    try {
      if (!syncing.current) {
        // A refused probe is a probe without a version: sync on the slow
        // clock, and let the sync count the refusals and report them.
        const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot }).catch((reason: unknown) => {
          if (isOverleafProjectRefusal(toMessage(reason)) && refusals.current < OVERLEAF_REFUSAL_RETRIES) return null;
          throw reason;
        });
        wait = probe?.versionKnown ? baseWait() : OVERLEAF_BLIND_POLL_MS;
        const sinceLastSync = Date.now() - lastAutoSync.current;
        const gapElapsed = sinceLastSync >= minimumSyncGap(channelLive.current);
        const retry = transportRetry.current || externalChanges.current.size > 0;
        if (stopped) return;
        if (retry && gapElapsed) {
          await autoSync();
        } else if (!probe?.versionKnown) {
          // No change signal: sync on a slow clock instead.
          if (sinceLastSync >= OVERLEAF_BLIND_POLL_MS) await autoSync();
        } else if (probe.changed && gapElapsed) {
          await autoSync({ observedRemoteVersion: probe.remoteVersion });
        }
      }
    } catch (reason) {
      // A 429 means we are asking too often: ease off sharply.
      wait = /429|Too Many Requests/i.test(String(reason))
        ? Math.min(wait * 4, 5 * 60_000)
        : Math.min(Math.max(wait * 2, baseWait()), 60_000);
    }
    running = false;
    if (!stopped) restartTimer(timer, wait, () => void tick());
  };
  void tick();
  // Coming back from the browser is when stale content is most obvious.
  const onFocus = () => void tick();
  window.addEventListener("focus", onFocus);
  const stopShown = onWindowShown(onFocus);
  return () => {
    stopped = true;
    clearTimer(timer);
    window.removeEventListener("focus", onFocus);
    stopShown();
  };
}
