/**
 * Settings, with the loading shell that stands in for it while its chunk
 * loads. The dialog itself is one of App's surfaces (app-surfaces.ts); whether
 * it is open, and on which page, is use-settings-window.ts.
 */
import { memo, Suspense, type ComponentType, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { LivePreview } from "../live-preview/use-live-preview";
import { persistOverleafRemoteDelete, persistOverleafSyncMode, type BuildPreferences } from "../settings/app-settings";
import type { SettingsDialogProps } from "../settings/settings-dialog";
import type { useAppearance } from "../settings/use-appearance";
import type { ProjectManifest, ProjectSnapshot, SettingsTab } from "../app-types";
import { showingErrors } from "./notify";
import { SettingsLoadingShell } from "./tool-loading-shell";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { useCommentAuthor } from "./use-comment-author";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { SettingsWindow } from "./use-settings-window";
import type { SynaraHost } from "./use-synara-host";
import type { TexSetup } from "./use-tex-setup";

/**
 * Settings over the welcome screen or a project. Closed, it does not
 * re-render with App: it shows nothing until it opens, as LazyMount does.
 */
export const AppSettingsDialog = memo(function AppSettingsDialog({
  state: { open, late, entry, tab }, Dialog, showTab, close, project, setProject, synara, overleaf, texSetup,
  buildPipeline, author, appearance: { appearance, setAppearance, theme, themePreference, setThemePreference, windowBacking },
  buildPreferences, setBuildPreferences, livePreview,
}: {
  state: Pick<SettingsWindow, "open" | "late" | "entry" | "tab">;
  Dialog: ComponentType<SettingsDialogProps>;
  /** App's stable forwarders for the window's actions. */
  showTab: (tab: SettingsTab) => void;
  close: () => void;
  project: ProjectSnapshot | null;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  synara: Pick<SynaraHost, "runtime" | "retry">;
  overleaf: Pick<
    ReturnType<typeof useOverleafWorkspace>,
    | "overleafSyncMode" | "setOverleafSyncMode" | "overleafRemoteDelete" | "setOverleafRemoteDelete" | "overleafRealtime"
    | "refreshOverleafLink"
  >;
  texSetup: TexSetup;
  buildPipeline: Pick<ReturnType<typeof useBuildPipeline>, "cleanProject" | "cleaning" | "building">;
  author: ReturnType<typeof useCommentAuthor>;
  appearance: ReturnType<typeof useAppearance>;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  livePreview: LivePreview;
}) {
  const { t } = useLingui();
  const { overleafSyncMode, setOverleafSyncMode, setOverleafRemoteDelete, overleafRealtime } = overleaf;
  return (<>
    {late && (
      <SettingsLoadingShell label={t`Settings`} message={t`Loading settings…`} backdrop={!open}
        returnFocus={entry.returnFocus} onClose={close} />
    )}
    <Suspense fallback={null}>
      {open && <Dialog
        covered={late}
        reveal={entry.reveal}
        openOnPage={entry.page}
        synaraRuntime={synara.runtime}
        synaraWorkspaceRoot={project?.root}
        onRetrySynaraRuntime={synara.retry}
        overleafSyncMode={overleafSyncMode}
        overleafRemoteDelete={overleaf.overleafRemoteDelete}
        onOverleafRemoteDeleteChange={(mode) => {
          setOverleafRemoteDelete(mode);
          persistOverleafRemoteDelete(mode);
        }}
        overleafChannel={overleafSyncMode === "live" ? overleafRealtime.status : "off"}
        overleafChannelDetail={overleafRealtime.detail}
        onOverleafLinkChanged={overleaf.refreshOverleafLink}
        onOverleafSyncModeChange={(mode) => {
          setOverleafSyncMode(mode);
          persistOverleafSyncMode(mode);
        }}
        tab={tab}
        setTab={(next) => {
          showTab(next);
          if (next === "doctor") void texSetup.runDoctor();
        }}
        doctorReport={texSetup.doctorReport}
        doctorBusy={texSetup.doctorBusy}
        doctorNotice={texSetup.doctorNotice}
        onRunDoctor={() => { void texSetup.runDoctor(); }}
        onOpenTexSetup={() => void texSetup.openWizard()}
        onCleanProject={() => { void buildPipeline.cleanProject(); }}
        cleaning={buildPipeline.cleaning}
        building={buildPipeline.building}
        authorName={author.setting}
        knownAuthorName={author.knownName}
        onAuthorNameChange={author.changeSetting}
        appearance={appearance}
        setAppearance={setAppearance}
        theme={theme}
        themePreference={themePreference}
        setThemePreference={setThemePreference}
        windowBacking={windowBacking}
        buildPreferences={buildPreferences}
        setBuildPreferences={setBuildPreferences}
        hasProject={Boolean(project)}
        project={project}
        livePreview={livePreview}
        onUpdateManifest={(patch) => showingErrors(async () => {
          const { grammarIgnores } = patch;
          const manifest = patch.spellingWords != null
            ? await invoke<ProjectManifest>("set_project_spelling_words", { words: patch.spellingWords })
            : grammarIgnores
              ? await invoke<ProjectManifest>("set_project_grammar_ignores", grammarIgnores)
              : await invoke<ProjectManifest>("update_project_manifest", patch);
          setProject((current) => current ? { ...current, manifest } : current);
        })}
        returnFocus={entry.returnFocus}
        onClose={close}
      />}
    </Suspense>
  </>);
}, (previous, next) => !previous.state.open && !previous.state.late && !next.state.open && !next.state.late);
