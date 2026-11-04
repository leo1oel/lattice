/** First-party Google host diagnostics; provider response bodies are never displayed. */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";
/* eslint-disable lingui/no-unlocalized-strings -- exact native literals are matched as data; translations sit beside them */
export const GOOGLE_HOST_ERRORS: readonly HostErrorEntry[] = [
  [
    "google_workspace/account.rs",
    "Google Workspace request failed. Check account access, enabled APIs and the requested operation.",
    () =>
      t`Google Workspace request failed. Check account access, enabled APIs and the requested operation.`,
  ],
  [
    "google_workspace/account.rs",
    "Provide a Google Desktop OAuth client and select at least one product.",
    () =>
      t`Provide a Google Desktop OAuth client and select at least one product.`,
  ],
  [
    "google_workspace/account.rs",
    "Connect Google Workspace first.",
    () => t`Connect Google Workspace first.`,
  ],
  [
    "google_workspace/account.rs",
    "Invalid Google account storage.",
    () => t`Invalid Google account storage.`,
  ],
  [
    "google_workspace/account.rs",
    "Google account storage must be private (chmod 600).",
    () => t`Google account storage must be private (chmod 600).`,
  ],
  [
    "google_workspace/account.rs",
    "Google access expired. Connect again.",
    () => t`Google access expired. Connect again.`,
  ],
  [
    "google_workspace/account.rs",
    "Google access expired or was revoked. Connect again.",
    () => t`Google access expired or was revoked. Connect again.`,
  ],
  [
    "google_workspace/api.rs",
    "Provide a Google resource ID.",
    () => t`Provide a Google resource ID.`,
  ],
  [
    "google_workspace/api.rs",
    "Google request exceeds the one-megabyte limit.",
    () => t`Google request exceeds the one-megabyte limit.`,
  ],
  [
    "google_workspace/api.rs",
    "Provide a title of at most 300 bytes.",
    () => t`Provide a title of at most 300 bytes.`,
  ],
  [
    "google_workspace/api.rs",
    "Sheets updates require a values array.",
    () => t`Sheets updates require a values array.`,
  ],
  [
    "google_workspace/api.rs",
    "Provide between 1 and 200 batchUpdate requests.",
    () => t`Provide between 1 and 200 batchUpdate requests.`,
  ],
  [
    "google_workspace/api.rs",
    "This Google Workspace operation is not supported.",
    () => t`This Google Workspace operation is not supported.`,
  ],
  [
    "google_workspace/api.rs",
    "Provide an event object.",
    () => t`Provide an event object.`,
  ],
  [
    "google_workspace/api.rs",
    "Calendar supports private event fields only; attendees and invitations are unavailable.",
    () =>
      t`Calendar supports private event fields only; attendees and invitations are unavailable.`,
  ],
  [
    "google_workspace/api.rs",
    "Calendar supports private events only.",
    () => t`Calendar supports private events only.`,
  ],
  [
    "google_workspace/api.rs",
    "Reconnect Google Workspace with permission for this product.",
    () => t`Reconnect Google Workspace with permission for this product.`,
  ],
  [
    "google_workspace/api.rs",
    "Google did not grant permission for this operation. Reconnect and approve its scope.",
    () =>
      t`Google did not grant permission for this operation. Reconnect and approve its scope.`,
  ],
  [
    "google_workspace/api.rs",
    "This event has attendees. Use Google Calendar to manage meetings.",
    () => t`This event has attendees. Use Google Calendar to manage meetings.`,
  ],
  [
    "google_workspace/api.rs",
    "Could not verify the Calendar event version. Read it again before updating.",
    () =>
      t`Could not verify the Calendar event version. Read it again before updating.`,
  ],
  [
    "google_workspace/api.rs",
    "Google denied this operation. Check the selected scopes, file access and enabled APIs.",
    () =>
      t`Google denied this operation. Check the selected scopes, file access and enabled APIs.`,
  ],
  [
    "google_workspace/api.rs",
    "Google rate limit reached. Try again later.",
    () => t`Google rate limit reached. Try again later.`,
  ],
  [
    "google_workspace/api.rs",
    "Google response exceeds the twenty-megabyte limit.",
    () => t`Google response exceeds the twenty-megabyte limit.`,
  ],
  [
    "google_workspace/oauth.rs",
    "Could not open the Google sign-in callback.",
    () => t`Could not open the Google sign-in callback.`,
  ],
  [
    "google_workspace/oauth.rs",
    "Google sign-in was cancelled or timed out.",
    () => t`Google sign-in was cancelled or timed out.`,
  ],
  [
    "google_workspace/oauth.rs",
    "Google sign-in was declined.",
    () => t`Google sign-in was declined.`,
  ],
  [
    "ipc/google_workspace.rs",
    "Could not locate Google account storage.",
    () => t`Could not locate Google account storage.`,
  ],
  [
    "ipc/google_workspace.rs",
    "Could not open the default browser for Google sign-in.",
    () => t`Could not open the default browser for Google sign-in.`,
  ],
];
