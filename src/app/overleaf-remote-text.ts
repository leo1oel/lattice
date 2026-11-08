/**
 * A live Overleaf document's text arriving from a co-author, taken into the
 * open file: written to disk and shown, only while nothing newer is there.
 */
import { invoke } from "@tauri-apps/api/core";
import { noteHostFileWrites } from "../agent/agent-host-writes";
import { reviewMode } from "../history/review-mode-store";
import { diffToOps, rebaseOnto } from "../overleaf/ot";
import type { OverleafRemoteTextContext } from "../overleaf/use-overleaf-realtime";
import type { OverleafWorkspaceDeps } from "./use-overleaf-workspace";

/** An editor save can land between reading the saved text and writing over it; try again this often. */
const SAVE_RACE_RETRIES = 2;

/**
 * Apply only against the buffer and disk versions the live channel knows.
 *
 * The view is left alone: the editor takes in only what changed, so the
 * place and the caret stay with their text (see codemirror-host.tsx). This
 * runs on every return to a live document's tab, with Overleaf's copy of the
 * text on screen; anything it did to the view would move a tab that came
 * back in place.
 *
 * The writer keeps typing while this crosses IPC, and while a co-author's
 * operation was on its way. That typing is the writer's own work on top of
 * the text the channel knows (`context.carryTyping`), so it is carried onto
 * the new text instead of failing the compare-and-swap: failing it used to
 * hand the file to regular sync, seconds behind, every time both people typed
 * at once.
 */
export async function applyOverleafRemoteText(
  deps: Pick<OverleafWorkspaceDeps,
    "projectRef" | "projectOperationGenerationRef" | "activeFileRef" | "sourceRef" | "savedSourceRef"
    | "accept">,
  text: string,
  context: OverleafRemoteTextContext,
): Promise<boolean> {
  const { path, projectRoot, baseContent, ops, carryTyping } = context;
  const generation = deps.projectOperationGenerationRef.current;
  const isCurrent = () => context.isCurrent()
    && deps.projectRef.current?.root === projectRoot
    && deps.projectOperationGenerationRef.current === generation
    && deps.activeFileRef.current === path;
  for (let attempt = 0; ; attempt += 1) {
    if (!isCurrent()) return false;
    const current = deps.sourceRef.current;
    const saved = deps.savedSourceRef.current;
    // A joined snapshot the buffer already shows needs nothing merged.
    const merged = current === baseContent ? text
      : !carryTyping ? (current === text ? text : null)
      : rebaseOnto(baseContent, current, ops, text);
    if (merged === null) return false;
    if (merged === current && saved !== current && !carryTyping) return false;
    try {
      // A compare-and-swap, never a merge against a guessed ancestor: a join
      // snapshot must not erase agent edits that have not reached the editor yet.
      // Ordinary sync, which has the real shared baseline, reconciles divergence.
      await invoke("write_project_file", { path, projectRoot, content: merged, expectedContent: saved });
    } catch (reason) {
      // The editor's own save got there first: the disk is still ours.
      if (attempt < SAVE_RACE_RETRIES && deps.savedSourceRef.current !== saved) continue;
      throw reason;
    }
    // Nor the agent's: an Agent Undo must not reverse it along with the agent's change.
    if (merged !== saved) noteHostFileWrites(projectRoot, [path]);
    if (!isCurrent()) return false;
    // Typing during IPC rides on top of what is now on disk, unsaved; the
    // ordinary editor save writes it, and the live channel sends it.
    const step = current === merged ? [] : diffToOps(current, merged);
    const accepted = deps.accept(path, merged, {
      saved,
      show: (now) => {
        const shown = now === current ? merged : rebaseOnto(current, now, step, merged);
        // A co-author's text is not the writer's tracked change: it moves review mode's base.
        if (shown !== null) reviewMode.noteCoauthorText(path, shown);
        return shown;
      },
    });
    // No build from here: the write above is not the app's own save, so the
    // project watcher reports it and watched-builds.ts decides, like any edit
    // made outside the editor. That honours manual builds and lets a co-author's
    // burst of keystrokes build once when it pauses; a requested build per
    // operation compiled and reloaded the PDF on every key they pressed.
    return accepted;
  }
}
