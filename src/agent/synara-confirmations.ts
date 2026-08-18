import { useEffect, type RefObject } from "react";
import { confirmAction } from "../app-utils";

export const SYNARA_CONFIRMATION_REQUEST = "synara:confirmation-request";
export const LATTICE_CONFIRMATION_ACK = "lattice:confirmation-ack";
export const LATTICE_CONFIRMATION_RESPONSE = "lattice:confirmation-response";

export type SynaraConfirmationRequest = {
  type: typeof SYNARA_CONFIRMATION_REQUEST;
  id: string;
  message: string;
};

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maximum);
  if (normalized) return normalized;
  return allowEmpty ? "" : null;
}

export function parseSynaraConfirmationRequest(
  value: unknown,
): SynaraConfirmationRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== SYNARA_CONFIRMATION_REQUEST) return null;
  const id = boundedString(candidate.id, 128);
  const message = boundedString(candidate.message, 4_096);
  if (!id || !message) return null;
  return { type: SYNARA_CONFIRMATION_REQUEST, id, message };
}

/**
 * Routes confirmation requests from a trusted Synara frame through Lattice's
 * shared in-app confirmation dialog, so destructive actions look and behave
 * exactly like file and folder deletion.
 */
export function useSynaraConfirmationBridge(options: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  origin: string | null;
}) {
  const { frameRef, origin } = options;
  useEffect(() => {
    if (!origin) return;
    const pendingIds = new Set<string>();
    const receiveConfirmation = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== origin
      ) {
        return;
      }
      const request = parseSynaraConfirmationRequest(event.data);
      if (!request) return;
      const sourceWindow = event.source as Window;
      sourceWindow.postMessage(
        { type: LATTICE_CONFIRMATION_ACK, id: request.id },
        origin,
      );
      if (pendingIds.has(request.id)) return;
      pendingIds.add(request.id);
      void confirmAction(request.message)
        .catch(() => false)
        .then((confirmed) => {
          sourceWindow.postMessage(
            {
              type: LATTICE_CONFIRMATION_RESPONSE,
              id: request.id,
              confirmed,
            },
            origin,
          );
        })
        .finally(() => pendingIds.delete(request.id));
    };
    window.addEventListener("message", receiveConfirmation);
    return () => window.removeEventListener("message", receiveConfirmation);
  }, [frameRef, origin]);
}
