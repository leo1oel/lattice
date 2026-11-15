import { useCallback, useEffect } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { disposeWhenSettled } from "./effect-helpers";
import { showError } from "./notify";
import { listenInThisWindow } from "./window-events";
import { windowProjects } from "./window-projects";

export type ProjectTabDestination = { windowLabel: string; beforeRoot: string | null };
type MoveRequest = { id: string; beforeRoot: string | null };

const REQUEST_EVENT = "project-tab-move-request";
const confirmLeaving = (project: ProjectSnapshot, building: boolean) => (
  import("./leave-project").then(({ confirmLeavingProject }) => confirmLeavingProject(project.manifest.name, building))
);

type TransferDeps = {
  browserHosted: boolean;
  building: boolean;
  projectRef: { current: ProjectSnapshot | null };
  holdWindow: <T>(refused: T, task: () => Promise<T>) => Promise<T>;
  startProjectTransition: () => Promise<boolean>;
  cancelProjectTransition: () => void;
  enterProject: (snapshot: ProjectSnapshot) => Promise<void>;
  forgetTransferredProject: () => void;
  setMovingWorkspace: (moving: boolean) => void;
  setBusyLabel: (label: string | null) => void;
};

/** The source keeps its editor and tab until the desktop host accepts the move. */
export function useProjectTabTransfer(deps: TransferDeps) {
  const { t } = useLingui();
  const title = t`Moving project tab…`;
  const latest = useLatestRef({ ...deps, title });

  const moveProjectTab = useCallback(async (root: string, target: ProjectTabDestination | null) => {
    const actions = latest.current;
    if (actions.browserHosted) return;
    await actions.holdWindow(undefined, async () => {
      const active = actions.projectRef.current;
      const tabs = windowProjects.get();
      const index = tabs.findIndex((tab) => tab.root === root);
      if (!active || index < 0 || (!target && tabs.length < 2)) return;
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
        transferred = await invoke<boolean>("move_project_tab", {
          id: crypto.randomUUID(), root, sourceRoot: active.root, target,
        });
        if (!transferred) return;
        windowProjects.remove(root);
        if (!movingActive) return;
        actions.forgetTransferredProject();
        if (neighbour) {
          await actions.enterProject(await invoke<ProjectSnapshot>("open_project", { path: neighbour.root }));
        } else {
          await getCurrentWindow().close();
        }
      })().catch((reason: unknown) => showError(toMessage(reason))).finally(() => {
        if (movingActive && !transferred) actions.cancelProjectTransition();
        actions.setMovingWorkspace(false);
        actions.setBusyLabel(null);
      });
    }).catch((reason: unknown) => showError(toMessage(reason)));
  }, [latest]);

  useEffect(() => {
    if (deps.browserHosted) return;
    const respond = async ({ id, beforeRoot }: MoveRequest) => {
      const actions = latest.current;
      let transferred = false;
      await actions.holdWindow(undefined, async () => {
        const active = actions.projectRef.current;
        if (!active || !await confirmLeaving(active, actions.building)) return;
        actions.setBusyLabel(actions.title);
        await (async () => {
          if (!await actions.startProjectTransition()) return;
          actions.setMovingWorkspace(true);
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
      if (!transferred) await invoke("receive_project_tab", { id, activeRoot: null });
    };
    return disposeWhenSettled(listenInThisWindow<MoveRequest>(REQUEST_EVENT, ({ payload }) => {
      void respond(payload).catch((reason: unknown) => showError(toMessage(reason)));
    }));
  }, [deps.browserHosted, latest]);

  return moveProjectTab;
}
