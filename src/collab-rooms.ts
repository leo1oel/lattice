/**
 * Local memory of live-sharing rooms the user has taken part in, so they can
 * rejoin from a list instead of re-pasting an invite. Kept entirely client-side
 * in localStorage; the server has no room registry to query.
 */

/** v2 share record: one entry per project the user has hosted or joined. */
export type CollabProjectRecordV2 = {
  version: 2;
  projectInstanceId: string;
  host: string;
  /** Opaque lookup key for a credential held by a future native secure store. */
  credentialRef?: string;
  permission: "host" | "write" | "read";
  title: string;
  projectRoot: string | null;
  lastUsed: number;
};

export const PROJECTS_V2_KEY = "lattice.collab.projects.v2";

export function loadCollabProjectsV2(): CollabProjectRecordV2[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROJECTS_V2_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is CollabProjectRecordV2 => {
      const record = entry as Partial<CollabProjectRecordV2>;
      return record.version === 2 && typeof record.projectInstanceId === "string"
        && typeof record.host === "string"
        && (record.credentialRef === undefined || typeof record.credentialRef === "string")
        && (record.permission === "host" || record.permission === "write" || record.permission === "read");
    }).map((record) => ({
      ...record,
      title: typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : `Shared project ${record.projectInstanceId.slice(-6)}`,
      projectRoot: typeof record.projectRoot === "string" ? record.projectRoot : null,
      lastUsed: typeof record.lastUsed === "number" ? record.lastUsed : 0,
    }));
  } catch { return []; }
}

export function rememberCollabProjectV2(record: CollabProjectRecordV2): void {
  const rest = loadCollabProjectsV2().filter((item) => !(item.host === record.host && item.projectInstanceId === record.projectInstanceId));
  try { localStorage.setItem(PROJECTS_V2_KEY, JSON.stringify([record, ...rest].slice(0, 24))); } catch { /* convenience only */ }
}

export function forgetCollabProjectV2(host: string, projectInstanceId: string): void {
  const remaining = loadCollabProjectsV2().filter((item) => !(item.host === host && item.projectInstanceId === projectInstanceId));
  try { localStorage.setItem(PROJECTS_V2_KEY, JSON.stringify(remaining)); } catch { /* convenience only */ }
}
