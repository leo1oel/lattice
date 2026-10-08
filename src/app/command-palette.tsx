/**
 * The command palette (⌘K, also ⌘⇧P): one keyboard-first list that reaches
 * every app command, and, once something is typed, the project's files, the
 * Papers in its library and every Settings row. An empty query leads with the
 * recent commands and the open document's own (`paletteLeading`), then the
 * recently opened files, then every command by section.
 *
 * Quick open (⌘P) stays the files-only picker; the palette ranks files the
 * same way (`scorePath`) and draws them with the same icons, so a file found
 * here and there reads as one thing.
 */
import { useId, useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  BookOpen, Cloud, Compass, Eye, FolderOpen, Hammer, LayoutPanelLeft, Library, PenLine, Settings, SunMoon, type LucideIcon,
} from "lucide-react";
import { PickerDialog, type SearchPickerItem } from "../components/ui/search-picker-dialog";
import { searchPickerRow } from "../components/ui/picker-row";
import { scoreItem, scorePath } from "../components/ui/picker-ranking";
import { renderKeycaps } from "../components/ui/render-keycaps";
import { fileIcon } from "../trellis/trellis-icons";
import { isProjectAssetFilePath } from "../app-utils";
import { paperShortAuthors } from "../papers/paper-identity";
import { settingsEntryKey, useSettingsSearchIndex, type SettingsSearchEntry } from "../settings/settings-search-index";
import type { PaperSummary } from "../app-types";
import { commandKeys, type AppCommand } from "./use-app-commands";
import { comboKeys } from "./key-combos";
import { PALETTE_SECTIONS, type PaletteSection } from "./palette-sections";

/** Each section's icon; its name and order are `PALETTE_SECTIONS`'. */
const SECTION_ICONS: Record<PaletteSection, LucideIcon> = {
  navigate: Compass, edit: PenLine, build: Hammer, view: Eye, layout: LayoutPanelLeft,
  research: Library, overleaf: Cloud, project: FolderOpen, appearance: SunMoon,
};
/** Every icon a row repeats: the sections', a Paper's and a setting's. */
const ROW_ICONS: Record<PaletteSection | "paper" | "setting", LucideIcon> = {
  ...SECTION_ICONS,
  paper: BookOpen,
  setting: Settings,
};
type RowIcon = keyof typeof ROW_ICONS;

/**
 * Each repeated icon is drawn once, as a symbol rows point at: an empty
 * palette lists every command, and an icon component per row was most of
 * what an opening rendered (the perf bench's dialog-open). The <use> takes
 * the row's color like the icon it replaces.
 */
function IconSprite({ prefix }: { prefix: string }) {
  return (
    <svg className="picker-icon-sprite" aria-hidden="true" focusable="false">
      {(Object.entries(ROW_ICONS) as [RowIcon, LucideIcon][]).map(([name, Icon]) => (
        <symbol key={name} id={`${prefix}-${name}`} viewBox="0 0 24 24"><Icon size={24} /></symbol>
      ))}
    </svg>
  );
}
const rowIcon = (prefix: string, name: RowIcon) => (
  <svg className="lucide" width={14} height={14} aria-hidden="true" focusable="false"><use href={`#${prefix}-${name}`} /></svg>
);

/** Files, Papers and Settings rows rank after commands that score the same (a command's order is its section's plus a fraction). */
const FOUND_ORDER = { file: 10, paper: 11, setting: 12 } as const;

/** How many of each kind a typed query may list, best first. */
const LIMITS = { command: 40, file: 12, paper: 6, setting: 6 } as const;
/** Papers and settings rows hold long prose; only a real run of the query finds them, never scattered letters. */
const PROSE_FLOOR = 280;
const RECENT_FILES_SHOWN = 4;

type PaletteItem = SearchPickerItem & { order: number } & (
  | { kind: "command" }
  | { kind: "file"; path: string }
  | { kind: "paper"; paper: PaperSummary }
  | { kind: "setting"; entry: SettingsSearchEntry }
);

export type PaletteChoice =
  | { kind: "command"; id: string }
  | { kind: "file"; path: string }
  | { kind: "paper"; paper: PaperSummary }
  | { kind: "setting"; entry: SettingsSearchEntry };

