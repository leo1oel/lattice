import { msg } from "@lingui/core/macro";
import { i18n } from "./i18n";
import type { CollabProjectStatusV2 } from "./collab-project-v2";
import type { CollabStatus } from "./collab-session";

/**
 * `detail` is shown beside the share indicator, so it has to be translated.
 * The catalog is read here rather than at the call site because callers store
 * the result in state; resolving on each mapping keeps the string in step with
 * the status it describes.
 */
export function mapCollabProjectStatusV2(status: CollabProjectStatusV2): {
  status: CollabStatus;
  detail: string | null;
} {
  switch (status) {
    case "server-received":
    case "durable":
      return { status: "synced", detail: null };
    case "syncing":
      return { status: "connecting", detail: i18n._(msg`Syncing changes…`) };
    case "importing":
      return { status: "connecting", detail: i18n._(msg`Importing all project files…`) };
    case "offline":
      return { status: "disconnected", detail: i18n._(msg`Offline`) };
    case "read-only":
      return { status: "disconnected", detail: i18n._(msg`Collaboration is read-only`) };
    case "closed":
      return { status: "disconnected", detail: i18n._(msg`This shared project is closed`) };
    case "error":
      return { status: "error", detail: i18n._(msg`Collaboration failed`) };
  }
}
