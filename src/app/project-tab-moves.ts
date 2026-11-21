/** Moving a project tab between windows, from either end. Loaded when a tab
 * is first dropped outside its strip or another window first asks this one
 * to take a tab, so windows that never trade tabs don't load it at startup. */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { projectHasActiveAgent } from "../agent/agent-turn-activity";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { showError, showNotice } from "./notify";
import type { MoveRequest, ProjectTabDestination, TransferDeps } from "./project-tab-transfer";
import { flushWindowProjectGroup, windowProjects } from "./window-projects";

type Actions = TransferDeps & { title: string };

const confirmLeaving = (project: ProjectSnapshot, building: boolean) => (
  import("./leave-project").then(({ confirmLeavingProject }) => confirmLeavingProject(project.manifest.name, building))
);

/** The source Agent stays tied to this window, so wait for its turn before transfer. */
export async function moveProjectTabFrom(actions: Actions, root: string, target: ProjectTabDestination | null) {
  await actions.holdWindow(undefined, async () => {
    const active = actions.projectRef.current;
    const tabs = windowProjects.get();
    const index = tabs.findIndex((tab) => tab.root === root);
    // A window's only project dropped on the desktop stays put: the window
    // already shows it alone, and moving the window is the title bar's job.
    if (!active || index < 0 || (!target && tabs.length < 2)) return;
    if (projectHasActiveAgent(root)) {
      showNotice(i18n._(msg`Wait for the Agent to finish before moving this project to a new window.`));
      return;
    }
    const movingActive = active.root === root;
    const neighbour = tabs[index + 1] ?? tabs[index - 1];
    let transferred = false;
    if (movingActive && !await confirmLeaving(active, actions.building)) return;
    actions.setBusyLabel(actions.title);
    await (async () => {
      if (movingActive) {
        if (!await actions.startProjectTransition()) return;
        actions.setMovingWorkspace(true);
      }
      await flushWindowProjectGroup();
      transferred = await invoke<boolean>("move_project_tab", {
        request: { id: crypto.randomUUID(), root, sourceRoot: active.root, target },
      });
      if (!transferred) return;
      windowProjects.remove(root);
      if (!movingActive) return;
      actions.forgetTransferredProject(Boolean(neighbour));
      if (neighbour) {
        await actions.enterProject(await invoke<ProjectSnapshot>("open_project", { path: neighbour.root }));
      } else {
        // Its only project went to another window, so this one has nothing left to show.
        await getCurrentWindow().close();
      }
    })().catch((reason: unknown) => {
      if (movingActive && transferred && !actions.projectRef.current) actions.forgetTransferredProject(false);
      showError(toMessage(reason));
    }).finally(() => {
      if (movingActive && !transferred) actions.cancelProjectTransition();
      actions.setMovingWorkspace(false);
      actions.setBusyLabel(null);
    });
  }).catch((reason: unknown) => showError(toMessage(reason)));
}

/** Answer another window's drop. Every path that doesn't take the project
 * refuses it, so the source stops waiting at once. */
export async function receiveProjectTab(actions: Actions, { id, beforeRoot }: MoveRequest) {
  let transferred = false;
  try {
    await actions.holdWindow(undefined, async () => {
      const active = actions.projectRef.current;
      if (!active || !await confirmLeaving(active, actions.building)) return;
      actions.setBusyLabel(actions.title);
      await (async () => {
        if (!await actions.startProjectTransition(true)) return;
        actions.setMovingWorkspace(true);
        await flushWindowProjectGroup();
        const snapshot = await invoke<ProjectSnapshot | null>("receive_project_tab", { id, activeRoot: active.root });
        if (!snapshot) return;
        transferred = true;
        const entering = actions.enterProject(snapshot);
        windowProjects.reorder(snapshot.root, beforeRoot);
        await entering;
      })().catch((reason: unknown) => showError(toMessage(reason))).finally(() => {
        if (!transferred) actions.cancelProjectTransition();
        actions.setMovingWorkspace(false);
        actions.setBusyLabel(null);
      });
    });
  } finally {
    if (!transferred) await invoke("receive_project_tab", { id, activeRoot: null });
  }
}
