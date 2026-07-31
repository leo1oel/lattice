import {
  Download,
  Play,
  Settings,
} from "lucide-react";
import {
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
import {
  InfinityLoader,
  ReloadButton,
  ReloadIconButton,
} from "./components/ui/activity-icons";
import { buttonClassName } from "./components/ui/button-styles";
import { Field } from "./components/ui/field";
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
import { SwitchField } from "./components/ui/switch-field";
import { useUpdater, type UpdateMode } from "./app-updater";
import {
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
import { autoBuildTitle, autoBuildDetail } from "./app-utils";
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

const SETTINGS_NAV_ITEMS = [
  { tab: "appearance", label: "Appearance", icon: "faders" },
  { tab: "editor", label: "Editor & builds", icon: "logs" },
  { tab: "agent", label: "Providers", icon: "robot" },
  { tab: "mcp", label: "MCP", icon: "plugs" },
  { tab: "overleaf", label: "Overleaf", icon: "cloud-upload" },
  { tab: "api", label: "Skills", icon: "api-key" },
  { tab: "doctor", label: "TeX doctor", icon: "sparkle" },
  { tab: "logs", label: "Logs", icon: "logs" },
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
  const synaraSettingsSection = SYNARA_SETTINGS_SECTIONS[props.tab];
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
    <ModalDialog label="Settings" focusDialogOnOpen onClose={props.onClose}>
      <div className="settings-modal">
        <PanelHeader
          className="settings-header"
          icon={<Settings size={17} />}
          title="Settings"
          closeLabel="Close settings"
          onClose={props.onClose}
        />
        <div className="settings-body">
          <nav className="settings-nav">
            {SETTINGS_NAV_ITEMS.map((item) => (
              <button
                key={item.tab}
                className={props.tab === item.tab ? "active" : ""}
                onClick={() => props.setTab(item.tab)}
              >
                <AnimatedProductIcon kind={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
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
                <Field label="Color theme">
                  <Select value={props.theme} onValueChange={(value) => props.setTheme(value as Theme)}>
                    <SelectTrigger size="form" aria-label="Color theme"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="settings-range">
                  <div><label htmlFor="interface-size">Interface size</label><output>{Math.round(props.appearance.interfaceScale * 100)}%</output></div>
                  <input id="interface-size" type="range" min="90" max="135" step="5" value={Math.round(props.appearance.interfaceScale * 100)} onChange={(event) => props.setAppearance({ ...props.appearance, interfaceScale: Number(event.target.value) / 100 })} />
                </div>
                <div className="settings-range">
                  <div><label htmlFor="editor-font-size">Editor font size</label><output>{props.appearance.editorFontSize}px</output></div>
                  <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                </div>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Editor & builds"
                  description="Choose keymap behavior and when Lattice recompiles after a source change."
                />
                <Field label="Editor keymap">
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
                    <SelectContent position="popper" align="start">
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="vim">Vim</SelectItem>
                      <SelectItem value="emacs">Emacs</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <SwitchField
                  label="Spellcheck prose in the editor"
                  checked={props.appearance.editorSpellcheck}
                  onChange={(checked) => props.setAppearance({
                      ...props.appearance,
                      editorSpellcheck: checked,
                  })}
                />
                <div className="settings-range">
                  <div><label htmlFor="max-open-tabs">Max open tabs</label><output>{props.appearance.maxOpenTabs}</output></div>
                  <input id="max-open-tabs" type="range" min="1" max="20" step="1" value={props.appearance.maxOpenTabs} onChange={(event) => props.setAppearance({ ...props.appearance, maxOpenTabs: Number(event.target.value) })} />
                </div>
                <Field label="Automatic build">
                  <Select value={props.buildPreferences.autoBuildMode} onValueChange={(value) => props.setBuildPreferences({ autoBuildMode: value as AutoBuildMode })}>
                    <SelectTrigger size="form" aria-label="Automatic build"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="manual">Manual only</SelectItem>
                      <SelectItem value="automatic">Automatic</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="settings-detail">
                  <Play size={14} />
                  <div><strong>{autoBuildTitle(props.buildPreferences.autoBuildMode)}</strong><span>{autoBuildDetail(props.buildPreferences.autoBuildMode)}</span></div>
                </div>
                <div className="root-document-actions">
                  <Button
                    size="compact"
                    disabled={!props.hasProject || props.cleaning || props.building}
                    onClick={props.onCleanProject}
                  >
                    {props.cleaning ? "Cleaning auxiliary files…" : "Clean auxiliary files"}
                  </Button>
                </div>
                {props.project && (
                  <>
                    <Field label="Compile engine">
                      <Select
                        value={props.project.manifest.engine ?? "pdf"}
                        onValueChange={(value) => props.onUpdateManifest({ engine: value })}
                      >
                        <SelectTrigger size="form" aria-label="Compile engine"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" align="start">
                          <SelectItem value="pdf">pdfLaTeX</SelectItem>
                          <SelectItem value="xelatex">XeLaTeX</SelectItem>
                          <SelectItem value="lualatex">LuaLaTeX</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Root document">
                      <Select
                        value={
                          props.project.manifest.rootDocuments.find((document) => document.isDefault)?.path
                          ?? props.project.manifest.rootDocuments[0]?.path
                          ?? ""
                        }
                        onValueChange={(value) => props.onUpdateManifest({ defaultRoot: value })}
                      >
                        <SelectTrigger size="form" aria-label="Root document"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" align="start">
                          {props.project.manifest.rootDocuments.map((document) => (
                            <SelectItem key={document.path} value={document.path}>{document.name} ({document.path})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <div className="root-document-actions">
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
                    </div>
                    <SwitchField
                      label="Allow shell escape when compiling"
                      checked={props.project.manifest.trusted}
                      onChange={(trusted) => props.onUpdateManifest({ trusted })}
                    />
                  </>
                )}
                <div className="settings-updates">
                  <h3>App updates</h3>
                  <p>Choose whether Lattice installs new versions automatically or just tells you.</p>
                  <Field label="Automatic updates">
                    <Select value={updater.mode} onValueChange={(value) => updater.setMode(value as UpdateMode)}>
                      <SelectTrigger size="form" aria-label="Automatic updates"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" align="start">
                        <SelectItem value="manual">Notify me (manual)</SelectItem>
                        <SelectItem value="auto">Install automatically</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="settings-detail">
                    <Download size={14} />
                    <div><strong>{updateTitle}</strong><span>{updateDetail}</span></div>
                  </div>
                  <div className="root-document-actions">
                    <ReloadButton
                      size="compact"
                      busy={updateBusy}
                      disabled={updateBusy}
                      onClick={() => void updater.check(false)}
                    >
                      {updater.phase === "checking" ? "Checking…" : "Check for updates"}
                    </ReloadButton>
                  </div>
                </div>
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
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </ModalDialog>
  );
}
