/**
 * Local seam — not upstream code.
 *
 * Stand-in for `@tiptap/y-tiptap` for the one vendored consumer
 * (bridge-id-plugin.ts) that reads `ySyncPluginKey.getState(state)` to key
 * jsxComponent identity off the y-prosemirror binding when one exists.
 *
 * This host has no y-prosemirror/y-sync binding (canonical authority is the
 * collab Y.Text("content") behind a plain-string editor boundary), so this
 * key is never installed into any editor state: `getState()` always returns
 * `undefined`, and bridge-id-plugin's documented no-Yjs fallback path
 * (nonce ids + tr.mapping remaps) becomes the entire behavior.
 *
 * Deliberately NOT re-exporting anything else from @tiptap/y-tiptap: any
 * new vendored import from that package must be reviewed against the
 * no-second-canonical-authority constraint first.
 */
import { PluginKey } from "@tiptap/pm/state";

export const ySyncPluginKey = new PluginKey("y-sync-stub");
