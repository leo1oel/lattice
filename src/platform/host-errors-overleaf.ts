/**
 * Overleaf sync and live-editing errors (`src-tauri/src/overleaf*`), in the
 * interface language. See `host-error-text.ts` for how an entry is matched
 * and pinned. Diagnostics only an engineer acts on (a malformed handshake, a
 * missing root folder id) stay English.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

export const OVERLEAF_HOST_ERRORS: readonly HostErrorEntry[] = [
  // Session and connection (overleaf_rt.rs, overleaf/api.rs, overleaf/account.rs)
  ["overleaf_rt.rs", "Overleaf session expired. Reconnect in Settings → Overleaf.", () => t`Overleaf session expired. Reconnect in Settings → Overleaf.`],
  ["overleaf_rt.rs", "Not connected to Overleaf. Connect in Settings → Overleaf.", () => t`Not connected to Overleaf. Connect in Settings → Overleaf.`],
  ["overleaf_rt.rs", "Overleaf turned this request away, though the session is still valid.", () => t`Overleaf turned this request away, though the session is still valid.`],
  ["overleaf_rt.rs", "This Overleaf account can no longer open the project. It may have been removed from the project, or the project deleted.", () => t`This Overleaf account can no longer open the project. It may have been removed from the project, or the project deleted.`],
  ["overleaf/api.rs", "Could not reach Overleaf: {e}", ([error]) => t`Could not reach Overleaf: ${error}`],
  ["overleaf/api.rs", "Could not reach Overleaf while reading the project list: {error}", ([error]) => t`Could not reach Overleaf while reading the project list: ${error}`],
  ["overleaf/api.rs", "Could not download the project from Overleaf: {e}", ([error]) => t`Could not download the project from Overleaf: ${error}`],
  ["overleaf/api.rs", "Could not reach Overleaf while reading the project download: {error}", ([error]) => t`Could not reach Overleaf while reading the project download: ${error}`],
  ["overleaf/api.rs", "Overleaf sent an unreadable zip archive: {e}", ([error]) => t`Overleaf sent an unreadable zip archive: ${error}`],
  ["overleaf/api.rs", "This project is linked to {linked_host}. Sign out and connect to that Overleaf host to continue.", ([host]) => t`This project is linked to ${host}. Sign out and connect to that Overleaf host to continue.`],
  ["overleaf/account.rs", "Paste the Overleaf session cookie first.", () => t`Paste the Overleaf session cookie first.`],
  ["overleaf/account.rs", "Overleaf rejected that cookie. Copy a fresh session cookie from a logged-in browser and try again.", () => t`Overleaf rejected that cookie. Copy a fresh session cookie from a logged-in browser and try again.`],
  ["overleaf/account.rs", "That cookie did not open the Overleaf dashboard. Copy a fresh session cookie from a logged-in browser and try again.", () => t`That cookie did not open the Overleaf dashboard. Copy a fresh session cookie from a logged-in browser and try again.`],
  ["ipc/overleaf.rs", "Invalid Overleaf host: {error}", ([error]) => t`Invalid Overleaf host: ${error}`],
  ["ipc/overleaf.rs", "Could not open the Overleaf sign-in window: {error}", ([error]) => t`Could not open the Overleaf sign-in window: ${error}`],
  ["overleaf_rt/codec.rs", "No Overleaf host configured.", () => t`No Overleaf host configured.`],

  // Linking and syncing (overleaf/link.rs, overleaf/sync.rs, overleaf/upload.rs)
  ["overleaf/link.rs", "Syncing is paused for this project. Resume it in Settings → Overleaf.", () => t`Syncing is paused for this project. Resume it in Settings → Overleaf.`],
  ["overleaf/link.rs", "Overleaf is still preparing file uploads. Try syncing again in a moment.", () => t`Overleaf is still preparing file uploads. Try syncing again in a moment.`],
  ["overleaf/link.rs", "This project is not linked to an Overleaf project.", () => t`This project is not linked to an Overleaf project.`],
  ["overleaf/link.rs", "That Overleaf project name cannot be used as a folder name.", () => t`That Overleaf project name cannot be used as a folder name.`],
  ["overleaf/link.rs", "This project is already linked to an Overleaf project.", () => t`This project is already linked to an Overleaf project.`],
  ["overleaf/link.rs", "These files are too large for Overleaf: {}.", ([files]) => t`These files are too large for Overleaf: ${files}.`],
  ["overleaf/link.rs", "This project has no files that can be uploaded to Overleaf.", () => t`This project has no files that can be uploaded to Overleaf.`],
  ["overleaf/link.rs", "Resolve the conflict markers before publishing: {}.", ([files]) => t`Resolve the conflict markers before publishing: ${files}.`],
  ["overleaf/link.rs", "Could not prepare {path} for Overleaf: {error}", ([path, error]) => t`Could not prepare ${path} for Overleaf: ${error}`],
  ["overleaf/link.rs", "Could not upload the project to Overleaf: {error}", ([error]) => t`Could not upload the project to Overleaf: ${error}`],
  ["overleaf/link.rs", "Overleaf could not create the project ({status}): {detail}", ([status, detail]) => t`Overleaf could not create the project (${status}): ${detail}`],
  ["overleaf/link.rs", "Overleaf created {}/project/{project_id}, but Lattice could not link this folder: {error}", ([host, id, error]) => t`Overleaf created ${host}/project/${id}, but Lattice could not link this folder: ${error}`],
  ["overleaf/link.rs", "{} is not a folder.", ([path]) => t`${path} is not a folder.`],
  ["overleaf/sync.rs", "Sync pending file moves with Overleaf before comparing file contents.", () => t`Sync pending file moves with Overleaf before comparing file contents.`],
  ["overleaf/sync.rs", "{path} disappeared during sync", ([path]) => t`${path} disappeared during sync`],
  ["overleaf/upload.rs", "Failed to upload \"{rel}\" to Overleaf: {cause}", ([path, cause]) => t`Failed to upload "${path}" to Overleaf: ${cause}`],
  ["overleaf/upload.rs", "Overleaf rejected the upload", () => t`Overleaf rejected the upload`],
  ["overleaf/upload.rs", "Overleaf returned HTTP {} during upload", ([status]) => t`Overleaf returned HTTP ${status} during upload`],
  ["overleaf/doc_push.rs", "Failed to send \"{path}\" to Overleaf: {error}", ([path, error]) => t`Failed to send "${path}" to Overleaf: ${error}`],
  ["overleaf/files.rs", "Could not record the sync base for {rel}: {e}", ([path, error]) => t`Could not record the sync base for ${path}: ${error}`],
  ["overleaf/sync/relocations.rs", "Overleaf write access is required to sync moved files. Local moves have been kept.", () => t`Overleaf write access is required to sync moved files. Local moves have been kept.`],
  ["overleaf/sync/relocations.rs", "Waiting for Overleaf's live file tree before syncing moved files.", () => t`Waiting for Overleaf's live file tree before syncing moved files.`],
  ["overleaf/sync/relocations.rs", "Could not locate {} on Overleaf to sync its move. No files were deleted.", ([path]) => t`Could not locate ${path} on Overleaf to sync its move. No files were deleted.`],
  ["overleaf/sync/relocations.rs", "A pending Overleaf move also changes its name.", () => t`A pending Overleaf move also changes its name.`],
  ["overleaf/sync/relocations.rs", "{folder_path} is not a folder on Overleaf.", ([path]) => t`${path} is not a folder on Overleaf.`],

  // Review: chat, comments and history (overleaf/review.rs)
  ["overleaf/review.rs", "Write a message first.", () => t`Write a message first.`],
  ["overleaf/review.rs", "Write a reply first.", () => t`Write a reply first.`],
  ["overleaf/review.rs", "A comment cannot be empty. Delete it instead.", () => t`A comment cannot be empty. Delete it instead.`],
  ["overleaf/review.rs", "Overleaf's full history needs a paid plan on this project.", () => t`Overleaf's full history needs a paid plan on this project.`],
  ["overleaf/review.rs", "Overleaf's history since the last sync is longer than Lattice reads at once.", () => t`Overleaf's history since the last sync is longer than Lattice reads at once.`],

  // Live editing (overleaf_rt/client.rs, ipc/overleaf_realtime.rs)
  ["overleaf_rt/client.rs", "You have read-only access to this Overleaf project, so edits stay on this machine.", () => t`You have read-only access to this Overleaf project, so edits stay on this machine.`],
  ["overleaf_rt/client.rs", "The Overleaf realtime connection closed before the server answered.", () => t`The Overleaf realtime connection closed before the server answered.`],
  ["overleaf_rt/client.rs", "Could not reach Overleaf ({e}).", ([error]) => t`Could not reach Overleaf (${error}).`],
  ["overleaf_rt/client.rs", "Overleaf refused the realtime handshake (HTTP {}).", ([status]) => t`Overleaf refused the realtime handshake (HTTP ${status}).`],
  ["overleaf_rt/client.rs", "The Overleaf realtime connection is closed.", () => t`The Overleaf realtime connection is closed.`],
  ["overleaf_rt/client.rs", "The Overleaf realtime connection closed.", () => t`The Overleaf realtime connection closed.`],
  ["overleaf_rt/client.rs", "The Overleaf server closed the connection: {}", ([reason]) => t`The Overleaf server closed the connection: ${reason}`],
  ["overleaf_rt/client.rs", "The Overleaf server closed the connection.", () => t`The Overleaf server closed the connection.`],
  ["overleaf_rt/client.rs", "The Overleaf realtime connection failed: {e}", ([error]) => t`The Overleaf realtime connection failed: ${error}`],
  ["overleaf_rt/client.rs", "Overleaf has sent nothing for {}s, so the connection is presumed lost.", ([seconds]) => t`Overleaf has sent nothing for ${seconds}s, so the connection is presumed lost.`],
  ["overleaf_rt/client.rs", "The Overleaf realtime server returned an error: {}", ([error]) => t`The Overleaf realtime server returned an error: ${error}`],
  ["overleaf_rt/client.rs", "Overleaf rejected the realtime connection.", () => t`Overleaf rejected the realtime connection.`],
  ["overleaf_rt/client.rs", "Overleaf rejected the edit.", () => t`Overleaf rejected the edit.`],
  ["overleaf_rt/client.rs", "Overleaf disconnected this session.", () => t`Overleaf disconnected this session.`],
  ["overleaf_rt/client.rs", "No Overleaf project selected.", () => t`No Overleaf project selected.`],
  ["overleaf_rt/client.rs", "Could not open the Overleaf realtime connection: {e}", ([error]) => t`Could not open the Overleaf realtime connection: ${error}`],
  ["ipc/overleaf_realtime.rs", "The Overleaf document ownership changed before it could be released.", () => t`The Overleaf document ownership changed before it could be released.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf document is no longer joined.", () => t`The Overleaf document is no longer joined.`],
  ["ipc/overleaf_realtime.rs", "The project changed before Overleaf could connect.", () => t`The project changed before Overleaf could connect.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf live connection belongs to a different project.", () => t`The Overleaf live connection belongs to a different project.`],
  ["ipc/overleaf_realtime.rs", "Not connected to Overleaf's live editing channel.", () => t`Not connected to Overleaf's live editing channel.`],
  ["ipc/overleaf_realtime.rs", "A newer Overleaf connection replaced this one.", () => t`A newer Overleaf connection replaced this one.`],
  ["ipc/overleaf_realtime.rs", "The project changed before Overleaf could finish connecting.", () => t`The project changed before Overleaf could finish connecting.`],
  ["ipc/overleaf_realtime.rs", "Overleaf did not report that document in this project.", () => t`Overleaf did not report that document in this project.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf project changed before the document joined.", () => t`The Overleaf project changed before the document joined.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf connection changed during the document join.", () => t`The Overleaf connection changed during the document join.`],
  ["ipc/overleaf_realtime.rs", "That Overleaf document is no longer open live.", () => t`That Overleaf document is no longer open live.`],
];
