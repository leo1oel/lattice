import { isBoundId, type GrantPermission } from "../protocol/collab-v2";

export type CollabInvitationV2 = {
  version: 2;
  deployment: string;
  projectInstanceId: string;
  guestSecret: string;
  permission: Exclude<GrantPermission, "host">;
};

const PREFIX = "lattice-collab-v2:";
const MAX_INVITATION_LENGTH = 4096;

export function formatCollabInvitationV2(invitation: CollabInvitationV2): string {
  validate(invitation);
  return `${PREFIX}${base64Url(new TextEncoder().encode(JSON.stringify(invitation)))}`;
}

export function parseCollabInvitationV2(raw: string): CollabInvitationV2 | null {
  const value = raw.trim();
  if (!value.startsWith(PREFIX)) return null;
  if (value.length > MAX_INVITATION_LENGTH) throw new Error("The v2 invitation is too long");
  try {
    const encoded = value.slice(PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid v2 invitation encoding");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(encoded)));
    validate(parsed);
    return parsed;
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Invalid v2 invitation: ${error.message}` : "Invalid v2 invitation",
      { cause: error },
    );
  }
}

function validate(value: unknown): asserts value is CollabInvitationV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invitation payload must be an object");
  const invitation = value as Partial<CollabInvitationV2>;
  if (invitation.version !== 2) throw new Error("Unsupported invitation version");
  if (invitation.permission !== "read" && invitation.permission !== "write") throw new Error("Invalid guest permission");
  if (!isBoundId(invitation.projectInstanceId)) throw new Error("Invalid project identity");
  if (typeof invitation.deployment !== "string" || invitation.deployment.length > 2048) throw new Error("Invalid deployment");
  let url: URL;
  try { url = new URL(invitation.deployment); } catch { throw new Error("Invalid deployment"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Deployment must be an HTTPS origin");
  if (typeof invitation.guestSecret !== "string" || !/^[A-Za-z0-9_-]{43,172}$/.test(invitation.guestSecret)
    || fromBase64Url(invitation.guestSecret).byteLength < 32) throw new Error("Guest secret must contain at least 32 random bytes");
  const keys = Object.keys(invitation);
  if (keys.length !== 5 || keys.some((key) => !["version", "deployment", "projectInstanceId", "guestSecret", "permission"].includes(key))) throw new Error("Invitation contains unknown fields");
}

function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function fromBase64Url(value: string): Uint8Array { const base64 = value.replaceAll("-", "+").replaceAll("_", "/"); return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) => char.charCodeAt(0)); }
