/** Panel icons, shared by the workspace tabs and the titlebar's Panels menu. */
import type { ReactNode } from "react";
import {
  BookOpen, Bot, ClipboardCheck, FileText, FolderTree, GitBranch, History, Leaf, Library, ListTodo, MessageSquare,
} from "lucide-react";
import type { TrellisSingleton } from "./trellis-controller";

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
