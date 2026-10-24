/**
 * Settings: whether it is open, on which page and how it was opened, and the
 * dialog with the loading shell that stands in for it while its chunk loads.
 * The dialog itself is one of App's surfaces (app-surfaces.ts).
 */
import { memo, Suspense, useState, useTransition, type ComponentType, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { LivePreview } from "../live-preview/use-live-preview";
import {
  isSynaraSettingsTab, loadSettingsTab, persistOverleafRemoteDelete, persistOverleafSyncMode, persistSettingsTab,
  type BuildPreferences,
} from "../settings/app-settings";
import type { SettingsDialogProps } from "../settings/settings-dialog";
import type { SettingsSearchEntry } from "../settings/settings-search-index";
import type { useAppearance } from "../settings/use-appearance";
import type { ProjectManifest, ProjectSnapshot, SettingsTab } from "../app-types";
import { showingErrors } from "./notify";
import { SettingsLoadingShell } from "./tool-loading-shell";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { useCommentAuthor } from "./use-comment-author";
import { useLoadingShell } from "./use-loading-shell";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { SynaraHost } from "./use-synara-host";
import type { TexSetup } from "./use-tex-setup";

/**
 * Whether Settings is open and on which page. The actions are bodies for
 * App's stable handler map, whose forwarders give them the identity effects
 * and memoized panels rely on.
 */
export function useSettingsWindow(requestSynaraRuntime: () => void) {
  // Where Settings returns focus if not to what held it as Settings opened
  // (the project menu's trigger, when Settings is opened from that menu), the
  // row it opens on when the palette found one, and whether a section was
  // asked for: one state, as each hook is paid on every App render.
  const [entry, setEntry] = useState<{ returnFocus: HTMLElement | null; reveal: SettingsSearchEntry | null; page: boolean }>(
    { returnFocus: null, reveal: null, page: false },
  );
  const [open, setOpen] = useState(false);
  // Opening Settings is a transition for the reason opening a lazy tool
  // drawer is (`useToolDrawers`), with the same loading shell.
  const [opening, startOpen] = useTransition();
  const late = useLoadingShell(opening, opening || open);
  const [tab, setTab] = useState<SettingsTab>(loadSettingsTab);
  const showTab = (next: SettingsTab) => {
    if (isSynaraSettingsTab(next)) requestSynaraRuntime();
    setTab(next);
    persistSettingsTab(next);
  };
  return {
    open, late, entry, tab, showTab,
    /** Opens on `tab`, or without one on the page Settings was last left on; on `reveal`'s row, if given. */
    openSettings: (requested?: SettingsTab, returnFocus: HTMLElement | null = null, reveal: SettingsSearchEntry | null = null) => {
      showTab(requested ?? loadSettingsTab());
      setEntry({ returnFocus, reveal, page: requested !== undefined || reveal !== null });
      startOpen(() => setOpen(true));
    },
    // An urgent update after the opening transition's: it also withdraws a
    // pending open, so a Settings closed from its loading shell stays closed.
    close: () => {
      setOpen(false);
      setEntry({ returnFocus: null, reveal: null, page: false });
    },
    /** The agent's provider settings, as the agent panel asks for them. */
    openProviderSettings: () => {
      setTab("agent");
      setEntry({ returnFocus: null, reveal: null, page: true });
      startOpen(() => setOpen(true));
    },
  };
}

type SettingsWindow = ReturnType<typeof useSettingsWindow>;

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
          const manifest = patch.spellingWords != null
            ? await invoke<ProjectManifest>("set_project_spelling_words", { words: patch.spellingWords })
            : await invoke<ProjectManifest>("update_project_manifest", patch);
          setProject((current) => current ? { ...current, manifest } : current);
        })}
        returnFocus={entry.returnFocus}
        onClose={close}
      />}
    </Suspense>
  </>);
}, (previous, next) => !previous.state.open && !previous.state.late && !next.state.open && !next.state.late);
