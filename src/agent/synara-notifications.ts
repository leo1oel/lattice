import { useEffect, type RefObject } from "react";
import {
  addAppLog,
  dismissAppToast,
  updateAppLog,
  type AppLogLevel,
  type AppToastOptions,
} from "../telemetry/app-log-store";

export const SYNARA_EMBEDDED_NOTIFICATION = "synara:embedded-notification";
const LATTICE_EMBEDDED_NOTIFICATION_ACTION =
  "lattice:embedded-notification-action";

type SynaraNotificationAction = "dismiss" | "primary" | "secondary";

export type SynaraNotificationMessage =
  | {
      type: typeof SYNARA_EMBEDDED_NOTIFICATION;
      operation: "dismiss";
      id: string;
    }
  | {
      type: typeof SYNARA_EMBEDDED_NOTIFICATION;
      operation: "upsert";
      id: string;
      level: "error" | "info" | "loading" | "success" | "warning";
      title: string;
      detail: string;
      timeoutMs: number;
      copyText?: string;
      primaryActionLabel?: string;
      secondaryActionLabel?: string;
    };

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = true,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maximum);
  if (normalized) return normalized;
  return allowEmpty ? "" : null;
}

export function parseSynaraNotificationMessage(
  value: unknown,
): SynaraNotificationMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== SYNARA_EMBEDDED_NOTIFICATION) return null;
  const id = boundedString(candidate.id, 128, false);
  if (!id) return null;
  if (candidate.operation === "dismiss") {
    return { type: SYNARA_EMBEDDED_NOTIFICATION, operation: "dismiss", id };
  }
  if (candidate.operation !== "upsert") return null;
  const level = candidate.level;
  if (
    level !== "error" &&
    level !== "info" &&
    level !== "loading" &&
    level !== "success" &&
    level !== "warning"
  ) {
    return null;
  }
  const title = boundedString(candidate.title, 160, false);
  const detail = boundedString(candidate.detail, 4_000);
  if (!title || detail === null) return null;
  if (
    typeof candidate.timeoutMs !== "number" ||
    !Number.isFinite(candidate.timeoutMs)
  ) {
    return null;
  }
  const copyText = boundedString(candidate.copyText, 4_000, false);
  const primaryActionLabel = boundedString(
    candidate.primaryActionLabel,
    48,
    false,
  );
  const secondaryActionLabel = boundedString(
    candidate.secondaryActionLabel,
    48,
    false,
  );
  return {
    type: SYNARA_EMBEDDED_NOTIFICATION,
    operation: "upsert",
    id,
    level,
    title,
    detail,
    timeoutMs: Math.min(30_000, Math.max(0, Math.round(candidate.timeoutMs))),
    ...(copyText ? { copyText } : {}),
    ...(primaryActionLabel ? { primaryActionLabel } : {}),
    ...(secondaryActionLabel ? { secondaryActionLabel } : {}),
  };
}

function appLogLevel(
  level: Extract<SynaraNotificationMessage, { operation: "upsert" }>["level"],
): AppLogLevel {
  return level === "loading" ? "info" : level;
}

function actionMessage(id: string, action: SynaraNotificationAction) {
  return { type: LATTICE_EMBEDDED_NOTIFICATION_ACTION, id, action };
}

function hostNotificationTimeout(
  message: Extract<SynaraNotificationMessage, { operation: "upsert" }>,
): number {
  if (message.timeoutMs === 0) return 0;
  if (
    message.level === "error" ||
    message.primaryActionLabel ||
    message.secondaryActionLabel
  ) {
    return 9_000;
  }
  return 6_000;
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
    const notificationBySynaraId = new Map<
      string,
      { appLogId: string; hostTimeoutMs: number }
    >();
    const postAction = (id: string, action: SynaraNotificationAction) => {
      frameRef.current?.contentWindow?.postMessage(
        actionMessage(id, action),
        origin,
      );
    };
    const receiveNotification = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== origin
      ) {
        return;
      }
      const message = parseSynaraNotificationMessage(event.data);
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
      const toastOptions: AppToastOptions = {
        timeoutMs: hostTimeoutMs,
        ...(message.copyText ? { copyText: message.copyText } : {}),
        ...(message.primaryActionLabel
          ? {
              primaryAction: {
                label: message.primaryActionLabel,
                onClick: () => postAction(message.id, "primary"),
              },
            }
          : {}),
        ...(message.secondaryActionLabel
          ? {
              secondaryAction: {
                label: message.secondaryActionLabel,
                onClick: () => postAction(message.id, "secondary"),
              },
            }
          : {}),
        onDismiss: () => postAction(message.id, "dismiss"),
      };
      if (existing) {
        updateAppLog(
          existing.appLogId,
          {
            level: appLogLevel(message.level),
            source,
            title: message.title,
            detail: message.detail,
          },
          toastOptions,
        );
        notificationBySynaraId.set(message.id, {
          appLogId: existing.appLogId,
          hostTimeoutMs,
        });
        return;
      }
      const entry = addAppLog({
        level: appLogLevel(message.level),
        source,
        title: message.title,
        detail: message.detail,
        toastOptions,
      });
      notificationBySynaraId.set(message.id, {
        appLogId: entry.id,
        hostTimeoutMs,
      });
    };
    window.addEventListener("message", receiveNotification);
    return () => {
      window.removeEventListener("message", receiveNotification);
      for (const notification of notificationBySynaraId.values()) {
        dismissAppToast(notification.appLogId, false);
      }
    };
  }, [frameRef, origin, source]);
}
