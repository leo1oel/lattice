import type { CollabCredentialStore } from "./collab-credentials";
import type { CollabProjectRecordV2 } from "./collab-rooms";

type RemoteCollabDeleteUiPlanV2 = {
  openTabs: string[];
  tabRecency: string[];
  deletedActive: boolean;
  deletedSecondary: boolean;
  replacement: string | null;
};

/** Pure UI transition for a catalog-authoritative remote deletion. */
export function planRemoteCollabDeleteUiV2(options: {
  path: string;
  activeFile: string;
  secondaryFile: string | null;
  openTabs: string[];
  tabRecency: string[];
  liveTextPaths: string[];
  preferredPaths?: string[];
}): RemoteCollabDeleteUiPlanV2 {
  const deletedActive = options.activeFile === options.path;
  const liveTextPaths = options.liveTextPaths.filter((path) => path !== options.path);
  const replacement = deletedActive
    ? (options.preferredPaths?.find((path) => liveTextPaths.includes(path)) ?? liveTextPaths[0] ?? null)
    : null;
  return {
    openTabs: options.openTabs.filter((path) => path !== options.path),
    tabRecency: options.tabRecency.filter((path) => path !== options.path),
    deletedActive,
    deletedSecondary: options.secondaryFile === options.path,
    replacement,
  };
}

/** Reject stale project snapshots after a refresh or project switch. */
export function mayApplyProjectRefreshV2(options: {
  refreshGeneration: number;
  currentRefreshGeneration: number;
  scope?: { expectedRoot: string; generation: number };
  currentProjectGeneration: number;
  currentRoot?: string;
  snapshotRoot?: string;
}): boolean {
  if (options.refreshGeneration !== options.currentRefreshGeneration) return false;
  if (!options.scope) return true;
  return options.currentProjectGeneration === options.scope.generation
    && options.currentRoot === options.scope.expectedRoot
    && (options.snapshotRoot === undefined || options.snapshotRoot === options.scope.expectedRoot);
}

const CREDENTIAL_KEPT = "Collaboration credential is unavailable. The remembered project was kept.";

/** Reads the bearer secret for a one-off control request without exposing it to persisted room metadata. */
export async function readRememberedV2Credential(record: CollabProjectRecordV2, store: CollabCredentialStore): Promise<string> {
  const credential = record.credentialRef ? await store.get(record.credentialRef, record.projectInstanceId, record.host) : null;
  if (!credential) throw new Error(CREDENTIAL_KEPT);
  return credential;
}

/** Credential preflight intentionally never mutates the remembered record; controllers start from the opaque reference. */
export async function requireRememberedV2Credential(record: CollabProjectRecordV2, store: CollabCredentialStore): Promise<string> {
  await readRememberedV2Credential(record, store);
  return record.credentialRef!; // present: the read above throws without one
}
