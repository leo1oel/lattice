export type CollabFeaturePolicy = {
  allowCreateV2: boolean;
  emergencyDisableWrites: boolean;
  emergencyDisableReads: boolean;
};

const POLICY_KEY = "lattice.collab.feature-policy.v1";

// Public sharing is paused while the hosted service has no available quota.
// Keep the implementation and saved rooms for an explicitly opted-in build.
export function isCollabEnabled(): boolean {
  return import.meta.env.VITE_LATTICE_COLLAB_V2 === "true";
}

/**
 * Kill switches, in increasing precedence: defaults, a JSON override in
 * localStorage, then build-time env flags. A build without sharing turns
 * everything off regardless.
 */
const POLICY_ENV: Record<keyof CollabFeaturePolicy, string> = {
  allowCreateV2: "VITE_LATTICE_COLLAB_V2_ALLOW_CREATE",
  emergencyDisableWrites: "VITE_LATTICE_COLLAB_DISABLE_WRITES",
  emergencyDisableReads: "VITE_LATTICE_COLLAB_DISABLE_READS",
};

export function loadCollabFeaturePolicy(): CollabFeaturePolicy {
  if (!isCollabEnabled()) return { allowCreateV2: false, emergencyDisableWrites: true, emergencyDisableReads: true };
  let persisted: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(POLICY_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) persisted = value as Record<string, unknown>;
  } catch { /* Invalid convenience configuration falls back safely. */ }
  const policy: CollabFeaturePolicy = { allowCreateV2: true, emergencyDisableWrites: false, emergencyDisableReads: false };
  for (const key of Object.keys(policy) as (keyof CollabFeaturePolicy)[]) {
    const fromEnv = import.meta.env[POLICY_ENV[key]];
    if (fromEnv === "true" || fromEnv === "false") policy[key] = fromEnv === "true";
    else if (typeof persisted[key] === "boolean") policy[key] = persisted[key];
  }
  return policy;
}

export function mayResumeCollabProject(policy = loadCollabFeaturePolicy()): boolean {
  return !policy.emergencyDisableReads;
}

export function mayWriteCollabProject(policy = loadCollabFeaturePolicy()): boolean {
  return !policy.emergencyDisableWrites;
}
