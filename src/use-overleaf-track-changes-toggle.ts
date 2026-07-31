/**
 * Turning "record my edits as suggestions" on or off for this account.
 *
 * Overleaf's setting is one project-wide map keyed by user id, but a client
 * only ever knows its own account — so every call here sends a map with
 * exactly one entry, this account's, and Overleaf merges it into whatever
 * the other members' entries already are. Whether it is currently on is
 * deliberately not tracked here: `useOverleafRealtime.trackChanges` already
 * reads it pre-scoped to this account off the socket, and re-reading it
 * after a toggle would just be racing the very `trackChangesToggled` event
 * this call causes.
 */
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type OverleafTrackChangesToggle = {
  pending: boolean;
  error: string | null;
  setTrackChanges: (on: boolean) => Promise<void>;
};

/**
 * `myUserId` is this account's Overleaf user id — not exposed by
 * `useOverleafRealtime` today, so the caller has to source it (see the
 * wiring notes this shipped with). Until it is known, the toggle refuses
 * rather than sending a map keyed on the wrong account.
 */
export function useOverleafTrackChangesToggle(
  myUserId: string | null,
  projectRoot: string | null,
): OverleafTrackChangesToggle {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTrackChanges = useCallback(async (on: boolean) => {
    if (!myUserId) {
      const message = "Still finding out this account's Overleaf id — try again in a moment.";
      setError(message);
      throw new Error(message);
    }
    if (!projectRoot) {
      const message = "Open the linked Overleaf project first.";
      setError(message);
      throw new Error(message);
    }
    setPending(true);
    setError(null);
    try {
      await invoke("overleaf_set_track_changes", {
        projectRoot,
        onFor: { [myUserId]: on },
      });
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setPending(false);
    }
  }, [myUserId, projectRoot]);

  return { pending, error, setTrackChanges };
}
