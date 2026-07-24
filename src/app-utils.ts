/**
 * Pure, module-level utility helpers extracted from `App.tsx`.
 *
 * These are the small, stateless functions and shared constants the app leans
 * on for formatting, model/provider metadata, agent mentions, paper tab keys,
 * window drag handling, and drop-target hit testing. They carry no React state
 * and depend only on shared types plus the Tauri window API, so they can be
 * imported anywhere without pulling in the whole component.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { OrbState } from "./thinking-orbs";
import type { AutoBuildMode } from "./app-settings";
import type {
  PaperSummary,
  CiteCommand,
  ChatMessage,
  FileNode,
  AgentMention,
  MentionState,
  SettingsTab,
  AgentProvider,
  ModelOption,
  ReasoningEffort,
} from "./app-types";

/** What the second line of a paper row says: where it came from, and its state. */
export function paperSubtitle(paper: PaperSummary, snippet?: string): string {
  if (snippet) return snippet;
  const parts: string[] = [];
  // Just the key: the \cite{} wrapper is noise in a list that is entirely
  // citations, and it crowds out the arXiv id in a narrow panel.
  if (paper.citationKey) parts.push(paper.citationKey);
  if (paper.arxivId) parts.push(`arXiv ${paper.arxivId}`);
  if (!paper.hasFullText) {
    // Say why it cannot be opened, and whether that is fixable from here.
    parts.push(paper.arxivId ? "get full text" : "cited only");
  }
  return parts.join(" · ");
}

/** A cited-only work may have no arXiv id, so identity falls back to its key. */
export function paperKey(paper: PaperSummary): string {
  return paper.arxivId || `cite:${paper.citationKey ?? paper.title}`;
}

export const CITE_COMMANDS: CiteCommand[] = ["cite", "citep", "citet"];

export const PROJECT_FIGURE_DRAG_TYPE = "application/x-lattice-project-figure";

export const WELCOME_MESSAGE = "What would you like to work on?";

export function isConversationWelcome(message: ChatMessage, index: number): boolean {
  return index === 0 && message.role === "agent" && message.text.trim() === WELCOME_MESSAGE;
}

/**
 * Map the agent's current status line to a thinking-orb animation, so the
 * orb reflects what the agent is actually doing (reading, editing, running a
 * command, …) rather than one generic spinner. Driven entirely by the status
 * string the backend already emits, so it needs no extra event plumbing.
 * Order matters: a path like "Editing search-panel.ts…" must read as editing,
 * not searching, so the write/edit test runs before the read/search one.
 */
export function statusToOrbState(status: string): OrbState {
  const s = status.toLowerCase();
  if (/edit|writ|compos/.test(s)) return "composing";
  if (/compress/.test(s)) return "shaping";
  if (/run|command|bash|compil|retry/.test(s)) return "solving";
  if (/read|search|find|review|discover|literatur|fetch|grep|look/.test(s)) return "searching";
  return "working";
}

export function buildAgentMentions(files: FileNode[], papers: PaperSummary[]): AgentMention[] {
  const mentions: AgentMention[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind === "directory") visit(node.children);
      else mentions.push({ key: `file:${node.path}`, label: node.name, path: node.path, kind: "file" });
    }
  };
  visit(files);
  for (const paper of papers) {
    mentions.push({
      key: `paper:${paper.arxivId}`,
      label: paper.title,
      // Point at the paper's folder, not just paper.md: the agent then sees the
      // full text, the generated blog, and the metadata together — which is what
      // "reference this paper" means to the writer.
      path: `.research/papers/${paper.arxivId}/`,
      kind: "paper",
    });
  }
  return mentions;
}

