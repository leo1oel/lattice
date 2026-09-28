import { Settings } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ReloadButton } from "../components/ui/activity-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";
import { spring } from "../components/ui/motion-values";
import { PanelHeader } from "../components/ui/panel-header";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { useUpdater, type UpdaterApi, type UpdateMode } from "../telemetry/app-updater";
import {
  MAX_OPEN_TABS,
  type Theme,
  type ThemePreference,
  type InterfaceLanguage,
  type AutoBuildMode,
  type BuildPreferences,
  type AppearanceSettings,
  type OverleafRemoteDelete,
  type OverleafSyncMode,
  resolveAppLocale,
} from "./app-settings";
import type { ProjectSnapshot, SettingsTab, DoctorReport } from "../app-types";
import { beginWindowDrag, toggleWindowFullscreen, toMessage } from "../app-utils";
import { OverleafSettingsSection } from "../overleaf/overleaf-connect";
import { LiteratureSettings } from "./literature-settings";
import { DoctorSettings } from "./doctor-settings";
import { SynaraSettingsPane } from "./synara-settings-pane";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { AppLogsSettings } from "../telemetry/app-log";
import { synaraFrameUrl, type SynaraRuntimeInfo } from "../agent/synara-runtime";
import type { LocalSemanticSearchStatus } from "../project/project-semantic-search";

/** The Settings tabs that embed a Synara settings page, and which one. */
const SYNARA_SETTINGS_SECTIONS: Partial<Record<SettingsTab, string>> = {
  agent: "providers",
  api: "skills",
  mcp: "integrations",
};

type SettingsDialogProps = {
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
  localSemanticSearchEnabled: boolean;
  localSemanticSearchStatus: LocalSemanticSearchStatus;
  onLocalSemanticSearchEnabledChange: (enabled: boolean) => void;
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  hasProject: boolean;
  project: ProjectSnapshot | null;
  onUpdateManifest: (patch: {
    engine?: string | null;
    trusted?: boolean | null;
    spellingWords?: string[] | null;
  }) => void;
  doctorReport: DoctorReport | null;
  doctorBusy: boolean;
  doctorNotice: string;
  onRunDoctor: () => void;
  onOpenTexSetup: () => void;
  onCleanProject: () => void;
  cleaning: boolean;
  building: boolean;
  browserHosted: boolean;
  bundledChromium: boolean;
  onOpenInBrowser: () => Promise<void>;
  onReturnToDesktop: () => Promise<void>;
  onClose: () => void;
};

