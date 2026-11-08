/**
 * How a failed Overleaf sync step reads: a request that never reached
 * Overleaf (worth retrying), or a session that is gone (worth signing in
 * again). Matched on the backend's error text, however a step wraps it.
 */
import { toMessage } from "../app-utils";
import { OVERLEAF_NOT_CONNECTED, OVERLEAF_SESSION_EXPIRED } from "../overleaf/overleaf-realtime-model";
import { mentionsAny } from "../platform/ipc-error-phrases";

/* eslint-disable lingui/no-unlocalized-strings -- phrases matched in backend error text */
/** overleaf/api.rs's error for a request that never reached Overleaf. */
export const OVERLEAF_UNREACHABLE = "Could not reach Overleaf";
/** reqwest's own text for a body cut off mid-read; a test in overleaf/api.rs pins it. */
export const RESPONSE_BODY_UNDECODABLE = "error decoding response body";
/* eslint-enable lingui/no-unlocalized-strings */

export function isTransientOverleafTransportFailure(reason: unknown): boolean {
  return mentionsAny(toMessage(reason), [OVERLEAF_UNREACHABLE, RESPONSE_BODY_UNDECODABLE]);
}

/** The backend's session-expired and not-connected errors (overleaf_rt.rs), however a sync step wraps them. */
export function isOverleafSignedOut(reason: unknown): boolean {
  return mentionsAny(toMessage(reason), [OVERLEAF_SESSION_EXPIRED, OVERLEAF_NOT_CONNECTED]);
}
