/**
 * Local seam — not upstream code.
 *
 * Upstream `agent-flash-source.ts` highlights agent-authored spans in
 * source-mode CodeMirror by reading Y.Doc metadata — collab boundary this
 * host must not import (remote edits arrive as full-string replaces, not
 * Yjs churn). `nested-cm-extensions` already skips the extension when no
 * Y.Doc is present (`getYDoc` seam returns undefined), so this factory is
 * never called at runtime; it exists only to satisfy the import.
 */
import type { Extension } from '@codemirror/state';

export function createAgentFlashSourceExtension(_ydoc: unknown): Extension {
  return [];
}
