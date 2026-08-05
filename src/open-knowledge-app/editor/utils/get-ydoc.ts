/**
 * Local seam — not upstream code.
 *
 * Upstream `get-ydoc.ts` extracts the Y.Doc from a TipTap Collaboration
 * extension. This host binds the editor to a plain Markdown string
 * (`text` + `onChangeMarkdown`) with NO Collaboration extension — the
 * canonical CRDT lives outside the editor in CollabTextClientV2. Upstream's
 * own contract ("returns undefined if no Collaboration extension is found")
 * therefore collapses to a constant, and keeping the seam free of `yjs`
 * imports keeps the collab boundary grep-clean.
 */
import type { Editor } from '@tiptap/core';

export function getYDoc(_editor: Editor): undefined {
  return undefined;
}
