import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmAction, toMessage } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import "./plugin-settings.css";

type PluginCommand = { id: string; title: string; executable: string; args: string[] };
type Plugin = { manifest: { id: string; name: string; version: string; api_version: number; commands: PluginCommand[] }; path: string; enabled: boolean };
type CommandOutput = { success: boolean; exit_code: number | null; stdout: string; stderr: string };
type State = { plugins: Plugin[]; busy: boolean; error: string | null; output: CommandOutput | null };
type Action = { type: "busy" } | { type: "loaded"; plugins: Plugin[] } | { type: "output"; output: CommandOutput } | { type: "error"; error: string } | { type: "idle" };
function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "busy": return { ...state, busy: true, error: null, output: null };
    case "loaded": return { ...state, busy: false, plugins: action.plugins };
    case "output": return { ...state, busy: false, output: action.output };
    case "error": return { ...state, busy: false, error: action.error };
    case "idle": return { ...state, busy: false };
  }
}

/** Plugins are explicitly started user processes, not a sandbox. */
export function PluginSettings() {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reduce, { plugins: [], busy: true, error: null, output: null });
  useEffect(() => {
    let active = true;
    invoke<Plugin[]>("list_plugins").then(
      (plugins) => { if (active) dispatch({ type: "loaded", plugins }); },
      (error) => { if (active) dispatch({ type: "error", error: toMessage(error) }); },
    );
    return () => { active = false; };
  }, []);

  async function perform(operation: () => Promise<Plugin[]>) {
    dispatch({ type: "busy" });
    try { dispatch({ type: "loaded", plugins: await operation() }); }
    catch (error) { dispatch({ type: "error", error: toMessage(error) }); }
  }

  async function add() {
    let path: Awaited<ReturnType<typeof open>>;
    try { path = await open({ directory: true, multiple: false }); }
    catch (error) { dispatch({ type: "error", error: toMessage(error) }); return; }
    if (!path || typeof path !== "string") return;
    if (!await confirmAction({ title: t`Trust this plugin?`, message: t`Plugins run code with your account’s permissions. They can read and change your files and use the network. Only install a folder you trust. The plugin stays disabled until you enable it.`, confirmLabel: t`Install` })) return;
    await perform(() => invoke<Plugin[]>("install_plugin", { path }));
  }

  async function toggle(plugin: Plugin) {
    if (!plugin.enabled && !await confirmAction({ title: t`Enable this plugin?`, message: t`${plugin.manifest.name} can run code with your account’s permissions. Its linked folder can change after installation. Enable only if you trust its source.`, confirmLabel: t`Enable` })) return;
    await perform(() => invoke<Plugin[]>("set_plugin_enabled", { id: plugin.manifest.id, enabled: !plugin.enabled }));
  }

  async function run(plugin: Plugin, command: PluginCommand) {
    dispatch({ type: "busy" });
    try { dispatch({ type: "output", output: await invoke<CommandOutput>("run_plugin_command", { id: plugin.manifest.id, command: command.id }) }); }
    catch (error) { dispatch({ type: "error", error: toMessage(error) }); }
  }

  return <div className="settings-section plugin-settings" aria-busy={state.busy}>
    <SettingsSectionHeader title={t`Plugins`} />
    <InlineMessage level="warning">{t`Plugins are trusted programs, not sandboxed. They run with your account’s permissions. Only install plugins you trust.`}</InlineMessage>
    <p>{t`Link a local plugin folder. Commands run only when you choose them; removing a plugin does not delete its folder.`}</p>
    <Button disabled={state.busy} onClick={() => void add()}>{t`Add plugin folder…`}</Button>
    {state.error && <InlineMessage level="error">{state.error}</InlineMessage>}
    {!state.busy && state.plugins.length === 0 && <p>{t`No plugins installed.`}</p>}
    {state.plugins.map((plugin) => <SettingsGroup key={plugin.manifest.id} title={`${plugin.manifest.name} · ${plugin.manifest.version}`}>
      <SettingsRow label={plugin.manifest.id} description={plugin.path}>
        <div className="plugin-actions">
          <Button size="compact" disabled={state.busy} onClick={() => void toggle(plugin)}>{plugin.enabled ? t`Disable` : t`Enable`}</Button>
          <Button size="compact" disabled={state.busy} onClick={() => void perform(() => invoke<Plugin[]>("remove_plugin", { id: plugin.manifest.id }))}>{t`Remove`}</Button>
        </div>
      </SettingsRow>
      {plugin.manifest.commands.map((command) => <SettingsRow key={command.id} label={command.title} description={command.executable}>
        <Button size="compact" disabled={state.busy || !plugin.enabled} onClick={() => void run(plugin, command)}>{t`Run`}</Button>
      </SettingsRow>)}
    </SettingsGroup>)}
    {state.output && <section aria-label={t`Plugin output`}>
      <h3>{state.output.success ? t`Command completed` : t`Command failed`}</h3>
      <pre className="plugin-output">{state.output.stdout}{state.output.stderr}</pre>
    </section>}
  </div>;
}
