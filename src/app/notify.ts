import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { toMessage } from "../app-utils";
import { notifyError, notifySuccess, notifyWarning } from "../telemetry/app-notify";

/*
 * Ordinary toasts, so every message has one appearance and one log line. The
 * setter names survive from the old fixed banners because they read correctly
 * at their many call sites; an empty message shows nothing. Pass a `source`
 * where the area is known, so the log is searchable. Module scope, not
 * `useCallback`, so no call site has to list them as dependencies.
 */
export function setError(message: string, source?: string) {
  if (message) notifyError(source ?? i18n._(msg`App`), message);
}
export function setWarning(message: string, source?: string) {
  if (message) notifyWarning(source ?? i18n._(msg`App`), message);
}
export function setNotice(message: string, source?: string) {
  if (message) notifySuccess(source ?? i18n._(msg`App`), message);
}

/** Run `action`; a failure shows its message as an error. */
export async function showingErrors(action: () => Promise<unknown>) {
  await action().catch((reason: unknown) => setError(toMessage(reason)));
}
