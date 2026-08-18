export type CollabFeaturePolicy = {
  allowCreateV2: boolean;
  preferV2ForNewProjects: boolean;
  emergencyDisableWrites: boolean;
  emergencyDisableReads: boolean;
};

const POLICY_KEY = "lattice.collab.feature-policy.v1";

export const DEFAULT_COLLAB_FEATURE_POLICY: CollabFeaturePolicy = {
  // v1 rooms are retired: new shares are always v2 projects. The flags remain
  // so a build can still opt back out via env/localStorage if v2 ever needs a
  // kill switch.
  allowCreateV2: true,
  preferV2ForNewProjects: true,
  emergencyDisableWrites: false,
  emergencyDisableReads: false,
};

function envBoolean(name: string): boolean | undefined {
  const value = import.meta.env[name];
  return value === "true" ? true : value === "false" ? false : undefined;
}

export function loadCollabFeaturePolicy(): CollabFeaturePolicy {
  let persisted: Partial<CollabFeaturePolicy> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(POLICY_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) persisted = value as Partial<CollabFeaturePolicy>;
  } catch { /* Invalid convenience configuration falls back safely. */ }
  const policy = { ...DEFAULT_COLLAB_FEATURE_POLICY };
  for (const key of Object.keys(policy) as (keyof CollabFeaturePolicy)[]) {
    if (typeof persisted[key] === "boolean") policy[key] = persisted[key]!;
  }
  const environment: Partial<Record<keyof CollabFeaturePolicy, string>> = {
    allowCreateV2: "VITE_LATTICE_COLLAB_V2_ALLOW_CREATE",
    preferV2ForNewProjects: "VITE_LATTICE_COLLAB_V2_PREFER_NEW",
    emergencyDisableWrites: "VITE_LATTICE_COLLAB_DISABLE_WRITES",
    emergencyDisableReads: "VITE_LATTICE_COLLAB_DISABLE_READS",
  };
  for (const key of Object.keys(environment) as (keyof CollabFeaturePolicy)[]) {
    const value = envBoolean(environment[key]!);
    if (value !== undefined) policy[key] = value;
  }
  return policy;
}

export function saveCollabFeaturePolicy(policy: CollabFeaturePolicy): void {
  localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
}

export function mayResumeCollabProject(version: 1 | 2, policy = loadCollabFeaturePolicy()): boolean {
  void version;
  return !policy.emergencyDisableReads;
}

export function mayWriteCollabProject(policy = loadCollabFeaturePolicy()): boolean {
  return !policy.emergencyDisableWrites;
}
