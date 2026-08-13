import type { CollabProjectStatusV2 } from "./collab-project-v2";
import type { CollabStatus } from "./collab-session";

export function mapCollabProjectStatusV2(status: CollabProjectStatusV2): {
  status: CollabStatus;
  detail: string | null;
} {
  switch (status) {
    case "server-received":
    case "durable":
      return { status: "synced", detail: null };
    case "syncing":
      return { status: "connecting", detail: "Syncing changes…" };
    case "importing":
      return { status: "connecting", detail: "Importing all project files…" };
    case "offline":
      return { status: "disconnected", detail: "Offline" };
    case "read-only":
      return { status: "disconnected", detail: "Collaboration is read-only" };
    case "closed":
      return { status: "disconnected", detail: "This shared project is closed" };
    case "error":
      return { status: "error", detail: "Collaboration failed" };
  }
}
