/**
 * The plugin host's IPC (src-tauri/src/ipc/plugins.rs, over
 * lattice-core's plugins module) and the shapes it sends, as docs/plugins.md
 * describes them. Results arrive already checked by the core: paths are
 * project-relative, URLs http(s), BibTeX one valid entry.
 */
import { useEffect, useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { subscribeTauriEvent } from "../app/effect-helpers";

/** What every window hears after a plugin was installed, turned on or off, or removed. */
export const PLUGINS_CHANGED_EVENT = "plugins-changed";

type PluginInput = { kind: "none" | "text"; placeholder?: string | null };

/** One palette row: an enabled plugin's command. */
export type PluginCommand = {
  pluginId: string;
  pluginName: string;
  commandId: string;
  title: string;
  description?: string | null;
  input: PluginInput;
};

type PluginActionKind =
  | { type: "insertCitation"; key: string }
  | { type: "addBibEntry"; bibtex: string; file?: string }
  | { type: "replaceBibEntry"; key: string; bibtex: string; file?: string }
  | { type: "reveal"; file: string; line?: number }
  | { type: "openUrl"; url: string }
  | { type: "copy"; text: string };
export type PluginAction = PluginActionKind & { title?: string };
export type PluginBibAction = Extract<PluginAction, { type: "addBibEntry" | "replaceBibEntry" }>;

export type PluginItem = {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  badges: string[];
  actions: PluginAction[];
};

type PluginSeverity = "error" | "warning" | "info";
export type PluginDiagnostic = {
  id: string;
  file: string;
  line?: number;
  severity: PluginSeverity;
  code?: string;
  message: string;
  fixes: PluginAction[];
};

export type PluginResult =
  | { kind: "message"; summary?: string; markdown: string }
  | { kind: "items"; summary?: string; items: PluginItem[] }
  | { kind: "diagnostics"; summary?: string; items: PluginDiagnostic[] };

/** Why a command returned no result; `code` is what the page localizes. */
export type PluginError = { code: string; message?: string; stderr?: string; level?: number };

export type PluginRunEvent =
  | { type: "progress"; message: string; fraction?: number | null }
  | { type: "log"; level: string; message: string };

export type PluginPermissions = {
  projectRead: ("context" | "bibliography")[];
  networkLocal: number[];
  network: string[];
  secrets: string[];
};

type PluginSource = { kind: "folder"; path: string } | { kind: "url"; url: string; sha256: string };

export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  license: string;
  repository?: string | null;
  runtime: "node" | "exec";
  source: PluginSource;
  enabled: boolean;
  permissions: PluginPermissions;
  granted?: PluginPermissions | null;
  needsReview: boolean;
  commands: { id: string; title: string; description?: string; input: PluginInput }[];
  secrets: { name: string; saved: boolean }[];
  error?: string | null;
};

export type PluginList = { available: boolean; plugins: PluginInfo[] };

/** 1-based, as the protocol counts. */
type PluginPosition = { line: number; column: number };

/** What the page knows about where the writer is; every path project-relative. */
export type PluginPageContext = {
  mainDocument?: string;
  activeFile?: string;
  selection?: { text: string; file: string; from: PluginPosition; to: PluginPosition };
  cursor?: { file: string; position: PluginPosition };
};

export const listPlugins = () => invoke<PluginList>("plugins_list");
export const installPluginFolder = (path: string) => invoke<PluginInfo>("plugins_install_folder", { path });
export const installPluginUrl = (url: string, sha256: string) => invoke<PluginInfo>("plugins_install_url", { url, sha256 });
export const setPluginEnabled = (id: string, enabled: boolean) => invoke<PluginInfo>("plugins_set_enabled", { id, enabled });
export const removePlugin = (id: string) => invoke<void>("plugins_remove", { id });
export const setPluginSecret = (id: string, name: string, value: string | null) =>
  invoke<PluginInfo>("plugins_set_secret", { id, name, value });
export const cancelPluginRun = (runId: string) => invoke<void>("plugins_cancel", { runId });

/** Run one command to its result; rejects with a {@link PluginError}. */
export function runPluginCommand(request: {
  runId: string;
  command: PluginCommand;
  input: string | null;
  projectRoot: string | null;
  context: PluginPageContext | null;
  locale: string;
}, onEvent: (event: PluginRunEvent) => void): Promise<PluginResult> {
  const channel = new Channel<PluginRunEvent>();
  channel.onmessage = onEvent;
  return invoke<PluginResult>("plugins_run", {
    runId: request.runId,
    pluginId: request.command.pluginId,
    commandId: request.command.commandId,
    input: request.input,
    projectRoot: request.projectRoot,
    context: request.context,
    locale: request.locale,
    onEvent: channel,
  });
}

/** A rejection as a {@link PluginError}: an IPC failure becomes `launch` with its text. */
export function asPluginError(reason: unknown): PluginError {
  if (reason && typeof reason === "object" && typeof (reason as { code?: unknown }).code === "string") return reason as PluginError;
  return { code: "launch", message: reason instanceof Error ? reason.message : String(reason) };
}

/** The last list the palette saw, so a reopened palette lists the rows at once while it asks again. */
let knownCommands: readonly PluginCommand[] = [];
const commandListeners = new Set<() => void>();
const subscribeCommands = (listener: () => void) => {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
};
function setCommands(next: readonly PluginCommand[]) {
  knownCommands = next;
  for (const listener of commandListeners) listener();
}

/** The palette's plugin rows, read when it opens and again whenever plugins change. */
export function usePluginCommands(): readonly PluginCommand[] {
  const commands = useSyncExternalStore(subscribeCommands, () => knownCommands);
  useEffect(() => {
    let disposed = false;
    const generation = { current: 0 };
    const load = () => {
      generation.current += 1;
      const current = generation.current;
      invoke<PluginCommand[]>("plugins_commands").then((next) => {
        if (disposed || current !== generation.current) return;
        setCommands(next);
      }, () => {
        // No plugin host (a browser preview without one): no rows.
      });
    };
    load();
    const unsubscribe = subscribeTauriEvent<unknown>(PLUGINS_CHANGED_EVENT, load);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return commands;
}
