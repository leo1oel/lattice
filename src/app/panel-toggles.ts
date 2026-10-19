/**
 * The panels the command palette shows or hides by name, and the keys that
 * toggle some of them. Their tooltips (the titlebar's Panels menu) read the
 * keys back from App's command table.
 */
import { TERMINAL_TOGGLE_KEY } from "../terminal/terminal-layout";
import type { AppCommand } from "./use-app-commands";

export const SINGLETON_PANELS = [
  "project", "papers", "agent", "pdf", "terminal", "history", "comments", "literature", "todos", "checklist", "git", "overleaf",
] as const;

/**
 * Project, Papers and the Agent toggle on ⌘⌥1 to ⌘⌥3, in the Panels menu's
 * order (⌘1 to ⌘9 are the workspaces), and the Terminal on ⌃`. Every other
 * panel and tool is only shown.
 */
export const PANEL_TOGGLE_KEYS: Partial<Record<(typeof SINGLETON_PANELS)[number], Pick<AppCommand, "key" | "alt" | "ctrl">>> = {
  project: { key: "1", alt: true },
  papers: { key: "2", alt: true },
  agent: { key: "3", alt: true },
  terminal: TERMINAL_TOGGLE_KEY,
};
