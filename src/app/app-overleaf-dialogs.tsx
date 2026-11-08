/**
 * The Overleaf dialogs App opens over the welcome screen or a project: the
 * project picker (open, clone or publish a project), the review of a manual
 * sync's incoming changes, and the resolver for a file a sync (or an Agent
 * Undo) left with conflict markers.
 */
import { lazy, memo, useEffect, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { forgetAgentUndoConflict, isAgentUndoConflict, subscribeAgentUndoConflicts } from "./agent-undo-conflicts";
import { showWarning } from "./notify";
import { LazyMount } from "../components/lazy-mount";
import type { CompileProject, ProjectSnapshot, RefreshProject } from "../app-types";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { useProjectLifecycle } from "./use-project-lifecycle";

const OverleafPickerDialog = lazy(() =>
  import("../overleaf/overleaf-project-picker").then((module) => ({ default: module.OverleafPickerDialog })),
);
const OverleafReviewDialog = lazy(() =>
  import("../overleaf/overleaf-review").then((module) => ({ default: module.OverleafReviewDialog })),
);
const ConflictResolverDialog = lazy(() =>
  import("../history/conflict-resolver").then((module) => ({ default: module.ConflictResolverDialog })),
);

type OverleafDialogsProps = {
  overleaf: Pick<
    ReturnType<typeof useOverleafWorkspace>,
    | "overleafPickerOpen" | "setOverleafPickerOpen" | "overleafReviewOpen" | "setOverleafReviewOpen" | "conflictPath"
    | "setConflictPath" | "overleafProjectLinked" | "publishProjectToOverleaf" | "refreshOverleafLink" | "runOverleafSync"
    | "setOverleafRemoteChanges"
  >;
  lifecycle: Pick<
    ReturnType<typeof useProjectLifecycle>,
    "startProjectTransition" | "cancelProjectTransition" | "revealNewProject" | "openExistingProject" | "recentProjects"
  >;
  project: ProjectSnapshot | null;
  activeFile: string;
  loadFile: (path: string) => Promise<unknown>;
  refreshProject: RefreshProject;
  compile: CompileProject;
  /** Queues files written outside a save for upload to Overleaf. */
  externalEditsRef: RefObject<(paths: readonly string[]) => void>;
};

const closed = ({ overleaf }: OverleafDialogsProps) => (
  !overleaf.overleafPickerOpen && !overleaf.overleafReviewOpen && overleaf.conflictPath === null
);

/** Closed, it does not re-render with App: none of its dialogs is shown, as LazyMount does for each. */
export const AppOverleafDialogs = memo(function AppOverleafDialogs({
  overleaf, lifecycle, project, activeFile, loadFile, refreshProject, compile, externalEditsRef,
}: OverleafDialogsProps) {
  const { t } = useLingui();
  const { setOverleafPickerOpen, conflictPath, setConflictPath } = overleaf;
  // An Agent Undo that kept newer edits where they overlap the agent's change
  // leaves markers for just those spots; sync holds the file back until then.
  useEffect(() => subscribeAgentUndoConflicts((paths) => {
    const files = paths.join(", ");
    showWarning(t`Undo kept newer edits in ${files} where they overlap the agent's change. Choose what to keep in each marked spot; nothing uploads to Overleaf until then.`, t`Agent`);
    if (paths[0]) setConflictPath(paths[0]);
  }), [setConflictPath, t]);
  return (<>
    <LazyMount when={overleaf.overleafPickerOpen}>
      <OverleafPickerDialog
        open
        onClose={() => setOverleafPickerOpen(false)}
        onBeforeClone={lifecycle.startProjectTransition}
        onCloneCancelled={lifecycle.cancelProjectTransition}
        onCloned={(root) => {
          setOverleafPickerOpen(false);
          void lifecycle.revealNewProject(t`Opening the Overleaf project…`, async () => root);
        }}
        onOpenLocalCopy={(root) => {
          setOverleafPickerOpen(false);
          void lifecycle.openExistingProject(root);
        }}
        knownFolders={lifecycle.recentProjects}
        currentProject={!overleaf.overleafProjectLinked && project ? { name: project.manifest.name } : null}
        onPublish={overleaf.publishProjectToOverleaf}
        onConnectionChanged={overleaf.refreshOverleafLink}
      />
    </LazyMount>
    <LazyMount when={overleaf.overleafReviewOpen}>
      <OverleafReviewDialog
        open
        projectRoot={project?.root ?? null}
        onClose={() => overleaf.setOverleafReviewOpen(false)}
        onApply={async () => {
          await overleaf.runOverleafSync();
          overleaf.setOverleafRemoteChanges(false);
        }}
      />
    </LazyMount>
    <LazyMount when={conflictPath !== null}>
      {conflictPath !== null && (
        <ConflictResolverDialog
          open
          path={conflictPath}
          sides={isAgentUndoConflict(conflictPath) ? "agent-undo" : "overleaf"}
          projectRoot={project?.root ?? ""}
          onClose={() => {
            forgetAgentUndoConflict(conflictPath);
            setConflictPath(null);
          }}
          onResolved={async (path) => {
            // Sync held this file back while it carried markers. Now that it
            // is settled, queue the upload so the choice reaches Overleaf.
            externalEditsRef.current([path]);
            await refreshProject();
            if (activeFile === path) await loadFile(path);
            await compile();
          }}
        />
      )}
    </LazyMount>
  </>);
}, (previous, next) => closed(previous) && closed(next));
