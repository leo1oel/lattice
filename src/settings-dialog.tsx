import {
  Settings,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CopyButton } from "./components/copy-button";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  InfinityLoader,
  ReloadButton,
  ReloadIconButton,
} from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { ScrollArea } from "./components/ui/scroll-area";
import { PanelHeader } from "./components/ui/panel-header";
import { SettingsSectionHeader } from "./components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "./components/ui/settings-row";
import { SwitchField } from "./components/ui/switch-field";
import { useUpdater, type UpdateMode } from "./app-updater";
import {
  MAX_OPEN_TABS,
  type Theme,
  type AutoBuildMode,
  type BuildPreferences,
  type AppearanceSettings,
  type OverleafRemoteDelete,
  type OverleafSyncMode,
} from "./app-settings";
import {
  type ProjectSnapshot,
  type SettingsTab,
  type DoctorReport,
} from "./app-types";
import {
  autoBuildDetail,
  beginWindowDrag,
  toggleWindowFullscreen,
} from "./app-utils";
import { OverleafSettingsSection } from "./overleaf-connect";
import { AnimatedProductIcon } from "./animated-icons/product-animated-icon";
import { ModalDialog } from "./components/ui/modal-dialog";
import { AppLogsSettings } from "./app-log";
import { synaraFrameUrl, type SynaraRuntimeInfo } from "./synara-runtime";
import { useSynaraNotificationBridge } from "./synara-notifications";
import { useSynaraConfirmationBridge } from "./synara-confirmations";
import { SynaraLoadingSurface } from "./synara-loading-surface";
import {
  applySynaraSettingsHeight,
  isSettingsViewportNearBottom,
  normalizeSynaraSettingsHeight,
  scrollSynaraSettingsViewportBy,
} from "./synara-settings-layout";

const SETTINGS_NAV_GROUPS = [
  {
    label: "General",
    items: [
      { tab: "appearance", label: "Appearance", icon: "faders" },
      { tab: "editor", label: "Editor & builds", icon: "logs" },
    ],
  },
  {
    label: "Agent",
    items: [
      { tab: "agent", label: "Providers", icon: "robot" },
      { tab: "mcp", label: "MCP", icon: "plugs" },
      { tab: "api", label: "Skills", icon: "api-key" },
    ],
  },
  {
    label: "Integrations",
    items: [
      { tab: "overleaf", label: "Overleaf", icon: "cloud-upload" },
    ],
  },
  {
    label: "Diagnostics",
    items: [
      { tab: "doctor", label: "TeX doctor", icon: "sparkle" },
      { tab: "logs", label: "Logs", icon: "logs" },
    ],
  },
] as const;

const SYNARA_SETTINGS_SECTIONS: Partial<Record<SettingsTab, string>> = {
  agent: "providers",
  api: "skills",
  mcp: "integrations",
};

const SYNARA_SETTINGS_LABELS: Partial<Record<SettingsTab, string>> = {
  agent: "Providers",
  api: "Skills",
  mcp: "MCP",
};

const LATTICE_SETTINGS_SECTION_SET = "lattice:set-settings-section";
const SYNARA_SETTINGS_CONTENT_HEIGHT = "synara:settings-content-height";
const SYNARA_SETTINGS_WHEEL = "synara:settings-wheel";
const SYNARA_OPEN_EXTERNAL = "synara:open-external";
const SYNARA_SHOW_IN_FOLDER = "synara:show-in-folder";
const SYNARA_EMBED_READY = "synara:embed-ready";

async function openTrustedSynaraSkillsFolder(): Promise<void> {
  await invoke("synara_open_skills_folder");
}

