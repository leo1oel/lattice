import { useEffect } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { useLatestRef } from "../hooks/use-latest-ref";
import { chunk } from "../lib/lazy-chunk";
import { disposeWhenSettled } from "./effect-helpers";
import { showError } from "./notify";
import { listenInThisWindow } from "./window-events";

export type ProjectTabDestination = { windowLabel: string; beforeRoot: string | null };
export type MoveRequest = { id: string; beforeRoot: string | null };

const REQUEST_EVENT = "project-tab-move-request";
const loadMoves = chunk(() => import("./project-tab-moves"));

export type TransferDeps = {
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

/** The source keeps its editor and tab until the desktop host accepts the move.
 * Only the request listener runs at startup; both ends of a move load with
 * project-tab-moves.ts the first time one happens. */
export function useProjectTabTransfer(deps: TransferDeps) {
  const { t } = useLingui();
  const title = t`Moving project tab…`;
  const latest = useLatestRef({ ...deps, title });

  const moveProjectTab = async (root: string, target: ProjectTabDestination | null) => {
    if (latest.current.browserHosted) return;
    try {
      const { moveProjectTabFrom } = await loadMoves();
      await moveProjectTabFrom(latest.current, root, target);
    } catch (reason) {
      showError(toMessage(reason));
    }
  };

  useEffect(() => {
    if (deps.browserHosted) return;
    const respond = async (request: MoveRequest) => {
      const moves = await loadMoves().catch(async (reason: unknown) => {
        // Refuse rather than leave the source waiting on an answer.
        await invoke("receive_project_tab", { id: request.id, activeRoot: null });
        throw reason;
      });
      await moves.receiveProjectTab(latest.current, request);
    };
    return disposeWhenSettled(listenInThisWindow<MoveRequest>(REQUEST_EVENT, ({ payload }) => {
      void respond(payload).catch((reason: unknown) => showError(toMessage(reason)));
    }));
  }, [deps.browserHosted, latest]);

  return moveProjectTab;
}
