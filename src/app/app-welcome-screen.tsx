/**
 * The welcome screen as App shows it without a project: the lifecycle's
 * recent projects and ways in, and the dialogs App owns (Settings, LaTeX
 * tools, Overleaf).
 */
import { Welcome } from "../project/project-dialogs";
import type { useProjectLifecycle } from "./use-project-lifecycle";

export function AppWelcomeScreen({ lifecycle, onSettings, onInstallTex, onOpenOverleaf }: {
  lifecycle: Pick<
    ReturnType<typeof useProjectLifecycle>,
    | "busyLabel" | "createForm" | "updateCreateForm" | "createProject" | "chooseExisting" | "importOverleafZip" | "clone"
    | "openTutorialProject" | "recentProjects" | "unopenedProject" | "chooseRecentProject" | "recentFinder"
  >;
  onSettings: () => void;
  onInstallTex: () => void;
  onOpenOverleaf: () => void;
}) {
  const { createForm, updateCreateForm } = lifecycle;
  return (
    <Welcome
      busyLabel={lifecycle.busyLabel}
      createOpen={createForm.open}
      createError={createForm.error}
      projectName={createForm.name}
      projectVenue={createForm.venue}
      onOpenCreate={() => updateCreateForm({ open: true })}
      onCloseCreate={() => updateCreateForm({ open: false })}
      setProjectName={(name) => updateCreateForm({ name })}
      setProjectVenue={(venue) => updateCreateForm({ venue })}
      onCreate={lifecycle.createProject}
      onOpen={lifecycle.chooseExisting}
      onImportZip={lifecycle.importOverleafZip}
      onClone={lifecycle.clone.show}
      onOpenTutorial={lifecycle.openTutorialProject}
      recentProjects={lifecycle.recentProjects}
      unopenedProject={lifecycle.unopenedProject}
      onRecent={lifecycle.chooseRecentProject}
      onShowAllRecent={lifecycle.recentFinder.show}
      onSettings={onSettings}
      onInstallTex={onInstallTex}
      onOpenOverleaf={onOpenOverleaf}
    />
  );
}