export function SettingsDialog(props: {
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
  setTheme: (theme: Theme) => void;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  hasProject: boolean;
  project: ProjectSnapshot | null;
  activeFile: string | null;
  onUpdateManifest: (patch: {
    engine?: string | null;
    defaultRoot?: string | null;
    trusted?: boolean | null;
    spellingWords?: string[] | null;
  }) => void;
  onAddRootDocument: (path: string, makeDefault: boolean) => void;
  onRemoveRootDocument: (path: string) => void;
  doctorReport: DoctorReport | null;
  doctorBusy: boolean;
  doctorNotice: string;
  onRunDoctor: () => void;
  onOpenTexSetup: () => void;
  onCopyDoctorSummary: () => void;
  onCleanProject: () => void;
  cleaning: boolean;
  building: boolean;
  onClose: () => void;
}) {
  const updater = useUpdater();
  const synaraSettingsEmbedRef = useRef<HTMLDivElement>(null);
  const synaraSettingsFrameRef = useRef<HTMLIFrameElement>(null);
  const settingsViewportRef = useRef<HTMLDivElement>(null);
  const synaraSettingsHeightsRef = useRef<Record<string, number>>({});
  const synaraSettingsFrameHeightRef = useRef(470);
  const settingsBottomPinFrameRef = useRef<number | null>(null);
  const settingsTopResetFrameRef = useRef<number | null>(null);
  const [synaraSettingsFrameHeight, setSynaraSettingsFrameHeight] = useState(470);
  const [readySynaraSettingsUrl, setReadySynaraSettingsUrl] = useState<string | null>(null);
  const [projectWordDraft, setProjectWordDraft] = useState("");
  const synaraSettingsSection = SYNARA_SETTINGS_SECTIONS[props.tab];
  const projectSpellingWords = props.project?.manifest.spellingWords ?? [];
  const addProjectSpellingWord = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const word = projectWordDraft.trim();
    if (!word || !props.project) return;
    if (!projectSpellingWords.some((existing) => existing.toLocaleLowerCase() === word.toLocaleLowerCase())) {
      props.onUpdateManifest({ spellingWords: [...projectSpellingWords, word] });
    }
    setProjectWordDraft("");
  };
  const synaraEmbedUrl = props.synaraRuntime.state === "ready"
    ? props.synaraRuntime.origin
    : null;
  const synaraSettingsUrl = (() => {
    if (!synaraEmbedUrl || !props.synaraWorkspaceRoot) return null;
    return synaraFrameUrl({
      origin: synaraEmbedUrl,
      path: "/settings",
      workspaceRoot: props.synaraWorkspaceRoot,
      theme: props.theme,
      surface: "drawer",
      hostOrigin: window.location.origin,
      authToken: props.synaraRuntime.authToken,
      section: "providers",
    });
  })();
  const synaraSettingsOrigin = synaraEmbedUrl
    ? new URL(synaraEmbedUrl).origin
    : null;
  useSynaraNotificationBridge({
    frameRef: synaraSettingsFrameRef,
    origin: synaraSettingsOrigin,
    source: "Synara settings",
  });
  useSynaraConfirmationBridge({
    frameRef: synaraSettingsFrameRef,
    origin: synaraSettingsOrigin,
  });
  const synaraSettingsReady = Boolean(
    synaraSettingsUrl && readySynaraSettingsUrl === synaraSettingsUrl,
  );
  const synaraSettingsHeightKey = synaraSettingsUrl && synaraSettingsSection
    ? `${synaraSettingsUrl}#${synaraSettingsSection}`
    : null;
  const postSynaraSettingsSection = useCallback(() => {
    if (!synaraEmbedUrl || !synaraSettingsSection) return;
    synaraSettingsFrameRef.current?.contentWindow?.postMessage(
      { type: LATTICE_SETTINGS_SECTION_SET, section: synaraSettingsSection },
      new URL(synaraEmbedUrl).origin,
    );
  }, [synaraEmbedUrl, synaraSettingsSection]);
  useLayoutEffect(() => {
    const nextHeight = synaraSettingsHeightKey
      ? (synaraSettingsHeightsRef.current[synaraSettingsHeightKey] ?? 470)
      : 470;
    synaraSettingsFrameHeightRef.current = nextHeight;
    applySynaraSettingsHeight({
      container: synaraSettingsEmbedRef.current,
      frame: synaraSettingsFrameRef.current,
      height: nextHeight,
      active: Boolean(synaraSettingsSection),
    });
    setSynaraSettingsFrameHeight(nextHeight);
    const viewport = settingsViewportRef.current;
    if (viewport) {
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
    }
    if (settingsTopResetFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsTopResetFrameRef.current);
    }
    settingsTopResetFrameRef.current = window.requestAnimationFrame(() => {
      settingsTopResetFrameRef.current = null;
      const currentViewport = settingsViewportRef.current;
      if (currentViewport) {
        currentViewport.scrollTop = 0;
        currentViewport.scrollLeft = 0;
      }
    });
    postSynaraSettingsSection();
    return () => {
      if (settingsTopResetFrameRef.current !== null) {
        window.cancelAnimationFrame(settingsTopResetFrameRef.current);
        settingsTopResetFrameRef.current = null;
      }
    };
  }, [
    postSynaraSettingsSection,
    synaraSettingsHeightKey,
    synaraSettingsSection,
  ]);
  useEffect(
    () => () => {
      if (settingsBottomPinFrameRef.current !== null) {
        window.cancelAnimationFrame(settingsBottomPinFrameRef.current);
      }
      if (settingsTopResetFrameRef.current !== null) {
        window.cancelAnimationFrame(settingsTopResetFrameRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!synaraEmbedUrl || !synaraSettingsUrl) return;
    const synaraOrigin = new URL(synaraEmbedUrl).origin;
    const receiveSynaraSettingsMessage = (event: MessageEvent) => {
      if (
        event.source !== synaraSettingsFrameRef.current?.contentWindow ||
        event.origin !== synaraOrigin
      ) {
        return;
      }
      if (
        event.data?.type === SYNARA_SETTINGS_CONTENT_HEIGHT &&
        typeof event.data.height === "number" &&
        Number.isFinite(event.data.height) &&
        typeof event.data.section === "string"
      ) {
        const height = normalizeSynaraSettingsHeight(event.data.height);
        const heightKey = `${synaraSettingsUrl}#${event.data.section}`;
        synaraSettingsHeightsRef.current[heightKey] = height;
        if (heightKey === synaraSettingsHeightKey) {
          const previousHeight = synaraSettingsFrameHeightRef.current;
          const viewport = settingsViewportRef.current;
          const keepPinnedToBottom = Boolean(
            viewport &&
            height > previousHeight &&
            isSettingsViewportNearBottom(viewport),
          );
          synaraSettingsFrameHeightRef.current = height;
          // Height and wheel messages from the iframe are ordered, but a React
          // state update is not committed before the following wheel message.
          // Apply the geometry now so that the first wheel uses the real range.
          applySynaraSettingsHeight({
            container: synaraSettingsEmbedRef.current,
            frame: synaraSettingsFrameRef.current,
            height,
            active: true,
          });
          setSynaraSettingsFrameHeight(height);
          if (keepPinnedToBottom) {
            if (settingsBottomPinFrameRef.current !== null) {
              window.cancelAnimationFrame(settingsBottomPinFrameRef.current);
            }
            settingsBottomPinFrameRef.current = window.requestAnimationFrame(() => {
              settingsBottomPinFrameRef.current = null;
              const currentViewport = settingsViewportRef.current;
              if (currentViewport) {
                currentViewport.scrollTop = currentViewport.scrollHeight;
              }
            });
          }
        }
        return;
      }
      if (event.data?.type === SYNARA_EMBED_READY) {
        setReadySynaraSettingsUrl(synaraSettingsUrl);
        return;
      }
      if (
        event.data?.type === SYNARA_SETTINGS_WHEEL &&
        typeof event.data.deltaY === "number" &&
        Number.isFinite(event.data.deltaY)
      ) {
        const viewport = settingsViewportRef.current;
        if (!viewport) return;
        if (
          typeof event.data.contentHeight === "number" &&
          Number.isFinite(event.data.contentHeight) &&
          event.data.section === synaraSettingsSection &&
          synaraSettingsHeightKey
        ) {
          const height = normalizeSynaraSettingsHeight(event.data.contentHeight);
          synaraSettingsHeightsRef.current[synaraSettingsHeightKey] = height;
          synaraSettingsFrameHeightRef.current = height;
          applySynaraSettingsHeight({
            container: synaraSettingsEmbedRef.current,
            frame: synaraSettingsFrameRef.current,
            height,
            active: true,
          });
          setSynaraSettingsFrameHeight(height);
        }
        const scale = event.data.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.data.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientHeight
            : 1;
        scrollSynaraSettingsViewportBy(
          viewport,
          event.data.deltaY * scale,
          typeof event.data.deltaX === "number" ? event.data.deltaX * scale : 0,
        );
        return;
      }
      if (
        event.data?.type === SYNARA_OPEN_EXTERNAL &&
        typeof event.data.url === "string" &&
        /^https?:\/\//i.test(event.data.url)
      ) {
        void openUrl(event.data.url);
        return;
      }
      if (
        event.data?.type === SYNARA_SHOW_IN_FOLDER
      ) {
        // The exact iframe window and origin were verified above. Ignore the
        // child-provided path and reveal only Lattice's own shared-skill folder.
        void openTrustedSynaraSkillsFolder();
      }
    };
    window.addEventListener("message", receiveSynaraSettingsMessage);
    return () => window.removeEventListener("message", receiveSynaraSettingsMessage);
  }, [
    synaraEmbedUrl,
    synaraSettingsHeightKey,
    synaraSettingsSection,
    synaraSettingsUrl,
  ]);
  const updateBusy = updater.phase === "checking"
    || updater.phase === "downloading"
    || updater.phase === "installing";
  const updateTitle = updater.phase === "available"
    ? `Version ${updater.version ?? ""} is ready to install`.trim()
    : updater.phase === "downloading"
      ? "Downloading update…"
      : updater.phase === "installing"
        ? "Installing update…"
        : updater.phase === "error"
          ? "Couldn’t check for updates"
          : updater.phase === "up-to-date"
            ? "You’re on the latest version"
            : updater.mode === "auto"
              ? "New versions install automatically"
              : "You’ll be notified when a new version is ready";
  const updateDetail = updater.phase === "error"
    ? (updater.error ?? "Check your connection and try again.")
    : updater.mode === "auto"
      ? "Lattice checks in the background and installs updates on its own."
      : "Lattice checks in the background; you decide when to install.";
  return (
    <ModalDialog
      label="Settings"
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
          title="Settings"
          closeLabel="Close settings"
          onClose={props.onClose}
          onMouseDown={beginWindowDrag}
          onDoubleClick={toggleWindowFullscreen}
        />
        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div
                key={group.label}
                className="settings-nav-group"
                role="group"
                aria-labelledby={`settings-nav-${group.label.toLowerCase()}`}
              >
                <div
                  className="settings-nav-group-label"
                  id={`settings-nav-${group.label.toLowerCase()}`}
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
            {synaraSettingsUrl && (
              <div
                ref={synaraSettingsEmbedRef}
                className="synara-settings-embed"
                data-active={Boolean(synaraSettingsSection)}
                data-ready={synaraSettingsReady}
                aria-busy={Boolean(synaraSettingsSection) && !synaraSettingsReady}
                aria-hidden={!synaraSettingsSection}
                style={{ height: synaraSettingsSection ? synaraSettingsFrameHeight : 0 }}
              >
                <iframe
                  ref={synaraSettingsFrameRef}
                  className="synara-settings-frame"
                  src={synaraSettingsUrl}
                  title={`Synara ${SYNARA_SETTINGS_LABELS[props.tab] ?? "agent"} settings`}
                  allow="clipboard-read; clipboard-write"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
                  scrolling="no"
                  style={{ height: synaraSettingsFrameHeight }}
                  onLoad={postSynaraSettingsSection}
                />
                {synaraSettingsSection && !synaraSettingsReady && (
                  <div className="synara-settings-loading" role="status">
                    <InfinityLoader size={14} /> Loading settings…
                  </div>
                )}
              </div>
            )}
            {synaraSettingsSection && !synaraSettingsUrl && (
              <div className="synara-settings-state">
                {props.synaraRuntime.state === "ready" ? (
                  <EmptyState
                    description="Open a project to manage Agent settings."
                  />
                ) : (
                  <SynaraLoadingSurface
                    runtime={props.synaraRuntime}
                    onRetry={props.onRetrySynaraRuntime}
                  />
                )}
              </div>
            )}
            {props.tab === "appearance" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Appearance"
                  description="These preferences apply across every project on this Mac."
                />
                <SettingsGroup title="Theme">
                  <SettingsRow
                    label="Color theme"
                    description="Choose the theme for Lattice on this device."
                  >
                    <Select value={props.theme} onValueChange={(value) => props.setTheme(value as Theme)}>
                      <SelectTrigger size="form" aria-label="Color theme"><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="dark">Dark</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Display">
                  <SettingsRow
                    htmlFor="editor-font-size"
                    label="Editor font size"
                    description="Applies to the LaTeX source editor only."
                  >
                    <div className="settings-row-slider">
                      <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                      <output htmlFor="editor-font-size">{props.appearance.editorFontSize}px</output>
                    </div>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Editor & builds"
                  description="Set the editor keymap and build behavior."
                />
                <SettingsGroup title="Editing">
                  <SettingsRow
                    label="Editor keymap"
                    description="Vim and Emacs keep their modal bindings inside the editor only."
                  >
                    <Select
                      value={props.appearance.editorKeymap}
                      onValueChange={(value) => props.setAppearance({
                        ...props.appearance,
                        editorKeymap: value === "vim"
                          ? "vim"
                          : value === "emacs"
                            ? "emacs"
                            : "default",
                      })}
                    >
                      <SelectTrigger size="form" aria-label="Editor keymap"><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="default">Default</SelectItem>
                        <SelectItem value="vim">Vim</SelectItem>
                        <SelectItem value="emacs">Emacs</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    htmlFor="max-open-tabs"
                    label="Max open tabs"
                    description="Lattice closes the least recently used tab past this count."
                  >
                    <div className="settings-row-slider">
                      <input id="max-open-tabs" type="range" min="1" max={MAX_OPEN_TABS} step="1" value={props.appearance.maxOpenTabs} onChange={(event) => props.setAppearance({ ...props.appearance, maxOpenTabs: Number(event.target.value) })} />
                      <output htmlFor="max-open-tabs">{props.appearance.maxOpenTabs}</output>
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Spelling">
                  <SwitchField
                    label="Check spelling in prose"
                    description="Checks English spelling and grammar as you type with Harper."
                    checked={props.appearance.editorSpellcheck}
                    onChange={(checked) => props.setAppearance({
                        ...props.appearance,
                        editorSpellcheck: checked,
                    })}
                  />
                  <SettingsRow
                    className="settings-project-dictionary-row"
                    label="Project dictionary"
                    description={props.project
                      ? "Terms Harper should accept in this project."
                      : "Open a project to add its names, acronyms, and technical terms."}
                  >
                    <div className="settings-project-dictionary">
                      <form className="settings-project-dictionary-form" onSubmit={addProjectSpellingWord}>
                        <Input
                          controlSize="form"
                          aria-label="Add project term"
                          placeholder="e.g. Lattice"
                          value={projectWordDraft}
                          disabled={!props.project}
                          onChange={(event) => setProjectWordDraft(event.target.value)}
                        />
                        <Button size="form" type="submit" disabled={!props.project || !projectWordDraft.trim()}>
                          Add
                        </Button>
                      </form>
                      {projectSpellingWords.length > 0 ? (
                        <div className="settings-project-dictionary-terms" role="list" aria-label="Project dictionary terms">
                          {projectSpellingWords.map((word) => (
                            <span className="settings-project-dictionary-term" role="listitem" key={word}>
                              <span>{word}</span>
                              <button
                                type="button"
                                className="settings-project-dictionary-remove"
                                aria-label={`Remove ${word} from project dictionary`}
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
                        <p className="settings-project-dictionary-empty">No project terms added.</p>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Builds">
                  <SettingsRow
                    label="Automatic build"
                    description={autoBuildDetail(props.buildPreferences.autoBuildMode)}
                  >
                    <Select value={props.buildPreferences.autoBuildMode} onValueChange={(value) => props.setBuildPreferences({ autoBuildMode: value as AutoBuildMode })}>
                      <SelectTrigger size="form" aria-label="Automatic build"><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="manual">Manual only</SelectItem>
                        <SelectItem value="automatic">Automatic</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    label="Auxiliary files"
                    description="Removes .aux, .log, and other build leftovers from this project."
                  >
                    <Button
                      size="compact"
                      disabled={!props.hasProject || props.cleaning || props.building}
                      onClick={props.onCleanProject}
                    >
                      {props.cleaning ? "Cleaning…" : "Clean"}
                    </Button>
                  </SettingsRow>
                  {props.project && (
                  <>
                    <SettingsRow
                      label="Compile engine"
                      description="Applies to this project. XeLaTeX and LuaLaTeX support system fonts."
                    >
                      <Select
                        value={props.project.manifest.engine ?? "pdf"}
                        onValueChange={(value) => props.onUpdateManifest({ engine: value })}
                      >
                        <SelectTrigger size="form" aria-label="Compile engine"><SelectValue /></SelectTrigger>
                        <SelectContent data-settings-control="true" position="popper" align="end">
                          <SelectItem value="pdf">pdfLaTeX</SelectItem>
                          <SelectItem value="xelatex">XeLaTeX</SelectItem>
                          <SelectItem value="lualatex">LuaLaTeX</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                    <SettingsRow
                      label="Root document"
                      description="The file Lattice compiles when you build this project."
                    >
                      <Select
                        value={
                          props.project.manifest.rootDocuments.find((document) => document.isDefault)?.path
                          ?? props.project.manifest.rootDocuments[0]?.path
                          ?? ""
                        }
                        onValueChange={(value) => props.onUpdateManifest({ defaultRoot: value })}
                      >
                        <SelectTrigger size="form" aria-label="Root document"><SelectValue /></SelectTrigger>
                        <SelectContent data-settings-control="true" position="popper" align="end">
                          {props.project.manifest.rootDocuments.map((document) => (
                            <SelectItem key={document.path} value={document.path}>{document.name} ({document.path})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                    <SettingsRow
                      label="Compile roots"
                      description="Choose additional .tex entry points to compile alongside the main document."
                    >
                      <Button
                        size="compact"
                        disabled={!props.activeFile?.endsWith(".tex")}
                        title={props.activeFile?.endsWith(".tex") ? `Add ${props.activeFile} as a compile root` : "Open a .tex file first"}
                        onClick={() => {
                          if (props.activeFile?.endsWith(".tex")) {
                            props.onAddRootDocument(props.activeFile, false);
                          }
                        }}
                      >
                        Add open .tex
                      </Button>
                      <Button
                        size="compact"
                        disabled={props.project.manifest.rootDocuments.length <= 1}
                        title="Remove the selected root document"
                        onClick={() => {
                          const selected =
                            props.project!.manifest.rootDocuments.find((document) => document.isDefault)?.path
                            ?? props.project!.manifest.rootDocuments[0]?.path;
                          if (selected) props.onRemoveRootDocument(selected);
                        }}
                      >
                        Remove selected
                      </Button>
                    </SettingsRow>
                    <SwitchField
                      label="Allow external commands"
                      description="Lets LaTeX run external programs while compiling. Keep this off unless a trusted project needs it."
                      checked={props.project.manifest.trusted}
                      onChange={(trusted) => props.onUpdateManifest({ trusted })}
                    />
                  </>
                  )}
                </SettingsGroup>
                <SettingsGroup title="App updates">
                  <SettingsRow
                    label="Automatic updates"
                    description={updateDetail}
                  >
                    <Select value={updater.mode} onValueChange={(value) => updater.setMode(value as UpdateMode)}>
                      <SelectTrigger size="form" aria-label="Automatic updates"><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="manual">Notify me (manual)</SelectItem>
                        <SelectItem value="auto">Install automatically</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow label="Version" description={updateTitle}>
                    <ReloadButton
                      size="compact"
                      busy={updateBusy}
                      disabled={updateBusy}
                      onClick={() => void updater.check(false)}
                    >
                      {updater.phase === "checking" ? "Checking…" : "Check for updates"}
                    </ReloadButton>
                  </SettingsRow>
                </SettingsGroup>
              </div>
            )}
            {props.tab === "logs" && <AppLogsSettings />}
            {props.tab === "overleaf" && (
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
            )}
            {props.tab === "doctor" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="TeX doctor"
                  description="Checks local LaTeX tools, SyncTeX, bibliography processors, editor helpers, and conference fonts."
                  actions={(
                    <ReloadIconButton
                      label="Run TeX doctor"
                      busy={props.doctorBusy}
                      disabled={props.doctorBusy}
                      onClick={props.onRunDoctor}
                    />
                  )}
                />
                <SettingsGroup title="Toolchain status">
                  {props.doctorReport && (
                    <>
                      <div className={`doctor-status ${props.doctorReport.ok ? "ok" : "bad"}`}>
                        {props.doctorReport.ok ? "Ready to compile" : "Missing required tools"}
                      </div>
                      <ul className="doctor-checklist">
                        {props.doctorReport.checks.map((check) => (
                          <li key={check.name} className={check.ok ? "ok" : "bad"}>
                            <strong>{check.name}</strong>
                            <span>{check.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="settings-api-actions">
                        <Button onClick={props.onOpenTexSetup}>
                          Open install guide
                        </Button>
                        <CopyButton className={buttonClassName()} onCopy={props.onCopyDoctorSummary} title="Copy summary">
                          Copy summary
                        </CopyButton>
                      </div>
                    </>
                  )}
                  {!props.doctorReport && !props.doctorBusy && (
                    <>
                      <EmptyState
                        align="start"
                        density="compact"
                        description="Run the doctor to inspect this Mac’s TeX toolchain."
                      />
                      <div className="settings-api-actions">
                        <Button onClick={props.onOpenTexSetup}>
                          Open install guide
                        </Button>
                      </div>
                    </>
                  )}
                  {props.doctorBusy && (
                    <EmptyState
                      align="start"
                      density="compact"
                      icon={<InfinityLoader size={15} />}
                      description="Checking local tools…"
                    />
                  )}
                  {props.doctorNotice && <p className="settings-notice">{props.doctorNotice}</p>}
                </SettingsGroup>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </ModalDialog>
  );
}
