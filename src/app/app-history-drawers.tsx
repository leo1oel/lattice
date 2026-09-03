/**
 * The two "what changed" drawers: the project history (Lattice's own
 * transaction log, plus Overleaf restores and agent checkpoints) and the Git
 * workspace the agent's source control embed renders.
 *
 * They share the Synara embed plumbing — restoring an agent checkpoint from a
 * history row posts into the same iframe the Git drawer hosts — which is why
 * they are one component rather than two.
 *
 * The history drawer is the only lazy one, so the `Suspense` sits around it
 * alone: a `null` fallback shared with the Git drawer would unmount an open
 * Git workspace while the history chunk loads.
 */
import { lazy, Suspense, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, X } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { SlidingTabs } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import {
  LATTICE_RESTORE_AGENT_CHECKPOINT,
  type AgentGitWorkspaceView,
  type SynaraRuntimeInfo,
} from "../agent/synara-runtime";
import {
  synaraSourceControlUrl,
  synaraTurnReviewUrl,
  type AgentTurnReview,
} from "./app-synara-embed";
import { setError } from "./notify";
import { githubRepositoryUrl } from "./git-repository-url";
import { confirmAction, toMessage } from "../app-utils";
import { type AppLocale, type Theme } from "../settings/app-settings";
import { type HistoryItem } from "../history/history-drawer";
import type { CollabProjectControllerV2 } from "../collab/collab-project-v2";
import type {
  EditorPaneId,
  OverleafLink,
  ProjectSnapshot,
} from "../app-types";

const HistoryDrawer = lazy(() =>
  import("../history/history-drawer").then((module) => ({ default: module.HistoryDrawer })),
);

export type AppHistoryDrawersProps = {
  activeFile: string;
  agentTurnReview: AgentTurnReview | null;
  appLocale: AppLocale;
  compile: (force?: boolean, sound?: boolean, options?: { consumeAgentAssociations?: boolean; }) => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  gitOpen: boolean;
  gitRemoteUrl: string | null;
  gitWorkspaceView: AgentGitWorkspaceView;
  historyOpen: boolean;
  loadFile: (path: string, options?: { restoreView?: boolean; revealSource?: boolean; expectedProjectRoot?: string; projectGeneration?: number; collabController?: CollabProjectControllerV2; gate?: Promise<boolean>; loadGeneration?: number; canCommit?: () => boolean; navigateToLine?: number; }) => Promise<boolean>;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
  overleafLink: OverleafLink | null;
  project: ProjectSnapshot;
  projectHistory: HistoryItem[];
  refreshHistory: () => Promise<void>;
  refreshProject: (scope?: { expectedRoot: string; generation: number; }) => Promise<ProjectSnapshot>;
  retrySynaraRuntime: () => void;
  revert: (id: string) => Promise<void>;
  runOverleafSync: (options?: { auto?: boolean; }) => Promise<void>;
  setAgentTurnReview: Dispatch<SetStateAction<AgentTurnReview | null>>;
  setGitOpen: Dispatch<SetStateAction<boolean>>;
  setGitWorkspaceView: Dispatch<SetStateAction<AgentGitWorkspaceView>>;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  synaraIframeRef: RefObject<HTMLIFrameElement | null>;
  synaraOrigin: string | null;
  synaraRuntime: SynaraRuntimeInfo;
  synaraSourceControlFrameRef: RefObject<HTMLIFrameElement | null>;
  theme: Theme;
};

