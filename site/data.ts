import {
  FileText,
  PenLine,
  Layers,
  Library,
  Users,
  History,
  Sparkles,
  FolderOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface Feature {
  icon: LucideIcon;
  title: string;
  summary: string;
  detail: string;
}

export const FEATURES: Feature[] = [
  {
    icon: FileText,
    title: "LaTeX 编辑与编译",
    summary: "原生的 LaTeX 编辑器与编译器,源码与编译后的 PDF 并排显示。",
    detail:
      "为写论文的人打造的 macOS 原生 LaTeX 编辑器。左边写源码,右边实时看到编译后的 PDF,不用在编辑器和预览之间来回切换。",
  },
  {
    icon: PenLine,
    title: "类 Notion 的笔记",
    summary: "围绕 LaTeX 的 Markdown 编辑器,记录想法与草稿。",
    detail:
      "一个类似 Notion 的 Markdown 编辑器,让你在正式写作之前先把思路、提纲和阅读笔记理清楚,与项目里的其他内容放在一起。",
  },
  {
    icon: Layers,
    title: "可视化白板",
    summary: "在无限画布上梳理结构、画图和推导。",
    detail:
      "内置白板,可以自由地画图、拉思维导图、推公式。研究里那些没法用线性文字表达的部分,终于有地方安放。",
  },
  {
    icon: Library,
    title: "文献管理",
    summary: "导入、缓存论文,并直接插入引用。",
    detail:
      "把参考文献集中管理:导入并缓存论文,打开阅读,再用引用选择器把它们直接写进你的 .tex 稿件。",
  },
  {
    icon: Users,
    title: "实时协作",
    summary: "多人同时编辑同一份稿件,或直接接入 Overleaf。",
    detail:
      "支持实时协作——可以用 Lattice 自己的协作,也可以接入 Overleaf。多个光标同时编辑同一份 .tex,PDF 随之重新编译。",
  },
  {
    icon: History,
    title: "版本历史",
    summary: "完整的项目历史,随时回看每一次改动。",
    detail:
      "项目自带版本历史,能清晰地看到每一次改动的差异,放心地尝试、回退,不怕弄丢内容。",
  },
  {
    icon: Sparkles,
    title: "AI 研究助手",
    summary: "能看见你当前项目的 AI Agent。",
    detail:
      "内置的 AI 研究助手能读到你正在处理的项目内容,基于你的真实稿件、笔记和文献来回答问题、协助写作。",
  },
  {
    icon: FolderOpen,
    title: "本地优先 · 真实文件",
    summary: "一切都是你 Mac 上真实文件夹里的真实文件。",
    detail:
      "Lattice 不会把你的稿件变成私有格式,也不把工作从你的电脑上拿走。所有内容都是本地文件夹里的普通文件,随时可以用 Git 管理或用别的工具打开。",
  },
];