export function mentionAtCaret(value: string, caret: number): MentionState | null {
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0 || /\s/.test(beforeCaret.slice(at + 1))) return null;
  if (at > 0 && !/\s|[([{"'`]/.test(beforeCaret[at - 1])) return null;
  return { start: at, end: caret, query: beforeCaret.slice(at + 1) };
}

// Papers ride in the same `openTabs` string[] as files. A paper's tab key is
// its full-text path — unambiguous, since only papers live under this prefix.
export const PAPER_TAB_PREFIX = ".research/papers/";
export const PAPER_TAB_SUFFIX = "/paper.md";
export function isPaperTabKey(key: string): boolean {
  return key.startsWith(PAPER_TAB_PREFIX) && key.endsWith(PAPER_TAB_SUFFIX);
}
export function paperTabKey(arxivId: string): string {
  return `${PAPER_TAB_PREFIX}${arxivId}${PAPER_TAB_SUFFIX}`;
}
export function arxivIdFromTabKey(key: string): string {
  return key.slice(PAPER_TAB_PREFIX.length, key.length - PAPER_TAB_SUFFIX.length);
}

/**
 * Full text imported with `arxiv2md --frontmatter` leads with a YAML block; the
 * reader shows the title from metadata, so drop the raw YAML rather than render
 * it as a stray `<hr>` + text. A no-op for older papers without frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after === -1 ? "" : markdown.slice(after + 1).replace(/^\s+/, "");
}

let windowDragTimer: ReturnType<typeof setTimeout> | null = null;

export function beginWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.buttons !== 1 || event.detail > 1 || (event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  if (windowDragTimer) clearTimeout(windowDragTimer);
  // Delay drag so a second click can still register as double-click → fullscreen.
  windowDragTimer = setTimeout(() => {
    windowDragTimer = null;
    void getCurrentWindow().startDragging();
  }, 180);
}

export function toggleWindowFullscreen(event: React.MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  if (windowDragTimer) {
    clearTimeout(windowDragTimer);
    windowDragTimer = null;
  }
  const appWindow = getCurrentWindow();
  if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.setFullscreen !== "function") return;
  void appWindow.isFullscreen()
    .then((value) => appWindow.setFullscreen(!value))
    .catch(() => undefined);
}

export function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function agentErrorDetails(message: string): { text: string; settingsTab: SettingsTab | null } {
  const routes: Array<[prefix: string, tab: SettingsTab]> = [
    ["LATTICE_AUTH_SUBSCRIPTION:", "accounts"],
    ["LATTICE_AUTH_API_KEY:", "api"],
  ];
  const route = routes.find(([prefix]) => message.startsWith(prefix));
  if (!route) return { text: message, settingsTab: null };
  return { text: message.slice(route[0].length).trim(), settingsTab: route[1] };
}

export function modelOptions(provider: AgentProvider): ModelOption[] {
  const standard = ["low", "medium", "high", "xhigh"] as ReasoningEffort[];
  const frontier = [...standard, "max"] as ReasoningEffort[];
  switch (provider) {
    case "codex":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: frontier },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "openai-api":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", ...frontier] },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "claude":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
    case "anthropic-api":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
  }
}

export function defaultModel(provider: AgentProvider): string {
  return modelOptions(provider)[0].value;
}

export function normalizeModel(provider: AgentProvider, model: string | undefined): string {
  if (provider === "claude") {
    if (model === "sonnet") return "claude-sonnet-5";
    if (model === "opus") return "claude-opus-4-8";
    if (model === "fable" || model === "claude-fable-5") return "claude-sonnet-5";
  }
  return modelOptions(provider).some((option) => option.value === model) ? model as string : defaultModel(provider);
}

export function modelLabel(provider: AgentProvider, model: string): string {
  return modelOptions(provider).find((option) => option.value === model)?.label ?? model;
}

export function normalizeEffort(value: string | undefined): ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : "high";
}

export function compactConversationTitle(title: string): string {
  return title === "New conversation" ? "New" : title;
}

export function autoBuildTitle(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Build automatically";
  return "Build only when requested";
}

export function autoBuildDetail(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Lattice saves and builds when you leave the editor or after 1.2 seconds without typing.";
  return "Use the Build button or Command-S. Source changes are still saved automatically.";
}

export function autoBuildDescription(mode: AutoBuildMode): string {
  return `${autoBuildTitle(mode)} · Command-S builds now`;
}

export function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function projectItemPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

export function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const directory = element?.closest<HTMLElement>("[data-drop-directory]")?.dataset.dropDirectory;
  if (directory) return directory;
  return element?.closest(".navigator") ? "figures" : null;
}

export function dropEditorAt(position: { x: number; y: number }): { x: number; y: number } | null {
  const scale = window.devicePixelRatio || 1;
  const point = { x: position.x / scale, y: position.y / scale };
  return document.elementFromPoint(point.x, point.y)?.closest(".source-editor") ? point : null;
}
