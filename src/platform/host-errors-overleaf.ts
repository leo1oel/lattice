/**
 * Overleaf sync and live-editing errors (`src-tauri/lattice-core/src/overleaf*`), in the
 * interface language. See `host-error-text.ts` for how an entry is matched
 * and pinned. Diagnostics only an engineer acts on (a malformed handshake, a
 * missing root folder id) stay English.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

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
  ["overleaf/destination.rs", "That folder no longer exists. Choose another one.", () => t`That folder no longer exists. Choose another one.`],
  ["overleaf/destination.rs", "Lattice can't save files in that folder. Choose another one.", () => t`Lattice can't save files in that folder. Choose another one.`],
  ["overleaf/link.rs", "This project is already linked to an Overleaf project.", () => t`This project is already linked to an Overleaf project.`],
  ["overleaf/link.rs", "These files are too large for Overleaf: {}.", ([files]) => t`These files are too large for Overleaf: ${files}.`],
  ["overleaf/link.rs", "Overleaf does not allow these file names. Rename them first: {}.", ([files]) => t`Overleaf does not allow these file names. Rename them first: ${files}.`],
  ["overleaf/link.rs", "This project has no files that can be uploaded to Overleaf.", () => t`This project has no files that can be uploaded to Overleaf.`],
  ["overleaf/link.rs", "Resolve the conflict markers before publishing: {}.", ([files]) => t`Resolve the conflict markers before publishing: ${files}.`],
  ["overleaf/link.rs", "Could not prepare {path} for Overleaf: {error}", ([path, error]) => t`Could not prepare ${path} for Overleaf: ${error}`],
  ["overleaf/link.rs", "Could not upload the project to Overleaf: {error}", ([error]) => t`Could not upload the project to Overleaf: ${error}`],
  ["overleaf/link.rs", "Overleaf could not create the project ({status}): {detail}", ([status, detail]) => t`Overleaf could not create the project (${status}): ${detail}`],
  ["overleaf/link.rs", "Overleaf created {}/project/{project_id}, but Lattice could not link this folder: {error}", ([host, id, error]) => t`Overleaf created ${host}/project/${id}, but Lattice could not link this folder: ${error}`],
  ["overleaf/link.rs", "{} is not a folder.", ([path]) => t`${path} is not a folder.`],
  ["overleaf/sync/plan.rs", "Sync pending file moves with Overleaf before comparing file contents.", () => t`Sync pending file moves with Overleaf before comparing file contents.`],
  ["overleaf/sync.rs", "{path} disappeared during sync", ([path]) => t`${path} disappeared during sync`],
  ["overleaf/upload.rs", "Failed to upload \"{rel}\" to Overleaf: {cause}", ([path, cause]) => t`Failed to upload "${path}" to Overleaf: ${cause}`],
  ["overleaf/upload.rs", "Overleaf rejected the upload", () => t`Overleaf rejected the upload`],
  ["overleaf/upload.rs", "Overleaf returned HTTP {} during upload", ([status]) => t`Overleaf returned HTTP ${status} during upload`],
  ["overleaf/doc_push.rs", "Failed to send \"{path}\" to Overleaf: {error}", ([path, error]) => t`Failed to send "${path}" to Overleaf: ${error}`],
  ["overleaf/files.rs", "Could not record the sync base for {rel}: {e}", ([path, error]) => t`Could not record the sync base for ${path}: ${error}`],
  ["overleaf/sync/relocations.rs", "Waiting for Overleaf to confirm this account can edit the project before syncing moved files. Local moves have been kept.", () => t`Waiting for Overleaf to confirm this account can edit the project before syncing moved files. Local moves have been kept.`],
  ["overleaf/sync/relocations.rs", "Your Overleaf role on this project is reviewer, which cannot move or rename files. Local moves have been kept; syncing resumes once the project owner gives you edit access.", () => t`Your Overleaf role on this project is reviewer, which cannot move or rename files. Local moves have been kept; syncing resumes once the project owner gives you edit access.`],
  ["overleaf/sync/relocations.rs", "Your Overleaf role on this project is view-only, which cannot move or rename files. Local moves have been kept; syncing resumes once the project owner gives you edit access.", () => t`Your Overleaf role on this project is view-only, which cannot move or rename files. Local moves have been kept; syncing resumes once the project owner gives you edit access.`],
  ["overleaf/sync/relocations.rs", "Waiting for Overleaf's live file tree before syncing moved files.", () => t`Waiting for Overleaf's live file tree before syncing moved files.`],
  ["overleaf/sync/relocations.rs", "Could not locate {} on Overleaf to sync its move. No files were deleted.", ([path]) => t`Could not locate ${path} on Overleaf to sync its move. No files were deleted.`],
  ["overleaf/sync/relocations.rs", "A pending Overleaf move also changes its name.", () => t`A pending Overleaf move also changes its name.`],
  ["overleaf/sync/relocations.rs", "{folder_path} is not a folder on Overleaf.", ([path]) => t`${path} is not a folder on Overleaf.`],
  ["overleaf/sync/renames.rs", "Overleaf no longer has {deleted} but has {kept}, a name this disk may take for the same file, so deleting {deleted} here could delete {kept}. Move {deleted} out of the project, then sync again. No files were changed.", ([deleted, kept]) => t`Overleaf no longer has ${deleted} but has ${kept}, a name this disk may take for the same file, so deleting ${deleted} here could delete ${kept}. Move ${deleted} out of the project, then sync again. No files were changed.`],

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
  ["overleaf/doc_push.rs", "Overleaf did not say whether the edit applied.", () => t`Overleaf did not say whether the edit applied.`],
  ["overleaf_rt/client.rs", "Overleaf disconnected this session.", () => t`Overleaf disconnected this session.`],
  ["overleaf_rt/client.rs", "No Overleaf project selected.", () => t`No Overleaf project selected.`],
  ["overleaf_rt/client.rs", "Could not open the Overleaf realtime connection: {e}", ([error]) => t`Could not open the Overleaf realtime connection: ${error}`],
  ["ipc/overleaf_realtime.rs", "The Overleaf document ownership changed before it could be released.", () => t`The Overleaf document ownership changed before it could be released.`],
  ["app_state/overleaf_realtime.rs", "The Overleaf document is no longer joined.", () => t`The Overleaf document is no longer joined.`],
  ["ipc/overleaf_realtime.rs", "The project changed before Overleaf could connect.", () => t`The project changed before Overleaf could connect.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf live connection belongs to a different project.", () => t`The Overleaf live connection belongs to a different project.`],
  ["ipc/overleaf_realtime.rs", "Not connected to Overleaf's live editing channel.", () => t`Not connected to Overleaf's live editing channel.`],
  ["ipc/overleaf_realtime.rs", "A newer Overleaf connection replaced this one.", () => t`A newer Overleaf connection replaced this one.`],
  ["ipc/overleaf_realtime.rs", "The project changed before Overleaf could finish connecting.", () => t`The project changed before Overleaf could finish connecting.`],
  ["ipc/overleaf_realtime.rs", "Overleaf did not report that document in this project.", () => t`Overleaf did not report that document in this project.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf project changed before the document joined.", () => t`The Overleaf project changed before the document joined.`],
  ["ipc/overleaf_realtime.rs", "The Overleaf connection changed during the document join.", () => t`The Overleaf connection changed during the document join.`],
  ["ipc/overleaf_realtime.rs", "That Overleaf document is no longer open live.", () => t`That Overleaf document is no longer open live.`],

  // Overleaf's own replies (overleaf/api.rs, overleaf/link.rs, overleaf/files.rs, overleaf_rt/)
  // What was being asked for is Rust's English ("for the project chat"), so
  // the translation names only the status.
  ["overleaf/api.rs", "Overleaf returned {} {what}.", ([status]) => t`Overleaf returned ${status} for the request.`],
  ["overleaf/link.rs", "Overleaf's project join returned no root folder id.", () => t`Overleaf's project join returned no root folder id.`],
  ["overleaf/files.rs", "Invalid authoritative inventory path: {path}", ([path]) => t`Invalid authoritative inventory path: ${path}`],
  ["overleaf_rt/codec.rs", "Overleaf does not offer the websocket transport (offers {transports:?})", ([transports]) => t`Overleaf does not offer the websocket transport (offers ${transports})`],
  ["overleaf_rt/codec.rs", "Overleaf rejected {what}: {message}", ([what, message]) => t`Overleaf rejected ${what}: ${message}`],
  ["overleaf_rt/codec.rs", "The Overleaf host must start with http:// or https:// (got {host:?})", ([host]) => t`The Overleaf host must start with http:// or https:// (got ${host})`],
  ["overleaf_rt/tree.rs", "Overleaf's project has an empty rootFolder.", () => t`Overleaf's project has an empty rootFolder.`],
  ["overleaf_rt/tree.rs", "Overleaf's project has an unexpected rootFolder.", () => t`Overleaf's project has an unexpected rootFolder.`],
  ["overleaf_rt/tree.rs", "Overleaf's root folder has no id.", () => t`Overleaf's root folder has no id.`],

  // Syncing through Overleaf's git bridge (git/bridge.rs, overleaf/git_sync.rs, overleaf_git_token.rs)
  ["overleaf/git_sync.rs", "Add your Overleaf git token in Settings → Overleaf to sync through git.", () => t`Add your Overleaf git token in Settings → Overleaf to sync through git.`],
  ["overleaf/git_sync.rs", "This project is not set to sync through git.", () => t`This project is not set to sync through git.`],
  ["overleaf/git_sync.rs", "This project's Overleaf id is not valid for git.", () => t`This project's Overleaf id is not valid for git.`],
  ["overleaf/link.rs", "This project syncs through git, which has no live editing. Switch back to Overleaf sync in Settings → Overleaf to edit live.", () => t`This project syncs through git, which has no live editing. Switch back to Overleaf sync in Settings → Overleaf to edit live.`],
  ["ipc/overleaf.rs", "This project syncs through git, so there is no Overleaf preview. Review the changes with git.", () => t`This project syncs through git, so there is no Overleaf preview. Review the changes with git.`],
  ["git/bridge.rs", "Git sync needs the project folder to be its own git repository, not a folder inside another one.", () => t`Git sync needs the project folder to be its own git repository, not a folder inside another one.`],
  ["git/bridge.rs", "There is no merge with Overleaf to finish. Sync to bring in Overleaf's changes.", () => t`There is no merge with Overleaf to finish. Sync to bring in Overleaf's changes.`],
  ["overleaf/git_sync.rs", "Resolve the conflicts in {} first, then finish the merge.", ([files]) => t`Resolve the conflicts in ${files} first, then finish the merge.`],
  ["git/bridge.rs", "Overleaf did not accept the git token. Check it in Settings → Overleaf. Git access needs an Overleaf plan that includes the git integration.", () => t`Overleaf did not accept the git token. Check it in Settings → Overleaf. Git access needs an Overleaf plan that includes the git integration.`],
  ["git/bridge.rs", "Overleaf's git bridge has no such project. It may not be available for this account or host.", () => t`Overleaf's git bridge has no such project. It may not be available for this account or host.`],
  ["git/bridge.rs", "Overleaf's git bridge has no branch for this project yet.", () => t`Overleaf's git bridge has no branch for this project yet.`],
  ["git/bridge.rs", "Overleaf changed while this was syncing. Sync again to merge those changes.", () => t`Overleaf changed while this was syncing. Sync again to merge those changes.`],
  ["overleaf_git_token.rs", "The git token is empty.", () => t`The git token is empty.`],
  ["overleaf_git_token.rs", "That does not look like an Overleaf git token.", () => t`That does not look like an Overleaf git token.`],
];
