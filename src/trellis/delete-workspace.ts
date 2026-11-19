/**
 * Deleting a named workspace, from its tab's menu, the folded switch's menu
 * or the command palette. No confirmation: the toast that reports it brings
 * it back.
 *
 * Eager (the titlebar and the command table use it) and light.
 */
import { t } from "@lingui/core/macro";
import { notifyInfo } from "../telemetry/app-notify";
import type { TrellisController } from "./trellis-controller";
import { spaceMixedScript } from "./trellis-titles";

/** The toast that offers to bring a deleted workspace back; a later deletion's replaces it. */
const DELETE_UNDO_TOAST = "trellis-workspace-deleted";

/** Delete the workspace `id`, never the last; the project in it moves to its neighbour. */
export function deleteWorkspace(controller: TrellisController, id: string) {
  const library = controller.workspaces;
  const list = library.list();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0 || list.length < 2) return;
  const wasCurrent = controller.ui.get().workspace === id;
  const fallback = (list[index + 1] ?? list[index - 1]).id;
  if (wasCurrent) controller.switchWorkspace(fallback);
  const removed = library.remove(id);
  if (!removed) return;
  const { name } = list[index];
  notifyInfo(t`Layout`, spaceMixedScript(t`Deleted “${name}”`), {
    dedupeKey: DELETE_UNDO_TOAST,
    primaryAction: {
      label: t`Undo`,
      onClick: () => {
        library.restore(removed);
        if (wasCurrent && controller.ui.get().workspace === fallback) controller.switchWorkspace(id);
      },
    },
  });
}
