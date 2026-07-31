export type SynaraRuntimeState = "starting" | "ready" | "stopped";

export interface SynaraRuntimeInfo {
  state: SynaraRuntimeState;
  origin: string | null;
  authToken: string | null;
  message: string | null;
  startupMs: number | null;
  version: string | null;
  revision: string | null;
}

export const EMPTY_SYNARA_RUNTIME: SynaraRuntimeInfo = {
  state: "starting",
  origin: null,
  authToken: null,
  message: null,
  startupMs: null,
  version: null,
  revision: null,
};

export const LATTICE_PROJECT_HISTORY = "lattice:project-history";
export const LATTICE_RESTORE_AGENT_CHECKPOINT = "lattice:restore-agent-checkpoint";

export type AgentGitWorkspaceView = "changes" | "pull-requests";

export function agentGitWorkspacePath(view: AgentGitWorkspaceView): string {
  return view === "pull-requests" ? "/pull-requests/" : "/source-control";
}

export interface AgentCheckpointFileSummary {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

export interface AgentCheckpointHistoryEntry {
  id: string;
  label: string;
  timestamp: string;
  threadId: string;
  threadTitle: string;
  turnId: string;
  turnCount: number;
  checkpointRef: string;
  files: AgentCheckpointFileSummary[];
}

export interface AgentProjectHistorySnapshot {
  type: typeof LATTICE_PROJECT_HISTORY;
  activeThreadId: string;
  entries: AgentCheckpointHistoryEntry[];
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function agentCheckpointFileSummary(value: unknown): value is AgentCheckpointFileSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === "string"
    && candidate.path.length > 0
    && typeof candidate.kind === "string"
    && finiteNonNegativeInteger(candidate.additions)
    && finiteNonNegativeInteger(candidate.deletions);
}

function agentCheckpointHistoryEntry(value: unknown): value is AgentCheckpointHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.label === "string"
    && typeof candidate.timestamp === "string"
    && typeof candidate.threadId === "string"
    && typeof candidate.threadTitle === "string"
    && typeof candidate.turnId === "string"
    && finiteNonNegativeInteger(candidate.turnCount)
    && typeof candidate.checkpointRef === "string"
    && Array.isArray(candidate.files)
    && candidate.files.every(agentCheckpointFileSummary);
}

export function parseAgentProjectHistorySnapshot(
  value: unknown,
): AgentProjectHistorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== LATTICE_PROJECT_HISTORY
    || typeof candidate.activeThreadId !== "string"
    || !Array.isArray(candidate.entries)
    || !candidate.entries.every(agentCheckpointHistoryEntry)
  ) {
    return null;
  }
  return candidate as unknown as AgentProjectHistorySnapshot;
}

export function normalizeSynaraOrigin(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function synaraFrameUrl(input: {
  origin: string;
  path?: string;
  workspaceRoot: string;
  theme: "light" | "dark";
  surface?: "chrome" | "drawer";
  hostOrigin: string;
  authToken?: string | null;
  section?: string | null;
}): string {
  const url = new URL(input.path || "/", input.origin);
  url.searchParams.set("embed", "1");
  url.searchParams.set("workspaceRoot", input.workspaceRoot);
  url.searchParams.set("theme", input.theme);
  if (input.surface) url.searchParams.set("surface", input.surface);
  url.searchParams.set("hostOrigin", input.hostOrigin);
  if (input.section) url.searchParams.set("section", input.section);
  if (input.authToken) {
    url.hash = new URLSearchParams({ "lattice-auth": input.authToken }).toString();
  }
  return url.toString();
}
