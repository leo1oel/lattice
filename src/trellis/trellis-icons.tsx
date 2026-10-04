/**
 * Panel and document icons, shared by the workspace tabs, the titlebar's
 * Panels menu and the file pickers.
 */
import type { ReactNode } from "react";
import {
  ArrowRightLeft, BookMarked, BookOpen, BookPlus, Bot, ClipboardCheck, Columns2, Crosshair, EyeOff, FileCode2, FileImage,
  FileText, FolderPlus, FolderTree, GitBranch, Hammer, History, Leaf, Library, ListChecks, ListTodo, Maximize2, MessageSquare,
  Minimize2, PenLine, PictureInPicture2, Presentation, RefreshCw, Rows2, Search, Settings2, Shapes, Sparkles, Square, Table2,
  X, XCircle,
} from "lucide-react";
import { isOpenSlideDeckPath } from "../app-utils";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import type { TrellisSingleton } from "./trellis-controller";
import type { LayoutPreset } from "./trellis-layout";

/** The layout presets, in the titlebar's layout switch and its Panels menu. */
export const PRESETS = [
  { value: "writing", icon: PenLine },
  { value: "reading", icon: BookOpen },
] as const satisfies ReadonlyArray<{ value: LayoutPreset; icon: unknown }>;

/** A document's icon, by what opens it: a paper, an asset, or a file by extension. */
export function fileIcon(key: string, kind: "file" | "asset" | "paper", size = 14) {
  if (kind === "paper") return <BookMarked size={size} />;
  if (kind === "asset") return <FileImage size={size} />;
  const lower = key.toLocaleLowerCase();
  if (lower.endsWith(".tldr")) return <Shapes size={size} />;
  if (isSpreadsheetPath(key)) return <Table2 size={size} />;
  if (isOpenSlideDeckPath(key)) return <Presentation size={size} />;
  if (/\.(?:tex|sty|cls|bib)$/.test(lower)) return <FileCode2 size={size} />;
  return <FileText size={size} />;
}

export const PANEL_ICONS: Record<TrellisSingleton, ReactNode> = {
  project: <FolderTree size={14} />,
  papers: <Library size={14} />,
  agent: <Bot size={14} />,
  pdf: <FileText size={14} />,
  history: <History size={14} />,
  git: <GitBranch size={14} />,
  comments: <MessageSquare size={14} />,
  overleaf: <Leaf size={14} />,
  literature: <BookOpen size={14} />,
  todos: <ListTodo size={14} />,
  checklist: <ClipboardCheck size={14} />,
};

/**
 * Icons for panel menu items, by item id: Trellis's built-in items and the
 * ones Lattice adds. An id without one keeps a bare label.
 */
export const MENU_ICONS: Partial<Record<string, ReactNode>> = {
  maximize: <Maximize2 />,
  dock: <Minimize2 />,
  float: <PictureInPicture2 />,
  move: <ArrowRightLeft />,
  "split-right": <Columns2 />,
  "split-below": <Rows2 />,
  hide: <EyeOff />,
  close: <X />,
  "close-others": <XCircle />,
  build: <Hammer />,
  "clean-build": <RefreshCw />,
  "stop-build": <Square />,
  reveal: <Crosshair />,
  "new-latex": <FileCode2 />,
  "new-markdown": <FileText />,
  "new-folder": <FolderPlus />,
  "new-spreadsheet": <Table2 />,
  "new-board": <Shapes />,
  "new-presentation": <Presentation />,
  find: <Search />,
  discover: <Sparkles />,
  "bib-entry": <BookPlus />,
  "check-references": <ListChecks />,
  "agent-settings": <Settings2 />,
};