export function AppHistoryDrawers(props: AppHistoryDrawersProps) {
  const { t } = useLingui();
  const {
    activeFile,
    agentTurnReview,
    appLocale,
    compile,
    deleteHistory,
    gitOpen,
    gitRemoteUrl,
    gitWorkspaceView,
    historyOpen,
    loadFile,
    openProjectFile,
    overleafLink,
    project,
    projectHistory,
    refreshHistory,
    refreshProject,
    retrySynaraRuntime,
    revert,
    runOverleafSync,
    setAgentTurnReview,
    setGitOpen,
    setGitWorkspaceView,
    setHistoryOpen,
    synaraIframeRef,
    synaraOrigin,
    synaraRuntime,
    synaraSourceControlFrameRef,
    theme,
  } = props;
  const repositoryUrl = githubRepositoryUrl(gitRemoteUrl);
  return (
    <>
      <Suspense fallback={null}>
      {historyOpen && (
        <HistoryDrawer
          history={projectHistory}
          onClose={() => setHistoryOpen(false)}
          onVersionsChanged={async () => {
            await refreshProject();
            if (activeFile) await loadFile(activeFile);
            await refreshHistory();
            await compile();
          }}
          onRevert={(item) => {
            if (
              item.kind === "agent-checkpoint"
              && item.threadId
              && typeof item.turnCount === "number"
              && synaraOrigin
            ) {
              synaraIframeRef.current?.contentWindow?.postMessage(
                {
                  type: LATTICE_RESTORE_AGENT_CHECKPOINT,
                  threadId: item.threadId,
                  turnCount: item.turnCount,
                },
                synaraOrigin,
              );
              return;
            }
            void revert(item.id);
          }}
          onRevertFile={async (id, path) => {
            if (!await confirmAction(
              `Restore only “${path}” to the state before this change? The restore will be added as a new history entry.`,
            )) return;
            try {
              await invoke("revert_history_file", { transactionId: id, path });
              if (activeFile === path || activeFile) await loadFile(activeFile);
              await refreshProject();
              await refreshHistory();
              await compile();
            } catch (reason) {
              setError(toMessage(reason));
            }
          }}
          onDelete={deleteHistory}
          onOpenFile={(path, line) => { void openProjectFile(path, line); }}
          overleafLinked={overleafLink !== null}
          overleafProjectRoot={project.root}
          onOverleafRestored={async () => {
            // The restore happened on Overleaf's server and left the local
            // files alone, so pull it down the same way a manual sync does
            // before anything on this side reloads.
            await runOverleafSync();
            await refreshProject();
            if (activeFile) await loadFile(activeFile);
            await refreshHistory();
            await compile();
          }}
        />
      )}
      </Suspense>
      {gitOpen && project ? (
        <ResizableDrawer
          className="git-drawer synara-source-control-drawer"
          dataTour="git-panel"
          onClose={() => setGitOpen(false)}
        >
          <div className="agent-git-workspace-header">
            <SlidingTabs
              value={agentTurnReview ? "agent-turn" : gitWorkspaceView}
              onChange={(value) => {
                if (value === "agent-turn") return;
                setAgentTurnReview(null);
                setGitWorkspaceView(value as AgentGitWorkspaceView);
              }}
              ariaLabel={t`Git workspace`}
              variant="none"
              className="agent-git-workspace-tabs drawer-view-tabs"
              tabClassName="drawer-view-tab"
              items={[
                ...(agentTurnReview ? [{ value: "agent-turn", label: t`Agent turn` }] : []),
                { value: "changes", label: t`Changes` },
                { value: "pull-requests", label: t`Pull requests` },
              ]}
            />
            <div className="agent-git-workspace-actions">
              {repositoryUrl ? (
                <Tip label={t`Open this repository on GitHub`}>
                  <button
                    type="button"
                    className="agent-git-workspace-repository"
                    onClick={() => {
                      void openUrl(repositoryUrl).catch((reason) => setError(toMessage(reason)));
                    }}
                  >
                    <span>GitHub</span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </button>
                </Tip>
              ) : null}
              <button
                type="button"
                className="agent-git-workspace-close"
                aria-label={t`Close Git workspace`}
                onClick={() => setGitOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
            {synaraOrigin ? (
              <iframe
                ref={synaraSourceControlFrameRef}
                className="synara-source-control-frame"
                src={agentTurnReview
                  ? synaraTurnReviewUrl(
                    synaraOrigin,
                    synaraRuntime.authToken,
                    project.root,
                    theme,
                    appLocale,
                    agentTurnReview,
                  )
                  : synaraSourceControlUrl(
                    synaraOrigin,
                    synaraRuntime.authToken,
                    project.root,
                    theme,
                    appLocale,
                    gitWorkspaceView,
                  )}
                title={agentTurnReview
                  ? t`Agent turn review`
                  : gitWorkspaceView === "changes" ? t`Changes` : t`Pull requests`}
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
              />
            ) : (
              <SynaraLoadingSurface runtime={synaraRuntime} onRetry={retrySynaraRuntime} />
            )}
        </ResizableDrawer>
      ) : null}
    </>
  );
}
