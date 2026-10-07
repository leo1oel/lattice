/**
 * What the shortcut sheet lists, built from the keymaps themselves: App's
 * command table (every keyed command, under its palette group), Trellis's
 * keymap as the workspace configures it, the source editors' base keymap,
 * and the LaTeX and visual Markdown editors' key tables. A key that moves in
 * one of those moves here, so the sheet cannot drift from what the keys do.
 */
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { DEFAULT_KEYMAP } from "@danfessler/trellis";
import { editorShortcuts } from "../editor/editor-keymap";
import { LATEX_SHORTCUTS } from "../editor/latex/latex-shortcuts";
import { ENGINE_SHORTCUTS } from "../editor/markdown/engine/engine-shortcuts";
import { FOCUS_MODE_EXIT_KEY, TRELLIS_KEYMAP, TRELLIS_SHORTCUTS } from "../trellis/trellis-keymap";
import { comboKeys, parseKeyName } from "./key-combos";
import { commandCombo, type AppCommand } from "./use-app-commands";
import { PALETTE_SECTIONS } from "./palette-sections";

export type ShortcutRow = {
  label: string;
  /** Each combination's keycaps; several are alternatives, or a range when `range`. */
  combos: string[][];
  range?: boolean;
};
export type ShortcutGroup = { id: string; title: string; rows: ShortcutRow[] };

const GROUP_TITLES: Record<string, MessageDescriptor> = {
  panels: msg`Panels and tabs`,
  editor: msg`Text editing`,
  latex: msg`LaTeX`,
  markdown: msg`Visual Markdown`,
};

const keysOf = (name: string) => comboKeys(parseKeyName(name));

/** Rows of one group, one per label: commands sharing a label (⌘1 to ⌘9) share a row. */
function mergedRows(entries: Array<{ label: string; combos: string[][] }>): ShortcutRow[] {
  const rows = new Map<string, string[][]>();
  for (const { label, combos } of entries) rows.set(label, [...rows.get(label) ?? [], ...combos]);
  return [...rows].map(([label, combos]) => ({ label, combos, ...(combos.length > 2 ? { range: true } : {}) }));
}

export function shortcutGroups(commands: readonly AppCommand[], i18n: I18n): ShortcutGroup[] {
  // App's commands, in the order the table first names each group.
  const appGroups = new Map<string, Array<{ label: string; combos: string[][] }>>();
  for (const command of commands) {
    const combo = commandCombo(command);
    if (!combo || !command.label) continue;
    const group = command.group ? i18n._(PALETTE_SECTIONS[command.group].label) : "";
    const entries = appGroups.get(group) ?? [];
    entries.push({ label: command.label, combos: [comboKeys(combo)] });
    // Escape leaves focus mode too, when nothing else takes it.
    if (command.id === "focus-mode") entries.push({ label: i18n._(msg`Leave focus mode`), combos: [keysOf(FOCUS_MODE_EXIT_KEY)] });
    appGroups.set(group, entries);
  }
  const groups: ShortcutGroup[] = [...appGroups].map(([title, entries]) => ({ id: `app-${title}`, title, rows: mergedRows(entries) }));

  const trellisKeymap: Record<string, string | null> = { ...DEFAULT_KEYMAP, ...TRELLIS_KEYMAP };
  const panelRows = TRELLIS_SHORTCUTS.flatMap(({ label, commands: ids }) => {
    const names = ids.map((id) => trellisKeymap[id]);
    return names.every(Boolean) ? [{ label: i18n._(label), combos: names.map((name) => keysOf(name!)) }] : [];
  });
  const editorRows = editorShortcuts().map(({ label, keys }) => ({ label: i18n._(label), combos: keys.map(keysOf) }));
  const latexRows = Object.values(LATEX_SHORTCUTS).map(({ label, key }) => ({ label: i18n._(label), combos: [keysOf(key)] }));
  const markdownRows = Object.values(ENGINE_SHORTCUTS).map(({ label, keys }) => ({ label: i18n._(label), combos: keys.map(keysOf) }));
  for (const [id, entries] of [["panels", panelRows], ["editor", editorRows], ["latex", latexRows], ["markdown", markdownRows]] as const) {
    groups.push({ id, title: i18n._(GROUP_TITLES[id]), rows: mergedRows(entries) });
  }
  return groups;
}

/**
 * The groups with only the rows `query` finds, by name or by key (⌘⇧J, or
 * "j"); a group whose title matches keeps every row.
 */
export function filterShortcutGroups(groups: readonly ShortcutGroup[], query: string): ShortcutGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...groups];
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  return groups.flatMap((group) => {
    if (matches(group.title)) return [group];
    const rows = group.rows.filter((row) => matches(row.label) || row.combos.some((keys) => matches(keys.join(""))));
    return rows.length ? [{ ...group, rows }] : [];
  });
}
