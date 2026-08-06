import type { FileNode } from "./app-types";
import type { CollabFeaturePolicy } from "./collab-feature-policy";
import type { CollabCredentialStore } from "./collab-credentials";
import type { CollabProjectRecordV2 } from "./collab-rooms";
import { parseCollabInvitationV2, type CollabInvitationV2 } from "./collab-invitation-v2";

export function shouldCreateCollabV2(policy: CollabFeaturePolicy): boolean {
  return policy.allowCreateV2 && policy.preferV2ForNewProjects;
}

/** Credential preflight intentionally never mutates the remembered record. */
export async function requireRememberedV2Credential(record: CollabProjectRecordV2, store: CollabCredentialStore): Promise<string> {
  if (!record.credentialRef || !await store.get(record.credentialRef, record.projectInstanceId, record.host)) throw new Error("Collaboration credential is unavailable. The remembered project was kept.");
  return record.credentialRef;
}

/** Reads the bearer secret for a one-off control request without exposing it to persisted room metadata. */
export async function readRememberedV2Credential(record: CollabProjectRecordV2, store: CollabCredentialStore): Promise<string> {
  if (!record.credentialRef) throw new Error("Collaboration credential is unavailable. The remembered project was kept.");
  const credential = await store.get(record.credentialRef, record.projectInstanceId, record.host);
  if (!credential) throw new Error("Collaboration credential is unavailable. The remembered project was kept.");
  return credential;
}

export function collabV2Inventory(nodes: FileNode[]): Array<{ path: string; kind: "text" | "binary" }> {
  const files: Array<{ path: string; kind: "text" | "binary" }> = [];
  const visit = (items: FileNode[]) => {
    for (const item of items) {
      if (item.contentKind === "directory" || item.kind === "directory") visit(item.children);
      else if (item.contentKind !== "symlink") {
        files.push({ path: item.path.replace(/\\/g, "/").replace(/^\/+/, ""), kind: item.contentKind === "text" ? "text" : "binary" });
      }
    }
  };
  visit(nodes);
  return files;
}

export function parsePreferredCollabInvitation(raw: string): CollabInvitationV2 | null {
  return parseCollabInvitationV2(raw);
}
