import { useEffect, type RefObject } from "react";
import {
  addAppLog,
  dismissAppToast,
  updateAppLog,
  type AppToastOptions,
} from "../telemetry/app-log-store";
import { boundedString, isRecord, listenToSynaraFrame } from "./agent-protocol";

export const SYNARA_EMBEDDED_NOTIFICATION = "synara:embedded-notification";
const LATTICE_EMBEDDED_NOTIFICATION_ACTION =
  "lattice:embedded-notification-action";

type SynaraNotificationAction = "dismiss" | "primary" | "secondary";

const LEVELS = ["error", "info", "loading", "success", "warning"] as const;

type SynaraNotificationUpsert = {
  type: typeof SYNARA_EMBEDDED_NOTIFICATION;
  operation: "upsert";
  id: string;
  level: (typeof LEVELS)[number];
  title: string;
  detail: string;
  timeoutMs: number;
  copyText?: string;
  primaryActionLabel?: string;
  secondaryActionLabel?: string;
};

export type SynaraNotificationMessage =
  | { type: typeof SYNARA_EMBEDDED_NOTIFICATION; operation: "dismiss"; id: string }
  | SynaraNotificationUpsert;

export function parseSynaraNotificationMessage(
  value: unknown,
): SynaraNotificationMessage | null {
  if (!isRecord(value) || value.type !== SYNARA_EMBEDDED_NOTIFICATION) return null;
  const id = boundedString(value.id, 128);
  if (!id) return null;
  if (value.operation === "dismiss") {
    return { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id };
  }
  const { level, timeoutMs } = value;
  if (value.operation !== "upsert" || !LEVELS.includes(level as SynaraNotificationUpsert["level"])) return null;
  const title = boundedString(value.title, 160);
  const detail = boundedString(value.detail, 4_000, true);
  if (!title || detail === null) return null;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return null;
  const copyText = boundedString(value.copyText, 4_000);
  const primaryActionLabel = boundedString(value.primaryActionLabel, 48);
  const secondaryActionLabel = boundedString(value.secondaryActionLabel, 48);
  return {
    type: SYNARA_EMBEDDED_NOTIFICATION,
    operation: "upsert",
    id,
    level: level as SynaraNotificationUpsert["level"],
    title,
    detail,
    timeoutMs: Math.min(30_000, Math.max(0, Math.round(timeoutMs))),
    ...(copyText ? { copyText } : {}),
    ...(primaryActionLabel ? { primaryActionLabel } : {}),
    ...(secondaryActionLabel ? { secondaryActionLabel } : {}),
  };
}

function hostNotificationTimeout(message: SynaraNotificationUpsert): number {
  if (message.timeoutMs === 0) return 0;
  return message.level === "error" || message.primaryActionLabel || message.secondaryActionLabel ? 9_000 : 6_000;
}

/**
 * Move global notifications out of an embedded Synara frame and into Lattice's
 * window-level notification stack. Message source and origin are both checked
 * before any content is logged or shown.
 */
export function useSynaraNotificationBridge(options: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  origin: string | null;
  source: string;
}) {
  const { frameRef, origin, source } = options;
  useEffect(() => {
    if (!origin) return;
    const notificationBySynaraId = new Map<string, { appLogId: string; hostTimeoutMs: number }>();
    const postAction = (id: string, action: SynaraNotificationAction) => {
      frameRef.current?.contentWindow?.postMessage({ type: LATTICE_EMBEDDED_NOTIFICATION_ACTION, id, action }, origin);
    };
    const stopListening = listenToSynaraFrame(frameRef, origin, (data) => {
      const message = parseSynaraNotificationMessage(data);
      if (!message) return;
      const existing = notificationBySynaraId.get(message.id);
      if (message.operation === "dismiss") {
        // Finite notifications use Lattice's standard display lifetime. Synara
        // can otherwise remove them before the host toast has even settled.
        // Persistent progress notifications still follow programmatic closes.
        if (existing?.hostTimeoutMs === 0) {
          dismissAppToast(existing.appLogId, false);
          notificationBySynaraId.delete(message.id);
        }
        return;
      }
      const hostTimeoutMs = hostNotificationTimeout(message);
      const action = (label: string | undefined, kind: SynaraNotificationAction) => (
        label ? { label, onClick: () => postAction(message.id, kind) } : undefined
      );
      const primaryAction = action(message.primaryActionLabel, "primary");
      const secondaryAction = action(message.secondaryActionLabel, "secondary");
      const toastOptions: AppToastOptions = {
        timeoutMs: hostTimeoutMs,
        ...(message.copyText ? { copyText: message.copyText } : {}),
        ...(primaryAction ? { primaryAction } : {}),
        ...(secondaryAction ? { secondaryAction } : {}),
        onDismiss: () => postAction(message.id, "dismiss"),
      };
      const entry = {
        level: message.level === "loading" ? "info" as const : message.level,
        source,
        title: message.title,
        detail: message.detail,
      };
      const appLogId = existing?.appLogId ?? addAppLog({ ...entry, toastOptions }).id;
      if (existing) updateAppLog(appLogId, entry, toastOptions);
      notificationBySynaraId.set(message.id, { appLogId, hostTimeoutMs });
    });
    return () => {
      stopListening();
      for (const notification of notificationBySynaraId.values()) {
        dismissAppToast(notification.appLogId, false);
      }
    };
  }, [frameRef, origin, source]);
}
