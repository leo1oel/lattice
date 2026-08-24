import {
  CheckCircle2,
  CircleX,
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
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmptyState } from "../components/ui/empty-state";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  InfinityLoader,
  ReloadButton,
  ReloadIconButton,
} from "../components/ui/activity-icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { PanelHeader } from "../components/ui/panel-header";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { useUpdater, type UpdateMode } from "../telemetry/app-updater";
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
import {
  type ProjectSnapshot,
  type SettingsTab,
  type DoctorReport,
} from "../app-types";
import {
  beginWindowDrag,
  toggleWindowFullscreen,
} from "../app-utils";
import { OverleafSettingsSection } from "../overleaf/overleaf-connect";
import { AnimatedProductIcon } from "../animated-icons/product-animated-icon";
import { ModalDialog } from "../components/ui/modal-dialog";
import { AppLogsSettings } from "../telemetry/app-log";
import { synaraFrameUrl, type SynaraRuntimeInfo } from "../agent/synara-runtime";
import { useSynaraNotificationBridge } from "../agent/synara-notifications";
import { useSynaraConfirmationBridge } from "../agent/synara-confirmations";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { InlineMessage } from "../components/ui/inline-message";
import type { LocalSemanticSearchStatus } from "../project/project-semantic-search";
import {
  applySynaraSettingsHeight,
  applySynaraSettingsWheel,
  isSettingsViewportNearBottom,
  normalizeSynaraSettingsHeight,
} from "../agent/synara-settings-layout";

