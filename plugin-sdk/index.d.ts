// SPDX-License-Identifier: MIT
// Types for lattice-plugin.mjs. The protocol types are generated (api.d.ts).
import type {
  BibliographyEntriesResult,
  CommandContext,
  CommandResult,
  HttpFetchParams,
  HttpFetchResult,
  LogLevel,
} from "./api";

export * from "./api";

export interface Host {
  /** Needs `project-read = ["bibliography"]`. */
  bibliographyEntries(file?: string): Promise<BibliographyEntriesResult>;
  /** Needs the URL's origin in `network`. A string is a GET. */
  fetch(request: string | HttpFetchParams): Promise<HttpFetchResult>;
  /** Needs the name in `secrets`; `null` when the writer has not saved it. */
  secret(name: string): Promise<string | null>;
  log(level: LogLevel, message: string): void;
  /** Shown in the palette while the command runs; `fraction` is 0–1. */
  progress(message: string, fraction?: number): void;
}

export interface CommandCall {
  /** What the writer typed, for a command whose input kind is `text`. */
  input: string | null;
  context: CommandContext;
  host: Host;
  /** Aborted when the writer cancels or the run times out. */
  signal: AbortSignal;
}

export type CommandHandler = (call: CommandCall) => Promise<CommandResult> | CommandResult;

export declare function definePlugin(plugin: { commands: Record<string, CommandHandler> }): void;

/** Throw to show `message` to the writer as the command's outcome. */
export declare class PluginError extends Error {}

/** A host call failed. `code` -32001 means the plugin was not granted it. */
export declare class HostError extends Error {
  code: number;
  data?: unknown;
}
