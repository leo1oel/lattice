import { notifyError, notifySuccess, notifyWarning } from "../telemetry/app-notify";

/*
 * Ordinary toasts, so every message has one appearance and one log line. The
 * setter names survive from the old fixed banners because they read correctly
 * at ~170 call sites; `null` (the old "clear the banner") is a no-op, since a
 * toast owns its lifetime. Pass a `source` where the area is known, so the log
 * is searchable. Module scope, not `useCallback`, so no call site has to list
 * them as dependencies.
 */
export function setError(message: string | null, source = "App") {
  if (message) notifyError(source, message);
}
export function setWarning(message: string | null, source = "App") {
  if (message) notifyWarning(source, message);
}
export function setNotice(message: string | null, source = "App") {
  if (message) notifySuccess(source, message);
}
