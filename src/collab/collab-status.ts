import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";
import type { CollabProjectStatusV2 } from "./collab-project-v2";
import type { CollabStatus } from "./collab-session";

const STATUS_V2: Record<CollabProjectStatusV2, [CollabStatus, MessageDescriptor | null]> = {
  "server-received": ["synced", null],
  durable: ["synced", null],
  syncing: ["connecting", msg`Syncing changes…`],
  importing: ["connecting", msg`Importing all project files…`],
  offline: ["disconnected", msg`Offline`],
  "read-only": ["disconnected", msg`Collaboration is read-only`],
  closed: ["disconnected", msg`This shared project is closed`],
  error: ["error", msg`Collaboration failed`],
};

/**
 * `detail` is shown beside the share indicator, so it has to be translated.
 * The catalog is read here rather than at the call site because callers store
 * the result in state; resolving on each mapping keeps the string in step with
 * the status it describes.
 */
export function mapCollabProjectStatusV2(status: CollabProjectStatusV2): { status: CollabStatus; detail: string | null } {
  const [mapped, detail] = STATUS_V2[status];
  return { status: mapped, detail: detail && i18n._(detail) };
}
