/** Overleaf responses for a linked, connected project, for the App suites; tests override what they exercise. */
import type { Commands } from "./app-test-utils";

export const overleafLink = (link: object = {}) => ({
  projectId: "ol-project", projectName: "Overleaf paper", host: "https://www.overleaf.com", lastSync: null, paused: false, ...link,
});
export const overleafStatus = (status: object = {}) => ({
  connected: true, expired: false, email: "writer@example.com", name: "Writer", host: "https://www.overleaf.com", ...status,
});
export const overleafProbe = (probe: object = {}) => ({
  changed: false, localChanged: false, versionKnown: true, remoteVersion: 1, lastSync: null, ...probe,
});
export const overleafSyncResult = (result: object = {}) => ({
  pulled: [], pushed: [], merged: [], conflicts: [], deletedLocal: [], skippedRemoteDeletes: [],
  automaticRemoteDeletes: [], readOnly: false, ...result,
});
export const overleafSession = (session: object = {}) => ({
  publicId: null, rootFolderId: "root", docs: [{ id: "main-doc", path: "main.tex" }], entities: [],
  permission: "readAndWrite", trackChanges: false, userId: null, ...session,
});
/** The realtime feeds an open Overleaf project polls, all empty. */
export const OVERLEAF_EMPTY_FEEDS = {
  overleaf_chat_messages: () => [], overleaf_threads: () => [], overleaf_comment_anchors: () => [],
  overleaf_change_authors: () => [], overleaf_rt_connected_users: () => [],
};
/** The commands of a linked Overleaf project whose realtime session opens with empty feeds. */
export function overleafCommands(overrides: Commands = {}): Commands {
  return {
    overleaf_link: () => overleafLink(), overleaf_status: () => overleafStatus(), overleaf_probe: () => overleafProbe(),
    overleaf_sync: () => overleafSyncResult(), overleaf_rt_connect: () => overleafSession(), overleaf_rt_disconnect: undefined,
    git_auto_commit: null, ...OVERLEAF_EMPTY_FEEDS, ...overrides,
  };
}
