import { useEffect, type RefObject } from "react";
import { confirmAction, isRecord } from "../app-utils";
import { boundedString, listenToSynaraFrame } from "./agent-protocol";

export const SYNARA_CONFIRMATION_REQUEST = "synara:confirmation-request";
export const LATTICE_CONFIRMATION_ACK = "lattice:confirmation-ack";
export const LATTICE_CONFIRMATION_RESPONSE = "lattice:confirmation-response";

export type SynaraConfirmationRequest = {
  type: typeof SYNARA_CONFIRMATION_REQUEST;
  id: string;
  message: string;
};

export function parseSynaraConfirmationRequest(
  value: unknown,
): SynaraConfirmationRequest | null {
  if (!isRecord(value) || value.type !== SYNARA_CONFIRMATION_REQUEST) return null;
  const id = boundedString(value.id, 128);
  const message = boundedString(value.message, 4_096);
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
    return listenToSynaraFrame(frameRef, origin, (data, sourceWindow) => {
      const request = parseSynaraConfirmationRequest(data);
      if (!request) return;
      sourceWindow.postMessage({ type: LATTICE_CONFIRMATION_ACK, id: request.id }, origin);
      if (pendingIds.has(request.id)) return;
      pendingIds.add(request.id);
      void confirmAction(request.message)
        .catch(() => false)
        .then((confirmed) => {
          sourceWindow.postMessage({ type: LATTICE_CONFIRMATION_RESPONSE, id: request.id, confirmed }, origin);
        })
        .finally(() => pendingIds.delete(request.id));
    });
  }, [frameRef, origin]);
}
