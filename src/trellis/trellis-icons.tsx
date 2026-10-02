/**
 * Panel and document icons, shared by the workspace tabs, the titlebar's
 * Panels menu and the file pickers.
 */
import type { ReactNode } from "react";
import {
  BookMarked, BookOpen, Bot, ClipboardCheck, FileCode2, FileImage, FileText, FolderTree, GitBranch, History, Leaf, Library,
  ListTodo, MessageSquare, Presentation, Shapes, Table2,
} from "lucide-react";
import { isOpenSlideDeckPath } from "../app-utils";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import type { TrellisSingleton } from "./trellis-controller";

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