/** The best `limit` of `items` that score at least `floor`, with their scores. */
function topScoring(items: readonly PaletteItem[], score: (item: PaletteItem) => number, limit: number, floor = 1) {
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score >= floor)
    .sort((left, right) => right.score - left.score || left.item.order - right.item.order)
    .slice(0, limit);
}

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Mount only while open, so each opening starts from an empty query. */
export function CommandPalette(props: {
  /** The commands to list: labelled, and runnable here. */
  commands: readonly AppCommand[];
  /** What an empty query leads with (`paletteLeading`): ids from `commands`, each under its group. */
  leading: readonly SearchPickerItem[];
  /** The project's files and Papers, found once something is typed; none on the welcome screen. */
  files: readonly string[];
  recentFiles: readonly string[];
  papers: readonly PaperSummary[];
  hasProject: boolean;
  knownAuthorName: string | null;
  onClose: () => void;
  onChoose: (choice: PaletteChoice) => void;
  onFileIntent?: (path: string) => void;
}) {
  const { t, i18n } = useLingui();
  // Only characters an id fragment takes as they are.
  const iconPrefix = `palette-icon${useId().replace(/[^\w-]/g, "")}`;
  const settings = useSettingsSearchIndex(props.hasProject, props.knownAuthorName);
  const { commands, leading, files, recentFiles, papers, onFileIntent } = props;
  const rank = useMemo(() => {
    const sectionLabel = (section: PaletteSection | undefined) => (section ? i18n._(PALETTE_SECTIONS[section].label) : undefined);
    // Within a section, commands keep the table's order (Back before
    // Forward, Build before Clean) in every language; files and the rest follow.
    const commandItems: PaletteItem[] = commands.map((command, index) => ({
      kind: "command",
      id: command.id,
      label: command.label ?? command.id,
      detail: command.detail,
      group: sectionLabel(command.group),
      icon: command.group ? rowIcon(iconPrefix, command.group) : undefined,
      keys: commandKeys(command) ?? undefined,
      keywords: command.keywords,
      order: (command.group ? PALETTE_SECTIONS[command.group].order : FOUND_ORDER.setting) + index / (commands.length + 1),
    }));
    const byId = new Map(commandItems.map((item) => [item.id, item]));
    const fileItem = (path: string, group: string): PaletteItem => ({
      kind: "file", path, id: `file:${path}`, label: nameOf(path), detail: folderOf(path) || undefined, group,
      icon: fileIcon(path, isProjectAssetFilePath(path) ? "asset" : "file"), order: FOUND_ORDER.file,
    });
    const filesGroup = t`Files`;
    const fileItems = files.map((path) => fileItem(path, filesGroup));
    const paperItems: PaletteItem[] = papers
      // A Paper that is only cited has nothing to open or fetch.
      .filter((paper) => paper.hasFullText || paper.hasBlog || paper.arxivId || paper.url)
      .map((paper) => ({
        kind: "paper", paper, id: `paper:${paper.arxivId || paper.url || paper.title}`, label: paper.title,
        detail: [paperShortAuthors(paper), paper.year].filter(Boolean).join(" · ") || undefined,
        keywords: [paper.citationKey, paper.arxivId, paper.authors].filter(Boolean).join(" "),
        group: t`Papers`, icon: rowIcon(iconPrefix, "paper"), order: FOUND_ORDER.paper,
      }));
    const settingItems: PaletteItem[] = settings.map((entry) => ({
      kind: "setting", entry, id: `setting:${settingsEntryKey(entry)}`, label: entry.label, detail: entry.place,
      keywords: [entry.terms, entry.description].filter(Boolean).join(" "),
      group: t`Settings`, icon: rowIcon(iconPrefix, "setting"), order: FOUND_ORDER.setting,
    }));
    const recentGroup = t`Recent files`;
    const leadingItems: PaletteItem[] = [
      ...leading.flatMap((lead) => {
        const command = byId.get(lead.id);
        return command ? [{ ...command, group: lead.group }] : [];
      }),
      ...recentFiles.slice(0, RECENT_FILES_SHOWN).map((path) => ({ ...fileItem(path, recentGroup), id: `recent:${path}` })),
    ];
    const leadIds = new Set(leading.map((lead) => lead.id));
    const everyCommand = commandItems
      .filter((item) => !leadIds.has(item.id))
      .sort((left, right) => left.order - right.order);
    return (query: string): PaletteItem[] => {
      if (!query) return [...leadingItems, ...everyCommand];
      return [
        ...topScoring(commandItems, (item) => scoreItem(item, query), LIMITS.command),
        ...topScoring(fileItems, (item) => (item.kind === "file" ? scorePath(item.path, query) : 0), LIMITS.file),
        ...topScoring(paperItems, (item) => scoreItem(item, query), LIMITS.paper, PROSE_FLOOR),
        ...topScoring(settingItems, (item) => scoreItem(item, query), LIMITS.setting, PROSE_FLOOR),
      ]
        .sort((left, right) => right.score - left.score || left.item.order - right.item.order)
        .map((entry) => entry.item);
    };
  }, [commands, files, i18n, iconPrefix, leading, papers, recentFiles, settings, t]);
  const intent = useMemo(() => (onFileIntent
    ? (item: PaletteItem) => { if (item.kind === "file") onFileIntent(item.path); }
    : undefined), [onFileIntent]);
  return (
    <PickerDialog<PaletteItem>
      label={t`Command palette`}
      searchLabel={t`Command palette`}
      placeholder={props.hasProject ? t`Search commands, files, papers and settings…` : t`Search commands and settings…`}
      closeLabel={t`Close command palette`}
      className="command-palette-modal"
      detailPlacement="end"
      emptyText={t`No matches`}
      rank={rank}
      itemKey={(item) => item.id}
      // A file's row shows its name and folder apart; its full path names it.
      itemLabel={(item) => (item.kind === "file" ? item.path : undefined)}
      groupOf={(item) => item.group}
      renderItem={searchPickerRow}
      onIntent={intent}
      onClose={props.onClose}
      onSelect={(item) => {
        if (item.kind === "command") props.onChoose({ kind: "command", id: item.id });
        else if (item.kind === "file") props.onChoose({ kind: "file", path: item.path });
        else if (item.kind === "paper") props.onChoose({ kind: "paper", paper: item.paper });
        else props.onChoose({ kind: "setting", entry: item.entry });
      }}
      footer={(
        <div className="command-palette-footer" aria-hidden="true">
          <IconSprite prefix={iconPrefix} />
          <span>{renderKeycaps([...comboKeys({ key: "ArrowUp" }), ...comboKeys({ key: "ArrowDown" })])}{t`Move`}</span>
          <span>{renderKeycaps(comboKeys({ key: "Enter" }))}{t`Open`}</span>
          <span>{renderKeycaps(comboKeys({ key: "Escape" }))}{t`Close`}</span>
        </div>
      )}
    />
  );
}
