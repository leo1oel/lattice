import {
  Check,
  Copy,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { MotionButton, SpinButton } from "./motion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { useUpdater, type UpdateMode } from "./app-updater";
import {
  type Theme,
  type AutoBuildMode,
  type BuildPreferences,
  type AppearanceSettings,
} from "./app-settings";
import {
  type ProjectSnapshot,
  type AgentSkill,
  type SkillDraft,
  type SettingsTab,
  type DoctorReport,
  type SubscriptionStatus,
} from "./app-types";
import {
  DEFAULT_EDITOR_FONT,
  EDITOR_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  availableFontOptions,
} from "./available-fonts";
import { autoBuildTitle, autoBuildDetail } from "./app-utils";

export function SettingsDialog(props: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
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
  onClose: () => void;
}) {
  const updater = useUpdater();
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
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div><Settings size={17} /><span>Settings</span></div>
          <button title="Close settings" onClick={props.onClose}><X size={16} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            <button className={props.tab === "appearance" ? "active" : ""} onClick={() => props.setTab("appearance")}>Appearance</button>
            <button className={props.tab === "editor" ? "active" : ""} onClick={() => props.setTab("editor")}>Editor & builds</button>
            <button className={props.tab === "agent" ? "active" : ""} onClick={() => props.setTab("agent")}>Agent</button>
            <button className={props.tab === "accounts" ? "active" : ""} onClick={() => props.setTab("accounts")}>Subscriptions</button>
            <button className={props.tab === "api" ? "active" : ""} onClick={() => props.setTab("api")}>API keys</button>
            <button className={props.tab === "doctor" ? "active" : ""} onClick={() => props.setTab("doctor")}>TeX doctor</button>
          </nav>
          <div className="settings-content">
            {props.tab === "appearance" && (
              <div className="settings-section">
                <h2>Appearance</h2>
                <p>These preferences apply across every project on this Mac.</p>
                <label>Color theme
                  <Select value={props.theme} onValueChange={(value) => props.setTheme(value as Theme)}>
                    <SelectTrigger aria-label="Color theme"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label>Interface font
                  <Select value={props.appearance.uiFont} onValueChange={(value) => props.setAppearance({ ...props.appearance, uiFont: value })}>
                    <SelectTrigger aria-label="Interface font"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      {availableFontOptions(UI_FONT_OPTIONS).map((option) => (
                        <SelectItem key={option.family} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="interface-size">Interface size</label><output>{Math.round(props.appearance.interfaceScale * 100)}%</output></div>
                  <input id="interface-size" type="range" min="90" max="135" step="5" value={Math.round(props.appearance.interfaceScale * 100)} onChange={(event) => props.setAppearance({ ...props.appearance, interfaceScale: Number(event.target.value) / 100 })} />
                </div>
                <label>LaTeX editor font
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
                </label>
                <div className="settings-range">
                  <div><label htmlFor="editor-font-size">Editor font size</label><output>{props.appearance.editorFontSize}px</output></div>
                  <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                </div>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <h2>Editor & builds</h2>
                <p>Choose keymap behavior and when Lattice recompiles after a source change.</p>
                <label>Editor keymap
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
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={props.appearance.editorSpellcheck}
                    onChange={(event) => props.setAppearance({
                      ...props.appearance,
                      editorSpellcheck: event.target.checked,
                    })}
                  />
                  <span>Spellcheck prose in the editor</span>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="max-open-tabs">Max open tabs</label><output>{props.appearance.maxOpenTabs}</output></div>
                  <input id="max-open-tabs" type="range" min="1" max="20" step="1" value={props.appearance.maxOpenTabs} onChange={(event) => props.setAppearance({ ...props.appearance, maxOpenTabs: Number(event.target.value) })} />
                </div>
                <label>Automatic build
                  <Select value={props.buildPreferences.autoBuildMode} onValueChange={(value) => props.setBuildPreferences({ autoBuildMode: value as AutoBuildMode })}>
                    <SelectTrigger aria-label="Automatic build"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="manual">Manual only</SelectItem>
                      <SelectItem value="automatic">Automatic</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <div className="settings-detail">
                  <Play size={14} />
                  <div><strong>{autoBuildTitle(props.buildPreferences.autoBuildMode)}</strong><span>{autoBuildDetail(props.buildPreferences.autoBuildMode)}</span></div>
                </div>
                {props.project && (
                  <>
                    <label>Compile engine
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
                    </label>
                    <label>Root document
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
                    </label>
                    <div className="root-document-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!props.activeFile?.endsWith(".tex")}
                        title={props.activeFile?.endsWith(".tex") ? `Add ${props.activeFile} as a compile root` : "Open a .tex file first"}
                        onClick={() => {
                          if (props.activeFile?.endsWith(".tex")) {
                            props.onAddRootDocument(props.activeFile, false);
                          }
                        }}
                      >
                        Add open .tex
                      </button>
                      <button
                        type="button"
                        className="secondary"
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
                      </button>
                    </div>
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={props.project.manifest.trusted}
                        onChange={(event) => props.onUpdateManifest({ trusted: event.target.checked })}
                      />
                      <span>Allow shell escape when compiling</span>
                    </label>
                  </>
                )}
                <div className="settings-updates">
                  <h3>App updates</h3>
                  <p>Choose whether Lattice installs new versions automatically or just tells you.</p>
                  <label>Automatic updates
                    <Select value={updater.mode} onValueChange={(value) => updater.setMode(value as UpdateMode)}>
                      <SelectTrigger aria-label="Automatic updates"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" align="start">
                        <SelectItem value="manual">Notify me (manual)</SelectItem>
                        <SelectItem value="auto">Install automatically</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="settings-detail">
                    <RefreshCw size={14} />
                    <div><strong>{updateTitle}</strong><span>{updateDetail}</span></div>
                  </div>
                  <div className="root-document-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={updateBusy}
                      onClick={() => void updater.check(false)}
                    >
                      {updater.phase === "checking" ? "Checking…" : "Check for updates"}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {props.tab === "agent" && (
              <div className="settings-section">
                <h2>Agent</h2>
                <p>Lattice uses Oh My Pi as its agent backend. The prompt and skills below stay inside Lattice and never change your global agent setup.</p>
                <label htmlFor="agent-system-prompt">System prompt
                  <textarea
                    id="agent-system-prompt"
                    aria-label="Agent system prompt"
                    placeholder="Write the system prompt you want OMP to use…"
                    value={props.systemPrompt}
                    onChange={(event) => props.setSystemPrompt(event.target.value)}
                  />
                </label>
                <div className="skill-heading">
                  <div><strong>Skills</strong><span>Enabled skills are given to OMP on its next turn.</span></div>
                  <button onClick={() => props.setSkillDraft({ scope: "application", content: "---\nname: new-skill\ndescription: Describe when OMP should use this skill.\n---\n\n# New skill\n\nWrite the instructions here.\n" })}><Plus size={12} /> Add skill</button>
                </div>
                {props.skillDraft ? (
                  <div className="skill-editor">
                    <label>Availability
                      <Select value={props.skillDraft.scope} onValueChange={(value) => props.setSkillDraft({ ...props.skillDraft!, scope: value as "application" | "project" })}>
                        <SelectTrigger aria-label="Availability"><SelectValue /></SelectTrigger>
                        <SelectContent position="popper" align="start">
                          <SelectItem value="application">All Lattice projects</SelectItem>
                          <SelectItem value="project" disabled={!props.hasProject}>This project only</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label>SKILL.md
                      <textarea aria-label="Skill instructions" value={props.skillDraft.content} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, content: event.target.value })} />
                    </label>
                    <div className="skill-editor-actions"><button onClick={() => props.setSkillDraft(null)}>Cancel</button><MotionButton className="primary-button" onClick={() => props.onSaveSkill(props.skillDraft!)}>Save skill</MotionButton></div>
                  </div>
                ) : (
                  <div className="skill-list">
                    {props.skills.map((skill) => (
                      <div className="skill-card" key={skill.name}>
                        <button className={`skill-toggle ${skill.enabled ? "enabled" : ""}`} role="switch" aria-checked={skill.enabled} aria-label={`Enable ${skill.name}`} onClick={() => props.onSetSkillEnabled(skill.name, !skill.enabled)}><span /></button>
                        <div><strong>{skill.name}</strong><small>{skill.scope === "built-in" ? "Bundled" : skill.scope === "application" ? "All projects" : "This project"}{skill.overridden ? " · overrides bundled" : ""}</small><p>{skill.description}</p></div>
                        <div className="skill-actions">
                          <button title={`Edit ${skill.name}`} onClick={() => props.setSkillDraft({ originalName: skill.name, scope: skill.scope === "project" ? "project" : "application", content: skill.content })}><Pencil size={12} /></button>
                          {skill.scope !== "built-in" && <button title={skill.overridden ? `Restore bundled ${skill.name}` : `Delete ${skill.name}`} onClick={() => props.onDeleteSkill(skill)}>{skill.overridden ? <RotateCcw size={12} /> : <Trash2 size={12} />}</button>}
                        </div>
                      </div>
                    ))}
                    {!props.skills.length && <p className="settings-empty">No skills are installed in Lattice.</p>}
                  </div>
                )}
              </div>
            )}
            {props.tab === "accounts" && (
              <div className="settings-section">
                <div className="settings-section-title"><div><h2>Subscriptions</h2><p>OMP manages sign-in and token refresh for Lattice.</p></div><SpinButton title="Refresh subscription status" busy={props.subscriptionsLoading} onClick={props.onRefreshSubscriptions} disabled={props.subscriptionsLoading}><RefreshCw size={14} /></SpinButton></div>
                <div className="account-list">
                  {props.subscriptions.map((account) => (
                    <div className="account-card" key={account.provider}>
                      <div className={`account-mark ${account.loggedIn ? "connected" : ""}`}>{account.provider === "codex" ? "O" : "C"}</div>
                      <div><strong>{account.provider === "codex" ? "Codex subscription" : "Claude subscription"}</strong><small>{account.detail}</small></div>
                      {!account.loggedIn && <button disabled={!account.installed || props.subscriptionsLoading} onClick={() => props.onSubscriptionLogin(account.provider)}>Sign in with OMP</button>}
                      {account.loggedIn && <span className="connected-label"><Check size={12} /> Connected</span>}
                    </div>
                  ))}
                  {!props.subscriptions.length && <p className="settings-empty">{props.subscriptionsLoading ? "Checking local subscriptions…" : "Refresh to check local subscriptions."}</p>}
                </div>
                {props.subscriptionNotice && <p className="settings-notice">{props.subscriptionNotice}</p>}
              </div>
            )}
            {props.tab === "api" && (
              <div className="settings-section">
                <h2>API keys</h2>
                <p>API keys are optional and only used by the API providers. OMP authenticates subscription providers separately.</p>
                <label>Provider
                  <Select value={props.apiProvider} onValueChange={(value) => props.setApiProvider(value as "openai" | "anthropic")}>
                    <SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value="openai">OpenAI API</SelectItem>
                      <SelectItem value="anthropic">Anthropic API</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label>
                  <span className="key-label">API key {props.apiConfigured && <span className="configured-label"><Check size={11} /> Configured</span>}</span>
                  <input type="password" autoComplete="off" placeholder={props.apiConfigured ? "Enter a replacement key" : "Paste API key"} value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.apiKey.trim() && props.onSaveApiKey()} />
                </label>
                <div className="settings-api-actions">
                  {props.apiConfigured && <button className="delete-key-button" onClick={props.onDeleteApiKey}><Trash2 size={13} /> Remove</button>}
                  <span />
                  <MotionButton className="primary-button" onClick={props.onSaveApiKey} disabled={!props.apiKey.trim()}>Save key</MotionButton>
                </div>
              </div>
            )}
            {props.tab === "doctor" && (
              <div className="settings-section">
                <div className="settings-section-title">
                  <div>
                    <h2>TeX doctor</h2>
                    <p>Checks local LaTeX tools, SyncTeX, bibliography processors, and the bundled agent runtime.</p>
                  </div>
                  <SpinButton title="Run TeX doctor" busy={props.doctorBusy} onClick={props.onRunDoctor} disabled={props.doctorBusy}>
                    <RefreshCw size={14} />
                  </SpinButton>
                </div>
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
                      <button className="secondary-button" type="button" onClick={props.onOpenTexSetup}>
                        Open install guide
                      </button>
                      <button className="secondary-button" type="button" onClick={props.onCopyDoctorSummary}>
                        <Copy size={13} /> Copy summary
                      </button>
                    </div>
                  </>
                )}
                {!props.doctorReport && !props.doctorBusy && (
                  <>
                    <p className="settings-empty">Run the doctor to inspect this Mac’s TeX toolchain.</p>
                    <div className="settings-api-actions">
                      <button className="secondary-button" type="button" onClick={props.onOpenTexSetup}>
                        Open install guide
                      </button>
                    </div>
                  </>
                )}
                {props.doctorBusy && <p className="settings-empty">Checking local tools…</p>}
                {props.doctorNotice && <p className="settings-notice">{props.doctorNotice}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
