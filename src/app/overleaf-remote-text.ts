/**
 * A live Overleaf document's text arriving from a co-author, taken into the
 * open file: written to disk and shown, only while nothing newer is there.
 */
import { invoke } from "@tauri-apps/api/core";
import { reviewMode } from "../history/review-mode-store";
import type { OverleafRemoteTextContext } from "../overleaf/use-overleaf-realtime";
import type { OverleafWorkspaceDeps } from "./use-overleaf-workspace";

/**
 * Apply only against the buffer and disk versions the live channel knows.
 *
 * The view is left alone: the editor takes in only what changed, so the
 * place and the caret stay with their text (see codemirror-host.tsx). This
 * runs on every return to a live document's tab, with Overleaf's copy of the
 * text on screen; anything it did to the view would move a tab that came
 * back in place.
 */
export async function applyOverleafRemoteText(
  deps: Pick<OverleafWorkspaceDeps,
    "projectRef" | "projectOperationGenerationRef" | "activeFileRef" | "sourceRef" | "savedSourceRef"
    | "accept">,
  text: string,
  context: OverleafRemoteTextContext,
): Promise<boolean> {
  const { path, projectRoot, baseContent } = context;
  const generation = deps.projectOperationGenerationRef.current;
  const isCurrent = () => context.isCurrent()
    && deps.projectRef.current?.root === projectRoot
    && deps.projectOperationGenerationRef.current === generation
    && deps.activeFileRef.current === path;
  if (!isCurrent() || deps.sourceRef.current !== baseContent) return false;
  const saved = deps.savedSourceRef.current;
  if (text === baseContent && saved !== baseContent) return false;
  // A compare-and-swap, never a merge against a guessed ancestor: a join
  // snapshot must not erase agent edits that have not reached the editor yet.
  // Ordinary sync, which has the real shared baseline, reconciles divergence.
  await invoke("write_project_file", { path, projectRoot, content: text, expectedContent: saved });
  // Typing during IPC stays dirty against its original saved base; the
  // ordinary editor save can merge it with the remote bytes now on disk.
  // A co-author's text is not the writer's tracked change: it moves review mode's base.
  reviewMode.noteCoauthorText(path, text);
  // No build from here: the write above is not the app's own save, so the
  // project watcher reports it and watched-builds.ts decides, like any edit
  // made outside the editor. That honours manual builds and lets a co-author's
  // burst of keystrokes build once when it pauses; a requested build per
  // operation compiled and reloaded the PDF on every key they pressed.
  return isCurrent() && deps.accept(path, text, { text: baseContent, saved });
}
