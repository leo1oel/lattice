import { invoke } from "@tauri-apps/api/core";
import type { OpenSlideMutation } from "../editor/presentation/open-slide-bridge";

export type EditorWriteResult = {
  content: string;
  transactionId: string;
  externalChangesMerged: boolean;
  hadConflicts: boolean;
};

/**
 * Writes one Open Slide edit and returns the canonical content that landed (a
 * three-way merge against the edit's base may differ from what Open Slide sent).
 */
export async function writeOpenSlideMutation(
  mutation: OpenSlideMutation,
  projectRoot: string,
  projectStillOpen: () => boolean,
): Promise<{ text?: string; base64?: string; hadConflicts: boolean }> {
  const { path } = mutation;
  if (mutation.kind === "delete") {
    try {
      await invoke("delete_project_entry", { path, projectRoot });
    } catch (reason) {
      // The shadow watcher and native project watcher can report the same
      // unlink concurrently. A missing canonical file already satisfies
      // the requested delete, so acknowledge that echo instead of rolling
      // it back into Open Slide and showing an error.
      if (!projectStillOpen()) throw reason;
      const stat = await invoke<{ exists: boolean }>("stat_project_file", { path }).catch(() => null);
      if (stat?.exists !== false) throw reason;
    }
    return { hadConflicts: false };
  }

  if (mutation.text !== undefined) {
    const written = await invoke<EditorWriteResult>("write_project_file", {
      path,
      content: mutation.text,
      baseContent: mutation.kind === "write" ? mutation.previousText : undefined,
      projectRoot,
    });
    return { text: written.content, hadConflicts: written.hadConflicts };
  }

  if (mutation.base64 !== undefined) {
    await invoke("write_project_bytes", { path, base64Data: mutation.base64, projectRoot });
    return { base64: mutation.base64, hadConflicts: false };
  }

  throw new Error(`Open Slide sent an incomplete edit for ${path}.`);
}
