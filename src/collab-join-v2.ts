import type { CollabCredentialStore } from "./collab-credentials";
import { createCredentialRef } from "./collab-credentials";
import { parseCollabInvitationV2 } from "./collab-invitation-v2";
import { rememberCollabProjectV2, type CollabProjectRecordV2 } from "./collab-rooms";

/** Persists an invitation's secret before returning any reconnectable metadata. */
export async function acceptCollabInvitationV2(
  raw: string,
  store: CollabCredentialStore,
  options: { title?: string; projectRoot?: string | null; now?: number } = {},
): Promise<CollabProjectRecordV2 | null> {
  const invitation = parseCollabInvitationV2(raw);
  if (!invitation) return null;
  const credentialRef = createCredentialRef();
  await store.put(credentialRef, invitation.guestSecret, invitation.projectInstanceId, invitation.deployment);
  const record: CollabProjectRecordV2 = {
    version: 2,
    projectInstanceId: invitation.projectInstanceId,
    host: invitation.deployment,
    credentialRef,
    permission: invitation.permission,
    title: options.title ?? "共享项目",
    projectRoot: options.projectRoot ?? null,
    lastUsed: options.now ?? Date.now(),
  };
  rememberCollabProjectV2(record);
  return record;
}
