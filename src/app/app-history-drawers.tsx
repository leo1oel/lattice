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
import { lazy, Suspense } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, X } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { SlidingTabs } from "../components/ui/motion";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { LATTICE_RESTORE_AGENT_CHECKPOINT, type AgentGitWorkspaceView } from "../agent/synara-runtime";
import { synaraSourceControlUrl, synaraTurnReviewUrl } from "./app-synara-embed";
import { setError } from "./notify";
import { githubRepositoryUrl } from "./git-repository-url";
import type { useSynaraHost } from "./use-synara-host";
import type { ToolDrawers } from "./use-tool-drawers";
import { confirmAction, toMessage } from "../app-utils";
import { type AppLocale, type Theme } from "../settings/app-settings";
import { type HistoryItem } from "../history/history-drawer";
import type { CompileProject, OpenProjectFile, OverleafLink, ProjectSnapshot, RefreshProject } from "../app-types";

const HistoryDrawer = lazy(() =>
  import("../history/history-drawer").then((module) => ({ default: module.HistoryDrawer })),
);

/** Run a history change once the reader confirms it; a failure becomes an error toast. */
async function afterConfirming(question: string, change: () => Promise<void>) {
  if (!await confirmAction(question)) return;
  try {
    await change();
  } catch (reason) {
    setError(toMessage(reason));
  }
}

export function AppHistoryDrawers({ tools, synara: {
  postMessage, sourceControlFrameRef, origin: synaraOrigin, runtime: synaraRuntime, retry: retrySynaraRuntime,
}, project, activeFile, ...props }: {
  tools: Pick<ToolDrawers, "isOpen" | "close" | "gitView" | "turnReview" | "showGitView">;
  synara: Pick<ReturnType<typeof useSynaraHost>, "postMessage" | "sourceControlFrameRef" | "origin" | "runtime" | "retry">;
  project: ProjectSnapshot;
  activeFile: string;
  appLocale: AppLocale;
  theme: Theme;
  compile: CompileProject;
  gitRemoteUrl: string | null;
  loadFile: (path: string) => Promise<boolean>;
  openProjectFile: OpenProjectFile;
  overleafLink: OverleafLink | null;
  projectHistory: HistoryItem[];
  refreshHistory: () => Promise<void>;
  refreshProject: RefreshProject;
  runOverleafSync: (options?: { auto?: boolean; }) => Promise<void>;
}) {
  const { t } = useLingui();
  const { turnReview: agentTurnReview, gitView: gitWorkspaceView } = tools;
  const repositoryUrl = githubRepositoryUrl(props.gitRemoteUrl);
  const frame = synaraOrigin ? {
    origin: synaraOrigin,
    authToken: synaraRuntime.authToken,
    projectRoot: project.root,
    theme: props.theme,
    locale: props.appLocale,
  } : null;
  /** Bring the project, the open file, history and the PDF up to date after a restore. */
  const reloadAfterRestore = async () => {
    await props.refreshProject();
    if (activeFile) await props.loadFile(activeFile);
    await props.refreshHistory();
    await props.compile();
  };
  return (
    <>
      <Suspense fallback={null}>
      {tools.isOpen.history && (
        <HistoryDrawer
          history={props.projectHistory}
          onClose={() => tools.close("history")}
          onVersionsChanged={reloadAfterRestore}
          onRevert={(item) => {
            if (
              item.kind === "agent-checkpoint"
              && item.threadId
              && typeof item.turnCount === "number"
              && synaraOrigin
            ) {
              void postMessage({ type: LATTICE_RESTORE_AGENT_CHECKPOINT, threadId: item.threadId, turnCount: item.turnCount });
              return;
            }
            void afterConfirming(
              t`Restore the project to the state before this change? The restore will be added as a new history entry.`,
              async () => {
                await invoke("revert_transaction", { transactionId: item.id, projectRoot: project.root });
                await reloadAfterRestore();
              },
            );
          }}
          onRevertFile={(id, path) => afterConfirming(
            t`Restore only “${path}” to the state before this change? The restore will be added as a new history entry.`,
            async () => {
              await invoke("revert_history_file", { transactionId: id, path });
              await reloadAfterRestore();
            },
          )}
          onDelete={(id) => afterConfirming(t`Delete this history entry? This cannot be undone.`, async () => {
            await invoke("delete_history_entry", { transactionId: id });
            await props.refreshHistory();
          })}
          onOpenFile={(path, line) => { void props.openProjectFile(path, { line }); }}
          overleafLinked={props.overleafLink !== null}
          overleafProjectRoot={project.root}
          onOverleafRestored={async () => {
            // The restore happened on Overleaf's server and left the local
            // files alone, so pull it down the same way a manual sync does
            // before anything on this side reloads.
            await props.runOverleafSync();
            await reloadAfterRestore();
          }}
        />
      )}
      </Suspense>
      {tools.isOpen.git && project ? (
        <ResizableDrawer
          className="git-drawer synara-source-control-drawer"
          dataTour="git-panel"
          onClose={() => tools.close("git")}
        >
          <div className="agent-git-workspace-header">
            <SlidingTabs
              value={agentTurnReview ? "agent-turn" : gitWorkspaceView}
              onChange={(value) => {
                if (value === "agent-turn") return;
                tools.showGitView(value as AgentGitWorkspaceView);
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
                onClick={() => tools.close("git")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
            {frame ? (
              <iframe
                ref={sourceControlFrameRef}
                className="synara-source-control-frame"
                src={agentTurnReview
                  ? synaraTurnReviewUrl(frame, agentTurnReview)
                  : synaraSourceControlUrl(frame, gitWorkspaceView)}
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
