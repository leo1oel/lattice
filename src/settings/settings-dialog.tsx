import { Settings } from "lucide-react";
import { type FormEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ReloadButton } from "../components/ui/activity-icons";
import { ScrollArea } from "../components/ui/scroll-area";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";
import { spring } from "../components/ui/motion-values";
import { PanelHeader } from "../components/ui/panel-header";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { ModalDialog } from "../components/ui/modal-dialog";
import { useUpdater, type UpdaterApi } from "../telemetry/app-updater";
import {
  type Theme,
  type ThemePreference,
  type BuildPreferences,
  type AppearanceSettings,
  type TitlebarTool,
  type OverleafRemoteDelete,
  type OverleafSyncMode,
  resolveAppLocale,
} from "./app-settings";
import type { ProjectSnapshot, SettingsTab } from "../app-types";
import { beginWindowDrag, toggleWindowFullscreen } from "../app-utils";
import { OverleafSettingsSection } from "../overleaf/overleaf-connect";
import { LiteratureSettings } from "./literature-settings";
import { DoctorSettings, type DoctorSettingsProps } from "./doctor-settings";
import { SynaraSettingsPane } from "./synara-settings-pane";
import { SelectRow, SliderRow } from "./settings-controls";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { AppLogsSettings } from "../telemetry/app-log";
import { synaraFrameUrl, type SynaraRuntimeInfo } from "../agent/synara-runtime";

/** The Settings tabs that embed a Synara settings page, and which one. */
const SYNARA_SETTINGS_SECTIONS: Partial<Record<SettingsTab, string>> = { agent: "providers", api: "skills", mcp: "integrations" };

