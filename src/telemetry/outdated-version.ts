// The newer Lattice a failure can point to: "You're on vX; vY is available
// and may already fix this" (outdated-version-hint.tsx). People report
// problems a release has already fixed, and nothing on the failure said so.
//
// The updater (app-updater.tsx) is the only source: it publishes what its own
// six-hourly check found, so this never asks the network itself. A module
// store rather than the updater's context, because the crash page renders
// outside <UpdaterProvider> and a toast should not re-render on every phase.

import { useSyncExternalStore } from "react";

export type KnownUpdate = {
  running: string;
  latest: string;
  /** The updater's phase: `ready` is installed and needs a restart; the busy phases have nothing to press. */
  phase: string;
  /** Start the updater's own flow: install a held update, restart into an installed one, or check again. */
  updateNow: () => Promise<void>;
};

let known: KnownUpdate | null = null;
const listeners = new Set<() => void>();

const parts = (version: string) => version.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map(Number);

/** Whether `candidate` is a later release than `current` ("0.16.10" > "0.16.9"); false for anything unparsable. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  if ([...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/** The updater's report; anything not newer than the running version clears it. */
export function publishKnownUpdate(next: KnownUpdate | null) {
  known = next && isNewerVersion(next.latest, next.running) ? next : null;
  listeners.forEach((listener) => listener());
}

/** The newer release this window's updater knows of, or null when it is current or has not checked. */
export function getKnownUpdate(): KnownUpdate | null {
  return known;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useKnownUpdate(): KnownUpdate | null {
  return useSyncExternalStore(subscribe, getKnownUpdate);
}