export function SettingsDialog(props: SettingsDialogProps) {
  const { t } = useLingui();
  const settingsNavGroups = [
    {
      label: t`General`,
      items: [
        { tab: "appearance", label: t`Appearance`, icon: "faders" },
        { tab: "editor", label: t`Editor & builds`, icon: "logs" },
      ],
    },
    {
      label: t`Agent`,
      items: [
        { tab: "agent", label: t`Providers`, icon: "robot" },
        { tab: "mcp", label: t`MCP`, icon: "plugs" },
        { tab: "api", label: t`Skills`, icon: "package" },
      ],
    },
    {
      label: t`Integrations`,
      items: [
        { tab: "overleaf", label: t`Overleaf`, icon: "cloud-upload" },
        { tab: "literature", label: t`Literature services`, icon: "api-key" },
      ],
    },
    {
      label: t`Diagnostics`,
      items: [
        { tab: "doctor", label: t`TeX doctor`, icon: "sparkle" },
        { tab: "logs", label: t`Logs`, icon: "receipt" },
      ],
    },
  ] as const;
  const settingsNavItems = settingsNavGroups
    .flatMap((group): ReadonlyArray<{ tab: SettingsTab; label: string }> => group.items);
  const settingsViewportRef = useRef<HTMLDivElement>(null);
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
    editor: <EditorSettingsPane {...props} />,
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
      windowDragTop={{
        onMouseDown: beginWindowDrag,
        onDoubleClick: toggleWindowFullscreen,
      }}
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
            <FluidHoverSurface
              selector=".settings-nav-group > button"
              preserveSelection
              transition={spring.moderate}
            />
            {settingsNavGroups.map((group, groupIndex) => (
              <div
                key={group.label}
                className="settings-nav-group"
                role="group"
                aria-labelledby={`settings-nav-${groupIndex}`}
              >
                <div
                  className="settings-nav-group-label"
                  id={`settings-nav-${groupIndex}`}
                >
                  {group.label}
                </div>
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
          <ScrollArea
            className="settings-content"
            viewportRef={settingsViewportRef}
            fadeEdges={false}
          >
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

function SliderRow(props: {
  id: string;
  label: string;
  description: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <SettingsRow htmlFor={props.id} label={props.label} description={props.description}>
      <div className="settings-row-slider">
        <input
          id={props.id}
          type="range"
          min={props.min}
          max={props.max}
          step="1"
          value={props.value}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        <output htmlFor={props.id}>{props.value}{props.unit}</output>
      </div>
    </SettingsRow>
  );
}

function AppearanceSettingsPane(props: SettingsDialogProps) {
  const { t } = useLingui();
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserOpenError, setBrowserOpenError] = useState("");
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState(false);
  const [browserAccessLoading, setBrowserAccessLoading] = useState(true);
  const browserOutsideChromium = props.browserHosted && !props.bundledChromium;

  useEffect(() => {
    let active = true;
    void invoke<boolean>("browser_access_enabled")
      .then((enabled) => {
        if (active) setBrowserAccessEnabled(enabled);
      })
      .catch((reason) => {
        if (active) setBrowserOpenError(toMessage(reason));
      })
      .finally(() => {
        if (active) setBrowserAccessLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateBrowserAccess = async (enabled: boolean) => {
    if (browserAccessLoading) return;
    setBrowserAccessLoading(true);
    setBrowserOpenError("");
    await invoke("set_browser_access_enabled", { enabled }).then(
      () => setBrowserAccessEnabled(enabled),
      (reason) => setBrowserOpenError(toMessage(reason)),
    );
    setBrowserAccessLoading(false);
  };
  // Outside the bundled Chromium the workspace can only go back to the desktop
  // app; everywhere else it can move out to the default browser.
  const moveWorkspace = async () => {
    if (browserOpening) return;
    setBrowserOpening(true);
    setBrowserOpenError("");
    await (browserOutsideChromium ? props.onReturnToDesktop : props.onOpenInBrowser)().catch((reason) => {
      setBrowserOpenError(toMessage(reason));
      setBrowserOpening(false);
    });
  };
  const moveLabel = browserOutsideChromium ? t`Open desktop app` : t`Open in browser`;

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title={t`Appearance`}
        description={t`These preferences apply across every project on this Mac`}
      />
      <SettingsGroup title={t`Language`}>
        <SettingsRow
          label={t`Interface language`}
          description={t`Choose the language used for menus, settings, and help text`}
        >
          <Select
            value={props.appearance.interfaceLanguage}
            onValueChange={(value) => patchAppearance(props, { interfaceLanguage: value as InterfaceLanguage })}
          >
            <SelectTrigger size="form" aria-label={t`Interface language`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="system">{t`Follow system (default)`}</SelectItem>
              <SelectItem value="en">{t`English`}</SelectItem>
              <SelectItem value="zh-CN">{t`Simplified Chinese`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t`Theme`}>
        <SettingsRow
          label={t`Color theme`}
          description={t`Choose the theme for Lattice on this device`}
        >
          <Select
            value={props.themePreference}
            onValueChange={(value) => props.setThemePreference(value as ThemePreference)}
          >
            <SelectTrigger size="form" aria-label={t`Color theme`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="system">{t`Follow system (default)`}</SelectItem>
              <SelectItem value="light">{t`Light`}</SelectItem>
              <SelectItem value="dark">{t`Dark`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t`Display`}>
        <SliderRow
          id="editor-font-size"
          label={t`Editor font size`}
          description={t`Applies to the LaTeX source editor only`}
          min={10}
          max={24}
          value={props.appearance.editorFontSize}
          unit="px"
          onChange={(editorFontSize) => patchAppearance(props, { editorFontSize })}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Feedback`}>
        <SwitchField
          label={t`Interface sounds`}
          description={t`Plays quiet cues when a requested build or collaboration setup finishes`}
          checked={props.appearance.interfaceSounds}
          onChange={(interfaceSounds) => patchAppearance(props, { interfaceSounds })}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Browser`}>
        <SwitchField
          label={t`Start browser access after login`}
          description={t`Keep http://127.0.0.1:18452 available after login. Quitting Lattice stops it`}
          checked={browserAccessEnabled}
          disabled={browserAccessLoading}
          onChange={(enabled) => { void updateBrowserAccess(enabled); }}
        />
        <SettingsRow
          label={moveLabel}
          description={browserOutsideChromium
            ? t`Move this workspace back to a Lattice window on this Mac`
            : props.bundledChromium
              ? t`Open this workspace in your default browser. It returns to this window when the browser tab closes`
              : t`Open this workspace at http://127.0.0.1:18452. Files and credentials stay on this Mac`}
        >
          <Button size="compact" disabled={browserOpening} onClick={() => void moveWorkspace()}>
            {browserOpening ? t`Opening…` : moveLabel}
          </Button>
        </SettingsRow>
        {browserOpenError && (
          <InlineMessage level="error" className="settings-inline">
            {browserOpenError}
          </InlineMessage>
        )}
      </SettingsGroup>
    </div>
  );
}

function useSemanticSearchDetail(enabled: boolean, status: LocalSemanticSearchStatus): string {
  const { t } = useLingui();
  // The row description has to hold one line at the settings content width, so
  // the full pitch (Apple's model, nothing downloaded) rides the off state —
  // where the switch is still being weighed — and every state that also reports
  // index progress carries the short form of the same promise.
  const semanticSearchPrivacy = t`Runs on-device; no text leaves this Mac`;
  if (!enabled) {
    return t`Off by default. Apple’s built-in on-device model; nothing downloaded or uploaded`;
  }
  if (status.state === "indexing") {
    return status.totalChunks
      ? t`Indexing ${status.totalChunks} prose blocks. ${semanticSearchPrivacy}`
      : t`Starting the index. ${semanticSearchPrivacy}`;
  }
  if (status.state === "ready") {
    return status.indexedFiles === 1
      ? t`Ready for 1 file (${status.indexedChunks} blocks). ${semanticSearchPrivacy}`
      : t`Ready for ${status.indexedFiles} files (${status.indexedChunks} blocks). ${semanticSearchPrivacy}`;
  }
  if (status.state === "unavailable" || status.state === "error") {
    const detail = status.detail ?? t`The local model is unavailable.`;
    return t`${detail} Find in project will stay lexical`;
  }
  return semanticSearchPrivacy;
}

function useUpdateStatus(updater: UpdaterApi): { title: string; detail: string } {
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
  const auto = updater.mode === "auto";
  return {
    title: phaseTitles[updater.phase]
      ?? (auto ? t`New versions install automatically` : t`You’ll be notified when a new version is ready`),
    detail: updater.phase === "error"
      ? (updater.error ?? t`Check your connection and try again`)
      : auto
        ? t`Lattice checks in the background and installs updates on its own`
        : t`Lattice checks in the background; you decide when to install`,
  };
}

function EditorSettingsPane(props: SettingsDialogProps) {
  const { t } = useLingui();
  const updater = useUpdater();
  const updateStatus = useUpdateStatus(updater);
  const semanticSearchDetail = useSemanticSearchDetail(props.localSemanticSearchEnabled, props.localSemanticSearchStatus);
  const [projectWordDraft, setProjectWordDraft] = useState("");
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
      <SettingsSectionHeader
        title={t`Editor & builds`}
        description={t`Set the editor keymap and build behavior`}
      />
      <SettingsGroup title={t`Editing`}>
        <SettingsRow
          label={t`Editor keymap`}
          description={t`Vim and Emacs keep their modal bindings inside the editor only`}
        >
          <Select
            value={props.appearance.editorKeymap}
            onValueChange={(value) => patchAppearance(props, {
              editorKeymap: value as AppearanceSettings["editorKeymap"],
            })}
          >
            <SelectTrigger size="form" aria-label={t`Editor keymap`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="default">{t`Default`}</SelectItem>
              <SelectItem value="vim">Vim</SelectItem>
              <SelectItem value="emacs">Emacs</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SliderRow
          id="max-open-tabs"
          label={t`Max open tabs`}
          description={t`Lattice closes the least recently used tab past this count`}
          min={1}
          max={MAX_OPEN_TABS}
          value={props.appearance.maxOpenTabs}
          onChange={(maxOpenTabs) => patchAppearance(props, { maxOpenTabs })}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Search`}>
        <SwitchField
          label={t`Local semantic search`}
          description={semanticSearchDetail}
          checked={props.localSemanticSearchEnabled}
          onChange={props.onLocalSemanticSearchEnabledChange}
        />
      </SettingsGroup>
      <SettingsGroup title={t`Spelling`}>
        <SwitchField
          label={t`Check spelling in prose`}
          description={t`Checks English spelling and grammar as you type with Harper`}
          checked={props.appearance.editorSpellcheck}
          onChange={(editorSpellcheck) => patchAppearance(props, { editorSpellcheck })}
        />
        <SettingsRow
          className="settings-project-dictionary-row"
          label={t`Project dictionary`}
          description={props.project
            ? t`Terms Harper should accept in this project`
            : t`Open a project to add its names, acronyms, and technical terms`}
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
              <Button size="form" type="submit" disabled={!props.project || !projectWordDraft.trim()}>
                {t`Add`}
              </Button>
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
        <SettingsRow
          label={t`Automatic build`}
          description={props.buildPreferences.autoBuildMode === "automatic"
            ? t`Lattice saves and builds when you leave the editor or stop typing for 1.2 seconds`
            : t`Use the Build button or Command-S. Source changes are still saved automatically`}
        >
          <Select value={props.buildPreferences.autoBuildMode} onValueChange={(value) => props.setBuildPreferences({ autoBuildMode: value as AutoBuildMode })}>
            <SelectTrigger size="form" aria-label={t`Automatic build`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="manual">{t`Manual only`}</SelectItem>
              <SelectItem value="automatic">{t`Automatic`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label={t`Auxiliary files`}
          description={t`Removes .aux, .log, and other build leftovers from this project`}
        >
          <Button
            size="compact"
            disabled={!props.hasProject || props.cleaning || props.building}
            onClick={props.onCleanProject}
          >
            {props.cleaning ? t`Cleaning…` : t`Clean`}
          </Button>
        </SettingsRow>
        {props.project && (
          <>
            <SettingsRow
              label={t`Compile engine`}
              description={t`XeLaTeX and LuaLaTeX support system fonts. A project latexmkrc takes precedence`}
            >
              <Select
                value={props.project.manifest.engine ?? "pdf"}
                onValueChange={(value) => props.onUpdateManifest({ engine: value })}
              >
                <SelectTrigger size="form" aria-label={t`Compile engine`}><SelectValue /></SelectTrigger>
                <SelectContent data-settings-control="true" position="popper" align="end">
                  <SelectItem value="pdf">pdfLaTeX</SelectItem>
                  <SelectItem value="xelatex">XeLaTeX</SelectItem>
                  <SelectItem value="lualatex">LuaLaTeX</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <SwitchField
              label={t`Allow external commands`}
              description={t`Lets trusted projects run external tools during builds`}
              checked={props.project.manifest.trusted}
              onChange={(trusted) => props.onUpdateManifest({ trusted })}
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup title={t`App updates`}>
        <SettingsRow label={t`Automatic updates`} description={updateStatus.detail}>
          <Select value={updater.mode} onValueChange={(value) => updater.setMode(value as UpdateMode)}>
            <SelectTrigger size="form" aria-label={t`Automatic updates`}><SelectValue /></SelectTrigger>
            <SelectContent data-settings-control="true" position="popper" align="end">
              <SelectItem value="manual">{t`Notify me (manual)`}</SelectItem>
              <SelectItem value="auto">{t`Install automatically`}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t`Version`} description={updateStatus.title}>
          <ReloadButton
            size="compact"
            busy={updateBusy}
            disabled={updateBusy}
            onClick={() => void updater.check(false)}
          >
            {updater.phase === "checking" ? t`Checking…` : t`Check for updates`}
          </ReloadButton>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
