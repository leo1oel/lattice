import {
  Check,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CopyButton } from "./components/copy-button";
import { MotionButton } from "./motion";
import { EmptyState } from "./components/ui/empty-state";
import { Button } from "./components/ui/button";
import { buttonClassName } from "./components/ui/button-styles";
import { Field } from "./components/ui/field";
import { IconButton } from "./components/ui/icon-button";
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
import { Switch } from "./components/ui/switch";
import { SwitchField } from "./components/ui/switch-field";
import { useUpdater, type UpdateMode } from "./app-updater";
import { AgentRuntimeSettings } from "./agent-runtime-settings";
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
  type AgentSkill,
  type SkillDraft,
  type McpServer,
  type McpServerDraft,
  type SettingsTab,
  type DoctorReport,
  type SubscriptionStatus,
} from "./app-types";
import {
  DEFAULT_EDITOR_FONT,
  EDITOR_FONT_OPTIONS,
  availableFontOptions,
} from "./available-fonts";
import { autoBuildTitle, autoBuildDetail } from "./app-utils";
import { McpSettingsSection } from "./mcp-settings";
import { OverleafSettingsSection } from "./overleaf-connect";
import { AnimatedProductIcon } from "./animated-icons/product-animated-icon";
import { ModalDialog } from "./components/ui/modal-dialog";
import { AppLogsSettings } from "./app-log";
import { synaraFrameUrl } from "./synara-runtime";

const SETTINGS_NAV_ITEMS = [
  { tab: "appearance", label: "Appearance", icon: "faders" },
  { tab: "editor", label: "Editor & builds", icon: "logs" },
  { tab: "agent", label: "Agent", icon: "robot" },
  { tab: "mcp", label: "MCP", icon: "plugs" },
  { tab: "accounts", label: "Subscriptions", icon: "users" },
  { tab: "overleaf", label: "Overleaf", icon: "cloud-upload" },
  { tab: "api", label: "API keys", icon: "api-key" },
  { tab: "doctor", label: "TeX doctor", icon: "sparkle" },
  { tab: "logs", label: "Logs", icon: "logs" },
] as const;

const SYNARA_SETTINGS_SECTIONS: Partial<Record<SettingsTab, string>> = {
  agent: "providers",
  accounts: "models",
  api: "skills",
  mcp: "integrations",
};

const SYNARA_SETTINGS_LABELS: Partial<Record<SettingsTab, string>> = {
  agent: "Providers",
  accounts: "Models",
  api: "Skills",
  mcp: "MCP",
};

const LATTICE_SETTINGS_SECTION_SET = "lattice:set-settings-section";
const SYNARA_SETTINGS_CONTENT_HEIGHT = "synara:settings-content-height";
const SYNARA_SETTINGS_WHEEL = "synara:settings-wheel";
const SYNARA_OPEN_EXTERNAL = "synara:open-external";

