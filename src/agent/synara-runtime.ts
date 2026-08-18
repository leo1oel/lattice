type SynaraRuntimeState = "starting" | "ready" | "stopped";

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
export const LATTICE_AGENT_COMPILE_RESULT = "lattice:agent-compile-result";

export interface AgentCompileResultMessage {
  type: typeof LATTICE_AGENT_COMPILE_RESULT;
  version: 1;
  threadId: string;
  turnId: string;
  checkpointRef: string;
  compiledAt: string;
  success: boolean;
  durationMs: number | null;
  rootDocument: string | null;
  diagnostics: { errors: number; warnings: number };
}

export function parseAgentCompileResultMessage(value: unknown): AgentCompileResultMessage | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const diagnostics = item.diagnostics as Record<string, unknown> | null;
  const rootDocument = typeof item.rootDocument === "string"
    ? item.rootDocument.replace(/\\/g, "/")
    : item.rootDocument;
  const allowedKeys = new Set(["type", "version", "threadId", "turnId", "checkpointRef", "compiledAt", "success", "durationMs", "rootDocument", "diagnostics"]);
  const allowedDiagnosticKeys = new Set(["errors", "warnings"]);
  if (Object.keys(item).some((key) => !allowedKeys.has(key))
    || item.type !== LATTICE_AGENT_COMPILE_RESULT || item.version !== 1
    || !boundedCorrelationId(item.threadId)
    || !boundedCorrelationId(item.turnId)
    || !boundedCorrelationId(item.checkpointRef)
    || !strictUtcTimestamp(item.compiledAt)
    || typeof item.success !== "boolean"
    || !(item.durationMs === null || (typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0))
    || !(rootDocument === null || projectRelativePath(rootDocument))
    || !diagnostics || Object.keys(diagnostics).some((key) => !allowedDiagnosticKeys.has(key))
    || !finiteNonNegativeInteger(diagnostics.errors)
    || !finiteNonNegativeInteger(diagnostics.warnings)) return null;
  return {
    type: LATTICE_AGENT_COMPILE_RESULT,
    version: 1,
    threadId: item.threadId as string,
    turnId: item.turnId as string,
    checkpointRef: item.checkpointRef as string,
    compiledAt: item.compiledAt as string,
    success: item.success as boolean,
    durationMs: item.durationMs as number | null,
    rootDocument: rootDocument as string | null,
    diagnostics: {
      errors: diagnostics.errors as number,
      warnings: diagnostics.warnings as number,
    },
  };
}

export type AgentGitWorkspaceView = "changes" | "pull-requests";

export function agentGitWorkspacePath(view: AgentGitWorkspaceView): string {
  return view === "pull-requests" ? "/pull-requests/" : "/source-control";
}

interface AgentCheckpointFileSummary {
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

function boundedCorrelationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(value);
}

function projectRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function strictUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function agentCheckpointFileSummary(value: unknown): value is AgentCheckpointFileSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return projectRelativePath(candidate.path)
    && typeof candidate.kind === "string"
    && finiteNonNegativeInteger(candidate.additions)
    && finiteNonNegativeInteger(candidate.deletions);
}

function agentCheckpointHistoryEntry(value: unknown): value is AgentCheckpointHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return boundedCorrelationId(candidate.id)
    && typeof candidate.label === "string"
    && strictUtcTimestamp(candidate.timestamp)
    && boundedCorrelationId(candidate.threadId)
    && typeof candidate.threadTitle === "string"
    && boundedCorrelationId(candidate.turnId)
    && finiteNonNegativeInteger(candidate.turnCount)
    && boundedCorrelationId(candidate.checkpointRef)
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
    || !boundedCorrelationId(candidate.activeThreadId)
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

const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

function decodeFileReference(value: string): string | null {
  if (!value.toLowerCase().startsWith("file:")) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * Convert a file reference from the embedded Agent into the project-relative
 * path accepted by Lattice's file commands. Synara normally sends a relative
 * path, but authored Markdown links can retain an absolute or encoded path.
 */
export function synaraProjectRelativeFilePath(
  filePath: unknown,
  projectRoot: string | null | undefined,
): string | null {
  if (typeof filePath !== "string" || !projectRoot?.trim()) return null;
  const decoded = decodeFileReference(filePath.trim());
  if (!decoded) return null;

  const target = decoded
    .replace(/\\/g, "/")
    .replace(FILE_POSITION_SUFFIX_PATTERN, "")
    .normalize("NFC");
  const root = projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC");
  if (!root || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)) return null;
  const absolute = target.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(target);
  const caseInsensitive = WINDOWS_ABSOLUTE_PATH_PATTERN.test(root);
  const comparisonTarget = caseInsensitive ? target.toLowerCase() : target;
  const comparisonRoot = caseInsensitive ? root.toLowerCase() : root;

  let relative = target.replace(/^\.\//, "");
  if (absolute) {
    const prefix = `${comparisonRoot}/`;
    if (!comparisonTarget.startsWith(prefix)) return null;
    relative = target.slice(root.length + 1);
  }
  if (
    !relative
    || relative.includes("\0")
    || relative.startsWith("/")
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(relative)
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return relative;
}

export function synaraFrameUrl(input: {
  origin: string;
  path?: string;
  workspaceRoot: string;
  theme: "light" | "dark";
  locale?: "en" | "zh-CN";
  surface?: "chrome" | "drawer";
  hostOrigin: string;
  authToken?: string | null;
  section?: string | null;
}): string {
  const url = new URL(input.path || "/", input.origin);
  url.searchParams.set("embed", "1");
  url.searchParams.set("workspaceRoot", input.workspaceRoot);
  url.searchParams.set("theme", input.theme);
  if (input.locale) url.searchParams.set("locale", input.locale);
  if (input.surface) url.searchParams.set("surface", input.surface);
  url.searchParams.set("hostOrigin", input.hostOrigin);
  if (input.section) url.searchParams.set("section", input.section);
  if (input.authToken) {
    url.hash = new URLSearchParams({ "lattice-auth": input.authToken }).toString();
  }
  return url.toString();
}