const SYNARA_SETTINGS_SECTIONS: Partial<Record<SettingsTab, string>> = {
  agent: "providers",
  api: "skills",
  mcp: "integrations",
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
}) {
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
        { tab: "api", label: t`Skills`, icon: "api-key" },
      ],
    },
    {
      label: t`Integrations`,
      items: [
        { tab: "overleaf", label: t`Overleaf`, icon: "cloud-upload" },
      ],
    },
    {
      label: t`Diagnostics`,
      items: [
        { tab: "doctor", label: t`TeX doctor`, icon: "sparkle" },
        { tab: "logs", label: t`Logs`, icon: "logs" },
      ],
    },
  ] as const;
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
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserOpenError, setBrowserOpenError] = useState("");
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState(false);
  const [browserAccessLoading, setBrowserAccessLoading] = useState(true);
  const browserHosted = props.browserHosted;
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
  const openInBrowser = async () => {
    if (browserOpening || browserHosted) return;
    setBrowserOpening(true);
    setBrowserOpenError("");
    try {
      await props.onOpenInBrowser();
    } catch (reason) {
      setBrowserOpenError(reason instanceof Error ? reason.message : String(reason));
      setBrowserOpening(false);
    }
  };
  const returnToDesktop = async () => {
    if (browserOpening || !browserHosted) return;
    setBrowserOpening(true);
    setBrowserOpenError("");
    try {
      await props.onReturnToDesktop();
    } catch (reason) {
      setBrowserOpenError(reason instanceof Error ? reason.message : String(reason));
      setBrowserOpening(false);
    }
  };
  useEffect(() => {
    let active = true;
    void invoke<boolean>("browser_access_enabled")
      .then((enabled) => {
        if (active) setBrowserAccessEnabled(enabled);
      })
      .catch((reason) => {
        if (active) setBrowserOpenError(reason instanceof Error ? reason.message : String(reason));
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
    try {
      await invoke("set_browser_access_enabled", { enabled });
      setBrowserAccessEnabled(enabled);
    } catch (reason) {
      setBrowserOpenError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBrowserAccessLoading(false);
    }
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
      locale: resolveAppLocale(props.appearance.interfaceLanguage),
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
    if (settingsBottomPinFrameRef.current !== null) {
      window.cancelAnimationFrame(settingsBottomPinFrameRef.current);
      settingsBottomPinFrameRef.current = null;
    }
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
    // Every tab shares this viewport. The nested Logs scroller can chain a
    // wheel gesture into it at the end of the log, so each tab change must
    // reset the page viewport without touching the log viewport itself.
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
    props.tab,
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
            viewport
            && height > previousHeight
            && isSettingsViewportNearBottom(viewport),
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
            // A disclosure expanding at the old bottom otherwise leaves the
            // scrollbar there, with the newly added controls below the viewport.
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
        applySynaraSettingsWheel(viewport, {
          deltaX: typeof event.data.deltaX === "number" ? event.data.deltaX : 0,
          deltaY: event.data.deltaY,
          deltaMode: event.data.deltaMode,
        });
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
  useEffect(() => {
    // WKWebView delivers wheel to the iframe element when scrolling="no", not
    // to the child document. Without this, Providers/MCP/Skills can only move
    // from the Lattice scrollbar thumb.
    const container = synaraSettingsEmbedRef.current;
    if (!container || !synaraSettingsSection) return;
    const onWheel = (event: WheelEvent) => {
      const viewport = settingsViewportRef.current;
      if (!viewport) return;
      applySynaraSettingsWheel(viewport, event);
      event.preventDefault();
    };
    container.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => container.removeEventListener("wheel", onWheel, { capture: true });
  }, [synaraSettingsSection, synaraSettingsUrl]);
  const updateBusy = updater.phase === "checking"
    || updater.phase === "downloading"
    || updater.phase === "installing";
  const updateTitle = updater.phase === "available"
    ? t`Version ${updater.version ?? ""} is ready to install`
    : updater.phase === "downloading"
      ? t`Downloading update…`
      : updater.phase === "installing"
        ? t`Installing update…`
        // `errorKind` distinguishes the two failures that both land on
        // phase "error": a check that never reached the release feed, and a
        // download/install that started and then failed. Reporting one as the
        // other sent people looking in the wrong place.
        : updater.phase === "error"
          ? updater.errorKind === "install"
            ? t`Couldn’t install the update`
            : t`Couldn’t check for updates`
          : updater.phase === "up-to-date"
            ? t`You’re on the latest version`
            : updater.mode === "auto"
              ? t`New versions install automatically`
              : t`You’ll be notified when a new version is ready`;
  const updateDetail = updater.phase === "error"
    ? (updater.error ?? t`Check your connection and try again.`)
    : updater.mode === "auto"
      ? t`Lattice checks in the background and installs updates on its own.`
      : t`Lattice checks in the background; you decide when to install.`;
  // The row description has to hold one line at the settings content width, so
  // the full pitch (Apple's model, nothing downloaded) rides the off state —
  // where the switch is still being weighed — and every state that also reports
  // index progress carries the short form of the same promise.
  const semanticSearchPrivacy = t`Runs on-device; no text leaves this Mac.`;
  const semanticSearchDetail = (() => {
    const status = props.localSemanticSearchStatus;
    if (!props.localSemanticSearchEnabled) {
      return t`Off by default. Apple’s built-in on-device model; nothing downloaded or uploaded.`;
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
      return t`${detail} Find in project will stay lexical.`;
    }
    return semanticSearchPrivacy;
  })();
  const synaraSettingsLabel = props.tab === "agent"
    ? t`Providers`
    : props.tab === "api"
      ? t`Skills`
      : props.tab === "mcp"
        ? t`MCP`
        : t`Agent`;
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
          <nav className="settings-nav" aria-label={t`Settings sections`}>
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
                  title={t`Synara ${synaraSettingsLabel} settings`}
                  allow="clipboard-read; clipboard-write"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
                  scrolling="no"
                  style={{ height: synaraSettingsFrameHeight }}
                  onLoad={postSynaraSettingsSection}
                />
                {synaraSettingsSection && !synaraSettingsReady && (
                  <div className="synara-settings-loading" role="status">
                    <InfinityLoader size={14} /> {t`Loading settings…`}
                  </div>
                )}
              </div>
            )}
            {synaraSettingsSection && !synaraSettingsUrl && (
              <div className="synara-settings-state">
                {props.synaraRuntime.state === "ready" ? (
                  <EmptyState
                    description={t`Open a project to manage Agent settings.`}
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
                  title={t`Appearance`}
                  description={t`These preferences apply across every project on this Mac`}
                />
                <SettingsGroup title={t`Language`}>
                  <SettingsRow
                    label={t`Interface language`}
                    description={t`Choose the language used for menus, settings, and help text.`}
                  >
                    <Select
                      value={props.appearance.interfaceLanguage}
                      onValueChange={(value) => props.setAppearance({
                        ...props.appearance,
                        interfaceLanguage: value as InterfaceLanguage,
                      })}
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
                    description={t`Choose the theme for Lattice on this device.`}
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
                  <SettingsRow
                    htmlFor="editor-font-size"
                    label={t`Editor font size`}
                    description={t`Applies to the LaTeX source editor only.`}
                  >
                    <div className="settings-row-slider">
                      <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                      <output htmlFor="editor-font-size">{props.appearance.editorFontSize}px</output>
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title={t`Feedback`}>
                  <SwitchField
                    label={t`Interface sounds`}
                    description={t`Plays quiet cues when a requested build or collaboration setup finishes.`}
                    checked={props.appearance.interfaceSounds}
                    onChange={(interfaceSounds) => props.setAppearance({
                      ...props.appearance,
                      interfaceSounds,
                    })}
                  />
                </SettingsGroup>
                <SettingsGroup title={t`Browser`}>
                  <SwitchField
                    label={t`Keep browser access ready`}
                    description={t`Start Lattice quietly after login so the local browser address is always available.`}
                    checked={browserAccessEnabled}
                    disabled={browserAccessLoading}
                    onChange={(enabled) => { void updateBrowserAccess(enabled); }}
                  />
                  {!props.bundledChromium && (
                    <SettingsRow
                      label={browserHosted ? t`Open desktop app` : t`Open in browser`}
                      description={browserHosted
                        ? t`Move this workspace back to a Lattice window on this Mac.`
                        : t`Open this workspace at http://127.0.0.1:18452. Files and credentials stay on this Mac.`}
                    >
                      {browserHosted ? (
                        <Button
                          size="compact"
                          disabled={browserOpening}
                          onClick={() => void returnToDesktop()}
                        >
                          {browserOpening ? t`Opening…` : t`Open desktop app`}
                        </Button>
                      ) : (
                        <Button
                          size="compact"
                          disabled={browserOpening}
                          onClick={() => void openInBrowser()}
                        >
                          {browserOpening ? t`Opening…` : t`Open in browser`}
                        </Button>
                      )}
                    </SettingsRow>
                  )}
                  {browserOpenError && (
                    <InlineMessage level="error" className="settings-inline">
                      {browserOpenError}
                    </InlineMessage>
                  )}
                </SettingsGroup>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title={t`Editor & builds`}
                  description={t`Set the editor keymap and build behavior`}
                />
                <SettingsGroup title={t`Editing`}>
                  <SettingsRow
                    label={t`Editor keymap`}
                    description={t`Vim and Emacs keep their modal bindings inside the editor only.`}
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
                      <SelectTrigger size="form" aria-label={t`Editor keymap`}><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="default">{t`Default`}</SelectItem>
                        <SelectItem value="vim">Vim</SelectItem>
                        <SelectItem value="emacs">Emacs</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    htmlFor="max-open-tabs"
                    label={t`Max open tabs`}
                    description={t`Lattice closes the least recently used tab past this count.`}
                  >
                    <div className="settings-row-slider">
                      <input id="max-open-tabs" type="range" min="1" max={MAX_OPEN_TABS} step="1" value={props.appearance.maxOpenTabs} onChange={(event) => props.setAppearance({ ...props.appearance, maxOpenTabs: Number(event.target.value) })} />
                      <output htmlFor="max-open-tabs">{props.appearance.maxOpenTabs}</output>
                    </div>
                  </SettingsRow>
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
                    description={t`Checks English spelling and grammar as you type with Harper.`}
                    checked={props.appearance.editorSpellcheck}
                    onChange={(checked) => props.setAppearance({
                        ...props.appearance,
                        editorSpellcheck: checked,
                    })}
                  />
                  <SettingsRow
                    className="settings-project-dictionary-row"
                    label={t`Project dictionary`}
                    description={props.project
                      ? t`Terms Harper should accept in this project.`
                      : t`Open a project to add its names, acronyms, and technical terms.`}
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
                        <p className="settings-project-dictionary-empty">{t`No project terms added.`}</p>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title={t`Builds`}>
                  <SettingsRow
                    label={t`Automatic build`}
                    description={props.buildPreferences.autoBuildMode === "automatic"
                      ? t`Lattice saves and builds when you leave the editor or stop typing for 1.2 seconds.`
                      : t`Use the Build button or Command-S. Source changes are still saved automatically.`}
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
                    description={t`Removes .aux, .log, and other build leftovers from this project.`}
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
                      description={t`XeLaTeX and LuaLaTeX support system fonts. A project latexmkrc takes precedence.`}
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
                      description={t`Lets trusted projects run external tools during builds.`}
                      checked={props.project.manifest.trusted}
                      onChange={(trusted) => props.onUpdateManifest({ trusted })}
                    />
                  </>
                  )}
                </SettingsGroup>
                <SettingsGroup title={t`App updates`}>
                  <SettingsRow
                    label={t`Automatic updates`}
                    description={updateDetail}
                  >
                    <Select value={updater.mode} onValueChange={(value) => updater.setMode(value as UpdateMode)}>
                      <SelectTrigger size="form" aria-label={t`Automatic updates`}><SelectValue /></SelectTrigger>
                      <SelectContent data-settings-control="true" position="popper" align="end">
                        <SelectItem value="manual">{t`Notify me (manual)`}</SelectItem>
                        <SelectItem value="auto">{t`Install automatically`}</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <SettingsRow label={t`Version`} description={updateTitle}>
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
                  title={t`TeX doctor`}
                  description={t`Checks the tools Lattice needs to compile LaTeX`}
                  actions={(
                    <ReloadIconButton
                      label={t`Run TeX doctor`}
                      busy={props.doctorBusy}
                      disabled={props.doctorBusy}
                      onClick={props.onRunDoctor}
                    />
                  )}
                />
                <SettingsGroup title={t`Toolchain status`}>
                  {props.doctorReport && (
                    <>
                      <div className={`doctor-status ${props.doctorReport.ok ? "ok" : "bad"}`}>
                        {props.doctorReport.ok ? t`Ready to compile` : t`Missing required tools`}
                      </div>
                      <ul className="doctor-checklist">
                        {props.doctorReport.checks.map((check) => (
                          <li key={check.name} className={check.ok ? "ok" : "bad"}>
                            {check.ok
                              ? <CheckCircle2 aria-hidden="true" />
                              : <CircleX aria-hidden="true" />}
                            <strong>{check.name}</strong>
                            <span className="doctor-check-result">
                              {check.ok ? t`Ready to compile` : t`Unavailable`}
                            </span>
                            {!check.ok && <span className="doctor-check-detail">{check.detail}</span>}
                          </li>
                        ))}
                      </ul>
                      {!props.doctorReport.ok && (
                        <div className="settings-api-actions">
                          <Button disabled={props.doctorBusy} onClick={props.onOpenTexSetup}>
                            {t`Install required tools`}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  {!props.doctorReport && !props.doctorBusy && (
                    <>
                      <EmptyState
                        align="start"
                        density="compact"
                        description={t`Run the doctor to inspect this Mac’s TeX toolchain.`}
                      />
                      <div className="settings-api-actions">
                        <Button onClick={props.onOpenTexSetup}>
                          {t`Install required tools`}
                        </Button>
                      </div>
                    </>
                  )}
                  {props.doctorNotice && <InlineMessage level="error" className="settings-inline">{props.doctorNotice}</InlineMessage>}
                </SettingsGroup>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </ModalDialog>
  );
}