export function SettingsDialog(props: {
  synaraEmbedUrl?: string;
  synaraAuthToken?: string;
  synaraWorkspaceRoot?: string;
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  overleafSyncMode: OverleafSyncMode;
  overleafRemoteDelete: OverleafRemoteDelete;
  onOverleafRemoteDeleteChange: (mode: OverleafRemoteDelete) => void;
  /** Re-ask the runtime for its models after it has been updated. */
  onAgentRuntimeUpdated: () => void;
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
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
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
  skills: AgentSkill[];
  skillDraft: SkillDraft | null;
  setSkillDraft: (draft: SkillDraft | null) => void;
  onSaveSkill: (draft: SkillDraft) => void;
  onSetSkillEnabled: (name: string, enabled: boolean) => void;
  onDeleteSkill: (skill: AgentSkill) => void;
  mcpServers: McpServer[];
  mcpDraft: McpServerDraft | null;
  setMcpDraft: (draft: McpServerDraft | null) => void;
  onSaveMcpServer: (draft: McpServerDraft) => void;
  onSetMcpServerEnabled: (name: string, enabled: boolean) => void;
  onDeleteMcpServer: (server: McpServer) => void;
  subscriptions: SubscriptionStatus[];
  subscriptionsLoading: boolean;
  subscriptionNotice: string;
  // (updater state is read from context via useUpdater, not passed as a prop)
  onRefreshSubscriptions: () => void;
  onSubscriptionLogin: (provider: "codex" | "claude") => void;
  apiProvider: "openai" | "anthropic";
  setApiProvider: (provider: "openai" | "anthropic") => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  apiConfigured: boolean;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
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
  const synaraSettingsFrameRef = useRef<HTMLIFrameElement>(null);
  const settingsViewportRef = useRef<HTMLDivElement>(null);
  const [synaraSettingsFrameHeight, setSynaraSettingsFrameHeight] = useState(470);
  const synaraSettingsSection = props.synaraEmbedUrl
    ? SYNARA_SETTINGS_SECTIONS[props.tab]
    : undefined;
  const synaraSettingsUrl = (() => {
    if (!props.synaraEmbedUrl || !props.synaraWorkspaceRoot) return null;
    return synaraFrameUrl({
      origin: props.synaraEmbedUrl,
      path: "/settings",
      workspaceRoot: props.synaraWorkspaceRoot,
      theme: props.theme,
      hostOrigin: window.location.origin,
      authToken: props.synaraAuthToken,
      section: "providers",
    });
  })();
  const postSynaraSettingsSection = useCallback(() => {
    if (!props.synaraEmbedUrl || !synaraSettingsSection) return;
    synaraSettingsFrameRef.current?.contentWindow?.postMessage(
      { type: LATTICE_SETTINGS_SECTION_SET, section: synaraSettingsSection },
      new URL(props.synaraEmbedUrl).origin,
    );
  }, [props.synaraEmbedUrl, synaraSettingsSection]);
  useEffect(() => {
    postSynaraSettingsSection();
  }, [postSynaraSettingsSection, synaraSettingsUrl]);
  useEffect(() => {
    if (!props.synaraEmbedUrl) return;
    const synaraOrigin = new URL(props.synaraEmbedUrl).origin;
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
        Number.isFinite(event.data.height)
      ) {
        setSynaraSettingsFrameHeight(Math.min(4000, Math.max(470, Math.ceil(event.data.height))));
        return;
      }
      if (
        event.data?.type === SYNARA_SETTINGS_WHEEL &&
        typeof event.data.deltaY === "number" &&
        Number.isFinite(event.data.deltaY)
      ) {
        const viewport = settingsViewportRef.current;
        if (!viewport) return;
        const scale = event.data.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.data.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientHeight
            : 1;
        viewport.scrollBy({
          top: event.data.deltaY * scale,
          left: typeof event.data.deltaX === "number" ? event.data.deltaX * scale : 0,
        });
        return;
      }
      if (
        event.data?.type === SYNARA_OPEN_EXTERNAL &&
        typeof event.data.url === "string" &&
        /^https?:\/\//i.test(event.data.url)
      ) {
        void openUrl(event.data.url);
      }
    };
    window.addEventListener("message", receiveSynaraSettingsMessage);
    return () => window.removeEventListener("message", receiveSynaraSettingsMessage);
  }, [props.synaraEmbedUrl]);
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
    <ModalDialog label="Settings" onClose={props.onClose}>
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
                <span>{props.synaraEmbedUrl ? (SYNARA_SETTINGS_LABELS[item.tab] ?? item.label) : item.label}</span>
              </button>
            ))}
          </nav>
          <ScrollArea
            className="settings-content"
            viewportRef={settingsViewportRef}
          >
            {synaraSettingsUrl && (
              <iframe
                ref={synaraSettingsFrameRef}
                className="synara-settings-frame"
                src={synaraSettingsUrl}
                title={`Synara ${SYNARA_SETTINGS_LABELS[props.tab] ?? "agent"} settings`}
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
                hidden={!synaraSettingsSection}
                style={{ height: synaraSettingsFrameHeight }}
                onLoad={postSynaraSettingsSection}
              />
            )}
            {props.tab === "appearance" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Appearance"
                  description="These preferences apply across every project on this Mac."
                />
                <Field label="Color theme">
                  <Select value={props.theme} onValueChange={(value) => props.setTheme(value as Theme)}>
                    <SelectTrigger aria-label="Color theme"><SelectValue /></SelectTrigger>
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
                <Field label="LaTeX editor font">
                  <Select
                    value={
                      availableFontOptions(EDITOR_FONT_OPTIONS).some((option) => option.value === props.appearance.editorFont)
                        ? props.appearance.editorFont
                        : DEFAULT_EDITOR_FONT
                    }
                    onValueChange={(value) => props.setAppearance({ ...props.appearance, editorFont: value })}
                  >
                    <SelectTrigger aria-label="LaTeX editor font"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      {availableFontOptions(EDITOR_FONT_OPTIONS).map((option) => (
                        <SelectItem key={option.family} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
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
                    <SelectTrigger aria-label="Editor keymap"><SelectValue /></SelectTrigger>
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
                    <SelectTrigger aria-label="Automatic build"><SelectValue /></SelectTrigger>
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
                        <SelectTrigger aria-label="Compile engine"><SelectValue /></SelectTrigger>
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
                        <SelectTrigger aria-label="Root document"><SelectValue /></SelectTrigger>
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
                      <SelectTrigger aria-label="Automatic updates"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" align="start">
                        <SelectItem value="manual">Notify me (manual)</SelectItem>
                        <SelectItem value="auto">Install automatically</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="settings-detail">
                    <RefreshCw size={14} />
                    <div><strong>{updateTitle}</strong><span>{updateDetail}</span></div>
                  </div>
                  <div className="root-document-actions">
                    <Button
                      size="compact"
                      disabled={updateBusy}
                      onClick={() => void updater.check(false)}
                    >
                      {updater.phase === "checking" ? "Checking…" : "Check for updates"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {props.tab === "logs" && <AppLogsSettings />}
            {!props.synaraEmbedUrl && props.tab === "agent" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Agent"
                  description="Lattice uses Oh My Pi as its agent backend. The prompt and skills below stay inside Lattice and never change your global agent setup."
                />
                <Field label="System prompt" htmlFor="agent-system-prompt">
                  <textarea
                    id="agent-system-prompt"
                    aria-label="Agent system prompt"
                    placeholder="Write the system prompt you want OMP to use…"
                    value={props.systemPrompt}
                    onChange={(event) => props.setSystemPrompt(event.target.value)}
                  />
                </Field>
                <div className="skill-heading">
                  <div><strong>Skills</strong><span>Enabled skills are given to OMP on its next turn.</span></div>
                  <Button size="compact" onClick={() => props.setSkillDraft({ scope: "application", content: "---\nname: new-skill\ndescription: Describe when OMP should use this skill.\n---\n\n# New skill\n\nWrite the instructions here.\n" })}><Plus size={12} /> Add skill</Button>
                </div>
                {props.skillDraft ? (
                  <div className="skill-editor">
                    <Field label="Availability">
                      <Select value={props.skillDraft.scope} onValueChange={(value) => props.setSkillDraft({ ...props.skillDraft!, scope: value as "application" | "project" })}>
                        <SelectTrigger aria-label="Availability"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" align="start">
                          <SelectItem value="application">All Lattice projects</SelectItem>
                          <SelectItem value="project" disabled={!props.hasProject}>This project only</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="SKILL.md">
                      <textarea aria-label="Skill instructions" value={props.skillDraft.content} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, content: event.target.value })} />
                    </Field>
                    <div className="skill-editor-actions">
                      <Button size="compact" variant="ghost" onClick={() => props.setSkillDraft(null)}>Cancel</Button>
                      <MotionButton
                        className={buttonClassName({ variant: "primary", size: "compact" })}
                        onClick={() => props.onSaveSkill(props.skillDraft!)}
                      >
                        Save skill
                      </MotionButton>
                    </div>
                  </div>
                ) : (
                  <div className="skill-list">
                    {props.skills.map((skill) => (
                      <div className="skill-card" key={skill.name}>
                        <Switch checked={skill.enabled} label={`Enable ${skill.name}`} onChange={(next) => props.onSetSkillEnabled(skill.name, next)} />
                        <div><strong>{skill.name}</strong><small>{skill.scope === "built-in" ? "Bundled" : skill.scope === "application" ? "All projects" : "This project"}{skill.overridden ? " · overrides bundled" : ""}</small><p>{skill.description}</p></div>
                        <div className="skill-actions">
                          <button title={`Edit ${skill.name}`} onClick={() => props.setSkillDraft({ originalName: skill.name, scope: skill.scope === "project" ? "project" : "application", content: skill.content })}><Pencil size={12} /></button>
                          {skill.scope !== "built-in" && <button title={skill.overridden ? `Restore bundled ${skill.name}` : `Delete ${skill.name}`} onClick={() => props.onDeleteSkill(skill)}>{skill.overridden ? <RotateCcw size={12} /> : <Trash2 size={12} />}</button>}
                        </div>
                      </div>
                    ))}
                    {!props.skills.length && (
                      <EmptyState
                        align="start"
                        density="compact"
                        description="No skills are installed in Lattice."
                      />
                    )}
                  </div>
                )}
              </div>
            )}
            {!props.synaraEmbedUrl && props.tab === "mcp" && (
              <McpSettingsSection
                hasProject={props.hasProject}
                servers={props.mcpServers}
                draft={props.mcpDraft}
                setDraft={props.setMcpDraft}
                onSave={props.onSaveMcpServer}
                onSetEnabled={props.onSetMcpServerEnabled}
                onDelete={props.onDeleteMcpServer}
              />
            )}
            {!props.synaraEmbedUrl && props.tab === "accounts" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="Subscriptions"
                  description="OMP manages sign-in and token refresh for Lattice."
                  actions={(
                    <IconButton
                      label="Refresh subscription status"
                      disabled={props.subscriptionsLoading}
                      onClick={props.onRefreshSubscriptions}
                    >
                      <RefreshCw className={props.subscriptionsLoading ? "spin" : undefined} />
                    </IconButton>
                  )}
                />
                <div className="account-list">
                  {props.subscriptions.map((account) => (
                    <div className="account-card" key={account.provider}>
                      <div className={`account-mark ${account.loggedIn ? "connected" : ""}`}>{account.provider === "codex" ? "O" : "C"}</div>
                      <div><strong>{account.provider === "codex" ? "Codex subscription" : "Claude subscription"}</strong><small>{account.detail}</small></div>
                      {!account.loggedIn && (
                        <Button
                          size="compact"
                          variant="primary"
                          disabled={!account.installed || props.subscriptionsLoading}
                          onClick={() => props.onSubscriptionLogin(account.provider)}
                        >
                          Sign in with OMP
                        </Button>
                      )}
                      {account.loggedIn && <span className="connected-label"><Check size={12} /> Connected</span>}
                    </div>
                  ))}
                  {!props.subscriptions.length && (
                    <EmptyState
                      align="start"
                      density="compact"
                      description={props.subscriptionsLoading
                        ? "Checking local subscriptions…"
                        : "Refresh to check local subscriptions."}
                    />
                  )}
                </div>
                {props.subscriptionNotice && <p className="settings-notice">{props.subscriptionNotice}</p>}
                <AgentRuntimeSettings onUpdated={props.onAgentRuntimeUpdated} />
              </div>
            )}
            {props.tab === "overleaf" && (
              <OverleafSettingsSection
                syncMode={props.overleafSyncMode}
                onSyncModeChange={props.onOverleafSyncModeChange}
                remoteDelete={props.overleafRemoteDelete}
                onRemoteDeleteChange={props.onOverleafRemoteDeleteChange}
                channel={props.overleafChannel}
                channelDetail={props.overleafChannelDetail}
                onLinkChanged={props.onOverleafLinkChanged}
              />
            )}
            {!props.synaraEmbedUrl && props.tab === "api" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="API keys"
                  description="API keys are optional and only used by the API providers. OMP authenticates subscription providers separately."
                />
                <Field label="Provider">
                  <Select value={props.apiProvider} onValueChange={(value) => props.setApiProvider(value as "openai" | "anthropic")}>
                    <SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="openai">OpenAI API</SelectItem>
                      <SelectItem value="anthropic">Anthropic API</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  htmlFor="settings-api-key"
                  label={(
                    <span className="key-label">
                      API key
                      {props.apiConfigured && <span className="configured-label"><Check size={11} /> Configured</span>}
                    </span>
                  )}
                >
                  <input id="settings-api-key" type="password" autoComplete="off" placeholder={props.apiConfigured ? "Enter a replacement key" : "Paste API key"} value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.apiKey.trim() && props.onSaveApiKey()} />
                </Field>
                <div className="settings-api-actions">
                  {props.apiConfigured && (
                    <Button size="compact" variant="danger" onClick={props.onDeleteApiKey}>
                      <Trash2 size={13} /> Remove
                    </Button>
                  )}
                  <span />
                  <MotionButton
                    className={buttonClassName({ variant: "primary" })}
                    onClick={props.onSaveApiKey}
                    disabled={!props.apiKey.trim()}
                  >
                    Save key
                  </MotionButton>
                </div>
              </div>
            )}
            {props.tab === "doctor" && (
              <div className="settings-section">
                <SettingsSectionHeader
                  title="TeX doctor"
                  description="Checks local LaTeX tools, SyncTeX, bibliography processors, and the bundled agent runtime."
                  actions={(
                    <IconButton
                      label="Run TeX doctor"
                      disabled={props.doctorBusy}
                      onClick={props.onRunDoctor}
                    >
                      <RefreshCw className={props.doctorBusy ? "spin" : undefined} />
                    </IconButton>
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
                  <EmptyState align="start" density="compact" description="Checking local tools…" />
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
