/**
 * The Overleaf choices in Settings — live or manual syncing, and what a local
 * delete does on Overleaf — shared by every window (shared-setting.ts).
 *
 * They are not part of a window's connection store: a window that kept its own
 * copy went on syncing live, or deleting on Overleaf, after the writer changed
 * the choice in another window.
 */
import type { RefObject } from "react";
import {
  OVERLEAF_REMOTE_DELETE_KEY, OVERLEAF_SYNC_MODE_KEY, loadOverleafRemoteDelete, loadOverleafSyncMode, type OverleafRemoteDelete,
} from "../settings/app-settings";
import { sharedSetting } from "../settings/shared-setting";

export const overleafSyncModeSetting = sharedSetting(OVERLEAF_SYNC_MODE_KEY, loadOverleafSyncMode, {
  serialize: (mode) => mode,
});

export const overleafRemoteDeleteSetting = sharedSetting(OVERLEAF_REMOTE_DELETE_KEY, loadOverleafRemoteDelete, {
  serialize: (mode) => mode,
});

/**
 * The remote-delete choice as it stands when a delete is decided, for
 * useOverleafRemoteDeletes: another window's change reaches it through the
 * storage event, and a write here re-reads storage first.
 */
export const overleafRemoteDeletePolicy: RefObject<OverleafRemoteDelete> = {
  get current() { return overleafRemoteDeleteSetting.get(); },
};