type SettingsDialogProps = DoctorSettingsProps & {
  synaraRuntime: SynaraRuntimeInfo;
  synaraWorkspaceRoot?: string;
  onRetrySynaraRuntime: () => void;
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  overleafSyncMode: OverleafSyncMode;
  overleafRemoteDelete: OverleafRemoteDelete;
  onOverleafRemoteDeleteChange: (mode: OverleafRemoteDelete) => void;
  overleafChannel: "off" | "connecting" | "live" | "error";
  overleafChannelDetail: string | null;
  /** Called when this project stops (or starts) being linked to Overleaf. */
  onOverleafLinkChanged: () => void;
  onOverleafSyncModeChange: (mode: OverleafSyncMode) => void;
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  hasProject: boolean;
  project: ProjectSnapshot | null;
  onUpdateManifest: (patch: { engine?: string | null; trusted?: boolean | null; spellingWords?: string[] | null }) => void;
  onCleanProject: () => void;
  cleaning: boolean;
  building: boolean;
  /** The "Your name" setting, and the Git or Overleaf name that signs comments ahead of it. */
  authorName: string;
  knownAuthorName: string | null;
  onAuthorNameChange: (name: string) => void;
  onClose: () => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  const { t } = useLingui();
  const settingsNavGroups = [
    { label: t`General`, items: [
      { tab: "appearance", label: t`Appearance`, icon: "faders" },
      { tab: "editor", label: t`Editor & builds`, icon: "logs" },
    ] },
    { label: t`Agent`, items: [
      { tab: "agent", label: t`Providers`, icon: "robot" },
      { tab: "mcp", label: t`MCP`, icon: "plugs" },
      { tab: "api", label: t`Skills`, icon: "package" },
    ] },
    { label: t`Integrations`, items: [
      { tab: "overleaf", label: t`Overleaf`, icon: "cloud-upload" },
      { tab: "literature", label: t`Literature services`, icon: "api-key" },
    ] },
    { label: t`Diagnostics`, items: [
      { tab: "doctor", label: t`TeX doctor`, icon: "sparkle" },
      { tab: "logs", label: t`Logs`, icon: "receipt" },
    ] },
  ] as const;
  const settingsNavItems = settingsNavGroups
    .flatMap((group): ReadonlyArray<{ tab: SettingsTab; label: string }> => group.items);
  const settingsViewportRef = useRef<HTMLDivElement>(null);
  const [projectWordDraft, setProjectWordDraft] = useState("");
  const synaraSettingsSection = SYNARA_SETTINGS_SECTIONS[props.tab];
  const synaraEmbedUrl = props.synaraRuntime.state === "ready" ? props.synaraRuntime.origin : null;
  const synaraSettingsUrl = synaraEmbedUrl && props.synaraWorkspaceRoot && synaraSettingsSection
    ? synaraFrameUrl({
      origin: synaraEmbedUrl,
      path: "/settings",
      workspaceRoot: props.synaraWorkspaceRoot,
      theme: props.theme,
      locale: resolveAppLocale(props.appearance.interfaceLanguage),
      surface: "drawer",
      hostOrigin: window.location.origin,
      authToken: props.synaraRuntime.authToken,
      section: synaraSettingsSection,
    })
    : null;

  useLayoutEffect(() => {
    // Every tab shares this viewport. The nested Logs scroller can chain a
    // wheel gesture into it at the end of the log, so each tab change must
    // reset the page viewport without touching the log viewport itself.
    const resetViewport = () => {
      const viewport = settingsViewportRef.current;
      if (!viewport) return;
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
    };
    resetViewport();
    const frame = window.requestAnimationFrame(resetViewport);
    return () => window.cancelAnimationFrame(frame);
  }, [props.tab, synaraSettingsUrl]);

  const panes: Partial<Record<SettingsTab, ReactNode>> = {
    appearance: <AppearanceSettingsPane {...props} />,
    editor: <EditorSettingsPane {...props} projectWordDraft={projectWordDraft} setProjectWordDraft={setProjectWordDraft} />,
    logs: <AppLogsSettings />,
    literature: <LiteratureSettings />,
    overleaf: (
      <OverleafSettingsSection
        projectRoot={props.project?.root ?? null}
        syncMode={props.overleafSyncMode}
        onSyncModeChange={props.onOverleafSyncModeChange}
        remoteDelete={props.overleafRemoteDelete}
        onRemoteDeleteChange={props.onOverleafRemoteDeleteChange}
        channel={props.overleafChannel}
        channelDetail={props.overleafChannelDetail}
        onLinkChanged={props.onOverleafLinkChanged}
      />
    ),
    doctor: <DoctorSettings {...props} />,
  };
  return (
    <ModalDialog
      label={t`Settings`}
      focusDialogOnOpen
      onClose={props.onClose}
      windowDragTop={{ onMouseDown: beginWindowDrag, onDoubleClick: toggleWindowFullscreen }}
    >
      <div className="settings-modal">
        <PanelHeader
          className="settings-header"
          icon={<Settings size={17} />}
          title={t`Settings`}
          closeLabel={t`Close settings`}
          onClose={props.onClose}
          onMouseDown={beginWindowDrag}
          onDoubleClick={toggleWindowFullscreen}
        />
        <div className="settings-body">
          <nav className="settings-nav fluid-hover-surface" aria-label={t`Settings sections`}>
            <FluidHoverSurface selector=".settings-nav-group > button" preserveSelection transition={spring.moderate} />
            {settingsNavGroups.map((group, groupIndex) => (
              <div key={group.label} className="settings-nav-group" role="group" aria-labelledby={`settings-nav-${groupIndex}`}>
                <div className="settings-nav-group-label" id={`settings-nav-${groupIndex}`}>{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.tab}
                    type="button"
                    className={props.tab === item.tab ? "active" : ""}
                    aria-current={props.tab === item.tab ? "page" : undefined}
                    onClick={() => props.setTab(item.tab)}
                  >
                    <AnimatedProductIcon kind={item.icon} size={15} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <ScrollArea className="settings-content" viewportRef={settingsViewportRef} fadeEdges={false}>
            <SynaraSettingsPane
              runtime={props.synaraRuntime}
              section={synaraSettingsSection}
              url={synaraSettingsUrl}
              synaraSettingsLabel={settingsNavItems.find((item) => item.tab === props.tab)?.label}
              viewportRef={settingsViewportRef}
              onRetry={props.onRetrySynaraRuntime}
            />
            {panes[props.tab]}
          </ScrollArea>
        </div>
      </div>
    </ModalDialog>
  );
}

function patchAppearance(props: SettingsDialogProps, patch: Partial<AppearanceSettings>) {
  props.setAppearance({ ...props.appearance, ...patch });
}

/** Which tool buttons sit at the right of the title bar; the commands stay in the palette either way. */
function TitlebarToolsGroup(props: SettingsDialogProps) {
  const { t } = useLingui();
  const hidden = props.appearance.hiddenTitlebarTools;
  const tools: Array<{ tool: TitlebarTool; label: string }> = [
    { tool: "comments", label: t`Editor comments` },
    { tool: "overleaf", label: t`Overleaf` },
    { tool: "git", label: t`Git status and commit` },
    { tool: "history", label: t`Project history` },
    { tool: "browser", label: t`Open in browser` },
  ];
  return (
    <SettingsGroup title={t`Title bar tools`}>
      {tools.map(({ tool, label }) => (
        <SwitchField
          key={tool}
          label={label}
          checked={!hidden.includes(tool)}
          onChange={(shown) => patchAppearance(props, {
            hiddenTitlebarTools: shown ? hidden.filter((item) => item !== tool) : [...hidden, tool],
          })}
        />
      ))}
    </SettingsGroup>
  );
}

function AppearanceSettingsPane(props: SettingsDialogProps) {
  const { t } = useLingui();

  return (
    <div className="settings-section">
      <SettingsSectionHeader title={t`Appearance`} />
      <SettingsGroup title={t`General`}>
        <SelectRow
          label={t`Interface language`}
          value={props.appearance.interfaceLanguage}
          options={{ system: t`Follow system (default)`, en: t`English`, "zh-CN": t`Simplified Chinese` }}
          onChange={(interfaceLanguage) => patchAppearance(props, { interfaceLanguage })}
        />
        <SelectRow
          label={t`Color theme`}
          value={props.themePreference}
          options={{ system: t`Follow system (default)`, light: t`Light`, dark: t`Dark` }}
          onChange={props.setThemePreference}
        />
        <SliderRow
          id="editor-font-size"
          label={t`Editor font size`}
          description={t`Source editor only`}
          min={10}
          max={24}
          value={props.appearance.editorFontSize}
          unit="px"
          onChange={(editorFontSize) => patchAppearance(props, { editorFontSize })}
        />
        <SwitchField
          label={t`Interface sounds`}
          description={t`When a build or Overleaf setup finishes`}
          checked={props.appearance.interfaceSounds}
          onChange={(interfaceSounds) => patchAppearance(props, { interfaceSounds })}
        />
      </SettingsGroup>
      <TitlebarToolsGroup {...props} />
    </div>
  );
}

/** What the updater has to report, if anything. The mode's own option label already says how updates arrive. */
function useUpdateStatus(updater: UpdaterApi): { title: string | undefined; detail: string | undefined } {
  const { t } = useLingui();
  const phaseTitles: Partial<Record<UpdaterApi["phase"], string>> = {
    available: t`Version ${updater.version ?? ""} is ready to install`,
    downloading: t`Downloading update…`,
    installing: t`Installing update…`,
    // `errorKind` distinguishes the two failures that both land on phase
    // "error": a check that never reached the release feed, and a
    // download/install that started and then failed. Reporting one as the
    // other sent people looking in the wrong place.
    error: updater.errorKind === "install" ? t`Couldn’t install the update` : t`Couldn’t check for updates`,
    "up-to-date": t`You’re on the latest version`,
  };
  return {
    title: phaseTitles[updater.phase],
    detail: updater.phase === "error" ? (updater.error ?? t`Check your connection and try again`) : undefined,
  };
}

function EditorSettingsPane({ projectWordDraft, setProjectWordDraft, ...props }: SettingsDialogProps & {
  projectWordDraft: string;
  setProjectWordDraft: (draft: string) => void;
}) {
  const { t } = useLingui();
  const updater = useUpdater();
  const updateStatus = useUpdateStatus(updater);
  const projectSpellingWords = props.project?.manifest.spellingWords ?? [];
  const updateBusy = ["checking", "downloading", "installing"].includes(updater.phase);
  const addProjectSpellingWord = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const word = projectWordDraft.trim();
    if (!word || !props.project) return;
    if (!projectSpellingWords.some((existing) => existing.toLocaleLowerCase() === word.toLocaleLowerCase())) {
      props.onUpdateManifest({ spellingWords: [...projectSpellingWords, word] });
    }
    setProjectWordDraft("");
  };

  return (
    <div className="settings-section">
      <SettingsSectionHeader title={t`Editor & builds`} />
      <SettingsGroup title={t`Editor`}>
        <SelectRow
          label={t`Editor keymap`}
          value={props.appearance.editorKeymap}
          options={{ default: t`Default`, vim: "Vim", emacs: "Emacs" }}
          onChange={(editorKeymap) => patchAppearance(props, { editorKeymap })}
        />
        <SettingsRow
          label={t`Your name`}
          description={props.knownAuthorName
            ? t`Comments are signed ${props.knownAuthorName}, from Git or Overleaf`
            : t`Signs your comments when Git and Overleaf have no name`}
        >
          <Input
            controlSize="form"
            aria-label={t`Your name`}
            placeholder={props.knownAuthorName ?? t`Anonymous`}
            value={props.authorName}
            onChange={(event) => props.onAuthorNameChange(event.target.value)}
          />
        </SettingsRow>
        <SwitchField
          label={t`Check spelling in prose`}
          description={t`English, with Harper`}
          checked={props.appearance.editorSpellcheck}
          onChange={(editorSpellcheck) => patchAppearance(props, { editorSpellcheck })}
        />
        <SettingsRow
          className="settings-project-dictionary-row"
          label={t`Project dictionary`}
          description={props.project
            ? t`Terms Harper should accept in this project`
            : t`Open a project to add terms`}
        >
          <div className="settings-project-dictionary">
            <form className="settings-project-dictionary-form" onSubmit={addProjectSpellingWord}>
              <Input
                controlSize="form"
                aria-label={t`Add project term`}
                placeholder={t`e.g. Lattice`}
                value={projectWordDraft}
                disabled={!props.project}
                onChange={(event) => setProjectWordDraft(event.target.value)}
              />
              <Button size="form" type="submit" disabled={!props.project || !projectWordDraft.trim()}>{t`Add`}</Button>
            </form>
            {projectSpellingWords.length > 0 ? (
              <div className="settings-project-dictionary-terms" role="list" aria-label={t`Project dictionary terms`}>
                {projectSpellingWords.map((word) => (
                  <span className="settings-project-dictionary-term" role="listitem" key={word}>
                    <span>{word}</span>
                    <button
                      type="button"
                      className="settings-project-dictionary-remove"
                      aria-label={t`Remove ${word} from project dictionary`}
                      onClick={() => props.onUpdateManifest({
                        spellingWords: projectSpellingWords.filter((existing) => existing !== word),
                      })}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="settings-project-dictionary-empty">{t`No project terms added`}</p>
            )}
          </div>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t`Builds`}>
        <SelectRow
          label={t`Automatic build`}
          description={props.buildPreferences.autoBuildMode === "automatic"
            ? t`Builds 1.2 s after you stop typing`
            : t`Build with ⌘S. Edits still save on their own`}
          value={props.buildPreferences.autoBuildMode}
          options={{ manual: t`Manual only`, automatic: t`Automatic` }}
          onChange={(autoBuildMode) => props.setBuildPreferences({ autoBuildMode })}
        />
        <SettingsRow label={t`Auxiliary files`} description={t`Removes .aux, .log and other build files`}>
          <Button size="compact" disabled={!props.hasProject || props.cleaning || props.building} onClick={props.onCleanProject}>
            {props.cleaning ? t`Cleaning…` : t`Clean`}
          </Button>
        </SettingsRow>
        {props.project && (
          <>
            <SelectRow
              label={t`Compile engine`}
              description={t`A project latexmkrc overrides this`}
              value={props.project.manifest.engine ?? "pdf"}
              options={{ pdf: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" }}
              onChange={(engine) => props.onUpdateManifest({ engine })}
            />
            <SwitchField
              label={t`Allow external commands`}
              description={t`Shell escape during builds`}
              checked={props.project.manifest.trusted}
              onChange={(trusted) => props.onUpdateManifest({ trusted })}
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title={t`App updates`}>
        <SelectRow
          label={t`Automatic updates`}
          description={updateStatus.detail}
          value={updater.mode}
          options={{ manual: t`Notify me (manual)`, auto: t`Install automatically` }}
          onChange={updater.setMode}
        />
        <SettingsRow label={t`Version`} description={updateStatus.title}>
          <ReloadButton size="compact" busy={updateBusy} disabled={updateBusy} onClick={() => void updater.check(false)}>
            {updater.phase === "checking" ? t`Checking…` : t`Check for updates`}
          </ReloadButton>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
