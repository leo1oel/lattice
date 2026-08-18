import { notifyError, notifySuccess, notifyWarning } from "../telemetry/app-notify";

/*
 * These three used to render their own fixed banners beside — and in a
 * different style from — the toast stack. They now raise ordinary toasts, so
 * every message the app produces has one appearance and one log line.
 *
 * The setter names are kept because they read correctly at ~170 call sites, and
 * passing `null` (the old "clear the banner" call) is simply a no-op: a toast
 * owns its own lifetime. Pass a `source` wherever the area is known — a log is
 * only searchable if its entries say where they came from.
 *
 * Module scope, not `useCallback`: they close over nothing, and a hook-created
 * identity would have to be listed as a dependency by every one of those call
 * sites' enclosing hooks.
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
