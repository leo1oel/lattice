import type { SearchPickerItem } from "../components/ui/search-picker-dialog";
import type { AppCommand } from "./use-app-commands";

/** What the writer is looking at, as far as the palette's suggestions go. */
export type PaletteSurface = "source" | "markdown" | "paper" | null;

const RECENT_SHOWN = 3;

/**
 * The commands worth one keystroke on each surface, best first. Ids missing
 * from the palette (hidden by `when`) are skipped, so a list may name
 * commands that only some projects have.
 */
const SURFACE_COMMANDS: Record<Exclude<PaletteSurface, null>, readonly string[]> = {
  source: ["build", "sync-pdf", "cite", "ref"],
  markdown: ["find", "quick-open", "discover"],
  paper: ["find", "discover", "quick-open"],
};

export function paletteSurface(open: { file: string; paper: boolean; asset: boolean }): PaletteSurface {
  if (open.paper) return "paper";
  if (open.asset || !open.file) return null;
  if (/\.(?:tex|ltx|sty|cls|bib)$/i.test(open.file)) return "source";
  if (/\.(?:md|markdown)$/i.test(open.file)) return "markdown";
  return null;
}

/**
 * What an empty palette query lists before everything else: the last few
 * commands run from it, then the ones for the open surface, each once.
 * Built only from `available` (the commands the palette lists right now), so
 * a remembered command that is hidden here, or one that opts out of being
 * recent, never comes back through this group.
 */
export function paletteLeading(
  available: readonly AppCommand[],
  recentIds: readonly string[],
  surface: PaletteSurface,
  groups: { recent: string; surface: string },
): SearchPickerItem[] {
  const byId = new Map(available.flatMap((command) => (command.label ? [[command.id, command] as const] : [])));
  const item = (command: AppCommand, group: string): SearchPickerItem => ({
    id: command.id, label: command.label ?? command.id, detail: command.detail, group,
  });
  const recent = recentIds
    .flatMap((id) => {
      const command = byId.get(id);
      return command && command.recent !== false ? [command] : [];
    })
    .slice(0, RECENT_SHOWN);
  const shown = new Set(recent.map((command) => command.id));
  const here = (surface ? SURFACE_COMMANDS[surface] : []).flatMap((id) => {
    const command = byId.get(id);
    return command && !shown.has(id) ? [command] : [];
  });
  return [...recent.map((command) => item(command, groups.recent)), ...here.map((command) => item(command, groups.surface))];
}
